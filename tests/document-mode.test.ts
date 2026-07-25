/**
 * Document mode.
 *
 * Screen ownership and scroll strategy are independent axes, and conflating them
 * is easy:
 *
 * - `requestFullscreen()` is about *screen ownership* -- "I take over the whole
 *   terminal". The alternate buffer is one way to implement that, and an
 *   implementation detail.
 * - Document mode is about *who moves the camera*. It has nothing to do with
 *   occupying the whole screen.
 *
 * So document mode still starts at the command height, and when it needs more
 * rows than are left below it, it *scrolls* the earlier output away into the
 * scrollback -- where it survives and the user can still reach it -- rather than
 * painting over it. Overwriting the output of whatever ran before us would
 * destroy it. Scrolling it away is what an ordinary command does.
 *
 * Nothing of ours is committed in document mode, so nothing is frozen: the
 * document stays a single mutable thing that we repaint a window of.
 */
import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";

interface Screen {
	scrollback: string[];
	viewport: string[];
}

function read(terminal: MockProcess, rows: number): Screen {
	const buffer = (terminal as any).terminal.buffer.active;
	const line = (index: number): string =>
		buffer.getLine(index)?.translateToString(true) ?? "";

	return {
		scrollback: Array.from({length: buffer.baseY}, (_, i) => line(i)).filter(
			Boolean,
		),
		viewport: Array.from({length: rows}, (_, i) =>
			line(buffer.baseY + i),
		).filter(Boolean),
	};
}

/** A terminal with four rows of output already on it, from a previous command. */
async function withPriorOutput(rows = 10) {
	const terminal = new MockProcess({rows, cols: 30});
	terminal.stdout.write("PREV-1\r\nPREV-2\r\nPREV-3\r\nPREV-4\r\n");

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	return {terminal, dom};
}

test("document mode scrolls prior output away rather than painting over it", async () => {
	const {terminal, dom} = await withPriorOutput();

	// The command started below the previous command's output.
	expect(dom.window.screenTop).toBe(4);

	dom.setViewportMode("document");
	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await dom.render();

	const screen = read(terminal, 10);

	// The previous command's output survived: pushed into the scrollback, where
	// the user can still scroll back to it. It was not overwritten.
	expect(screen.scrollback).toEqual(["PREV-1", "PREV-2", "PREV-3", "PREV-4"]);

	// And our window occupies the screen.
	expect(screen.viewport[0]).toBe("doc 1");
	expect(screen.viewport[9]).toBe("doc 10");

	dom.dispose();
});

test("the camera moves over the document without committing anything", async () => {
	const {terminal, dom} = await withPriorOutput();
	dom.setViewportMode("document");
	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await dom.render();

	dom.scrollDocumentBy(10);
	await dom.render();

	const screen = read(terminal, 10);

	expect(screen.viewport[0]).toBe("doc 11");
	expect(screen.viewport[9]).toBe("doc 20");

	// Nothing of *ours* went into the scrollback: only the earlier command's
	// output is there. In document mode the document is never committed, so it
	// never freezes.
	expect(screen.scrollback).toEqual(["PREV-1", "PREV-2", "PREV-3", "PREV-4"]);

	dom.dispose();
});

test("the camera cannot run off the end of the document", async () => {
	const {terminal, dom} = await withPriorOutput();
	dom.setViewportMode("document");
	dom.document.body.innerHTML = Array.from(
		{length: 15},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await dom.render();

	dom.scrollDocumentBy(1000);
	await dom.render();

	// 15 rows of document, 10 rows of screen: the furthest it can go is row 5,
	// which puts the last row of the document at the bottom of the screen.
	const screen = read(terminal, 10);
	expect(screen.viewport[9]).toBe("doc 15");

	dom.dispose();
});

test("content above the camera stays mutable, unlike flow mode", async () => {
	// This is the point of document mode. Nothing is committed, so nothing is
	// frozen: an element that has scrolled out of view can still be changed, and
	// scrolling back to it shows the change.
	const {terminal, dom} = await withPriorOutput();
	dom.setViewportMode("document");
	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div id="d${i + 1}">doc ${i + 1}</div>`,
	).join("");
	await dom.render();

	dom.scrollDocumentBy(15);
	await dom.render();

	// Change a row that is now far above the camera -- in flow mode this row
	// would be frozen in the scrollback and the change would be unrepresentable.
	dom.document.getElementById("d2")!.textContent = "CHANGED-WAY-UP";
	await dom.render();

	// Scroll back to it.
	dom.scrollDocumentBy(-15);
	await dom.render();

	const screen = read(terminal, 10);
	expect(screen.viewport[1]).toBe("CHANGED-WAY-UP");

	dom.dispose();
});

test("a render arriving mid-frame is coalesced, not dropped", async () => {
	// An animation drives renders through a mutation observer, which can fire again
	// before the previous frame has finished writing. Dropping that second call
	// (the old re-entrancy guard) leaves the diff renderer's previous-buffer out of
	// step with the screen -- rows drawn at the wrong place -- and strands the
	// latest state unrendered. The guard now defers instead: it runs a trailing
	// frame that folds in whatever mutated in the meantime.
	const terminal = new MockProcess({rows: 20, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.setViewportMode("document");
	dom.document.body.innerHTML =
		`<div id="dyn">frame 0</div>` +
		Array.from({length: 8}, (_, i) => `<div>static ${i + 1}</div>`).join("");
	await dom.render();

	// Two renders where the second starts while the first is still in flight.
	dom.document.getElementById("dyn")!.textContent = "frame 1";
	const first = dom.render();
	dom.document.getElementById("dyn")!.textContent = "frame 2";
	const second = dom.render();
	await Promise.all([first, second]);

	const screen = read(terminal, 20);

	// The latest state won -- the dropped-render bug would leave "frame 1".
	expect(screen.viewport[0]).toBe("frame 2");

	// And the static rows below are intact, not shifted or duplicated.
	for (let i = 0; i < 8; i++) {
		expect(screen.viewport[i + 1]).toBe(`static ${i + 1}`);
	}

	dom.dispose();
});
