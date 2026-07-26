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
import {TermDOM} from "../src/internal/termdom.js";
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

test("document mode waits for cursor detection so the anchor never shifts", async () => {
	// The region starts at the command-start row, which cursor detection resolves
	// asynchronously. If the first frame renders before detection lands it anchors
	// at row 0, then detection moves the anchor down and every later frame renders
	// one row lower -- content drawn once (labels) stays put while content rewritten
	// each frame (values) slides away from it. The fix waits for the anchor first.
	const terminal = new MockProcess({rows: 10, cols: 30});
	// Let the prior output land before construction, so the cursor -- and thus the
	// detection about to run -- sees the command starting at row 2.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-1\r\nPREV-2\r\n", () => resolve());
	});

	// Construction kicks off auto-detection; its promise is pending right now. We do
	// NOT await it -- the render must, which is the fix. (detectCursor defaults off
	// for a non-real process, so enable it to exercise the path.)
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.setViewportMode("document");
	dom.document.body.innerHTML = `<div id="a">A-0</div><div id="b">B</div>`;
	await dom.render();

	// A second frame, well after detection has resolved.
	dom.document.getElementById("a")!.textContent = "A-1";
	await dom.render();

	const screen = read(terminal, 10);

	// Prior output is untouched and the anchor settled at row 2.
	expect(screen.scrollback).toEqual([]);
	expect(dom.window.screenTop).toBe(2);

	// Both frames anchored at row 2: the updated value sits on the command-start
	// row, with nothing orphaned at row 0 from a pre-detection first frame.
	expect(screen.viewport[0]).toBe("PREV-1");
	expect(screen.viewport[1]).toBe("PREV-2");
	expect(screen.viewport[2]).toBe("A-1");
	expect(screen.viewport[3]).toBe("B");

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

test("culling never drops an absolute child positioned far from its parent", async () => {
	// Paint is culled by subtree extent, not by the element's own box: an
	// absolutely positioned child can sit far outside its parent. The extent is
	// the union of the box with every descendant's, so the parent survives
	// culling and the deep child paints when the camera reaches it.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.setViewportMode("document");
	dom.document.body.innerHTML =
		`<div style="position:relative">top row` +
		`<div style="position:absolute;top:45ch;left:0">ABS-DEEP</div></div>` +
		Array.from({length: 58}, (_, i) => `<div>row ${i + 1}</div>`).join("");
	await dom.render();

	dom.scrollDocumentBy(42);
	await dom.render();

	const screen = read(terminal, 10);
	// The absolute child paints at document row 45 -- visible row 3 with the
	// camera at 42 -- even though its parent's own box is far above the band.
	expect(screen.viewport[3]).toContain("EP");

	// And scrolling back re-reveals the culled top correctly.
	dom.scrollDocumentBy(-42);
	await dom.render();
	expect(read(terminal, 10).viewport[0]).toBe("top row");

	dom.dispose();
});

test("growing past the prompt keeps the diff aligned with the screen", async () => {
	// When a document-mode region grows and reserveRows scrolls the prompt away,
	// the region top moves up by exactly the scrolled amount -- so the previous
	// buffer's rows, which are relative to the top, refer to the same content as
	// before. Shifting them (flow-mode commitScroll semantics) desynced the diff
	// by that amount: it compared against the wrong screen rows and composited
	// the old frame under the new one. The adversarial case: new content whose
	// rows equal the shifted model's rows, so a desynced diff paints nothing.
	const terminal = new MockProcess({rows: 20, cols: 30});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-1\r\nPREV-2\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.setViewportMode("document");
	dom.document.body.innerHTML = Array.from(
		{length: 15},
		(_, i) => `<div>R${String(i).padStart(2, "0")}</div>`,
	).join("");
	await dom.render();

	// Grow so the region needs the prompt's two rows; new row r equals what the
	// old, wrongly-shifted model would predict at r -- the trap for the diff.
	dom.document.body.innerHTML = Array.from(
		{length: 22},
		(_, i) => `<div>R${String(i + 2).padStart(2, "0")}</div>`,
	).join("");
	await dom.render();

	const screen = read(terminal, 20);
	expect(screen.viewport[0]).toBe("R02");
	expect(screen.viewport[1]).toBe("R03");
	expect(screen.viewport[19]).toBe("R21");

	dom.dispose();
});
