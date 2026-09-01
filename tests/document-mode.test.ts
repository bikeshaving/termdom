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
import {expect, test} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

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
async function withPriorOutput(rows = 10): Promise<
	{terminal: MockProcess; dom: TermDOM}
> {
	const terminal = new MockProcess({rows, cols: 30});
	terminal.stdout.write("PREV-1\r\nPREV-2\r\nPREV-3\r\nPREV-4\r\n");

	const dom = new TermDOM({transport: terminal.sharedTransport});
	await nextFrame(dom);

	return {terminal, dom};
}

test("document mode scrolls prior output away rather than painting over it", async () => {
	const {terminal, dom} = await withPriorOutput();

	// The command started below the previous command's output.
	expect(dom.window.screenTop).toBe(4);

	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await nextFrame(dom);

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
	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await nextFrame(dom);

	dom.window.scrollBy(0, 10);
	await nextFrame(dom);

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
	dom.document.body.innerHTML = Array.from(
		{length: 15},
		(_, i) => `<div>doc ${i + 1}</div>`,
	).join("");
	await nextFrame(dom);

	dom.window.scrollBy(0, 1000);
	await nextFrame(dom);

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
	dom.document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div id="d${i + 1}">doc ${i + 1}</div>`,
	).join("");
	await nextFrame(dom);

	dom.window.scrollBy(0, 15);
	await nextFrame(dom);

	// Change a row that is now far above the camera -- in flow mode this row
	// would be frozen in the scrollback and the change would be unrepresentable.
	dom.document.getElementById("d2")!.textContent = "CHANGED-WAY-UP";
	await nextFrame(dom);

	// Scroll back to it.
	dom.window.scrollBy(0, -15);
	await nextFrame(dom);

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

	// Construction kicks off auto-detection; its promise is pending right now.
	// We do NOT await it -- the render must, which is the fix. The shared
	// transport is what puts detection on the path at all.
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML = "<div id=\"a\">A-0</div><div id=\"b\">B</div>";
	await nextFrame(dom);

	// A second frame, well after detection has resolved.
	dom.document.getElementById("a")!.textContent = "A-1";
	await nextFrame(dom);

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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML =
		"<div id=\"dyn\">frame 0</div>" +
		Array.from({length: 8}, (_, i) => `<div>static ${i + 1}</div>`).join("");
	await nextFrame(dom);

	// Two updates back to back: the second lands while the first frame is still
	// being coalesced. The latest state must win, with nothing dropped or shifted.
	dom.document.getElementById("dyn")!.textContent = "frame 1";
	dom.document.getElementById("dyn")!.textContent = "frame 2";
	await nextFrame(dom);

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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML =
		"<div style=\"position:relative\">top row" +
		"<div style=\"position:absolute;top:45ch;left:0\">ABS-DEEP</div></div>" +
		Array.from({length: 58}, (_, i) => `<div>row ${i + 1}</div>`).join("");
	await nextFrame(dom);

	dom.window.scrollBy(0, 42);
	await nextFrame(dom);

	const screen = read(terminal, 10);
	// The absolute child paints at document row 45 -- visible row 3 with the
	// camera at 42 -- even though its parent's own box is far above the band.
	expect(screen.viewport[3]).toContain("EP");

	// And scrolling back re-reveals the culled top correctly.
	dom.window.scrollBy(0, -42);
	await nextFrame(dom);
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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML = Array.from(
		{length: 15},
		(_, i) => `<div>R${String(i).padStart(2, "0")}</div>`,
	).join("");
	await nextFrame(dom);

	// Grow so the region needs the prompt's two rows; new row r equals what the
	// old, wrongly-shifted model would predict at r -- the trap for the diff.
	dom.document.body.innerHTML = Array.from(
		{length: 22},
		(_, i) => `<div>R${String(i + 2).padStart(2, "0")}</div>`,
	).join("");
	await nextFrame(dom);

	const screen = read(terminal, 20);
	expect(screen.viewport[0]).toBe("R02");
	expect(screen.viewport[1]).toBe("R03");
	expect(screen.viewport[19]).toBe("R21");

	dom.dispose();
});

test("close() seals the document into scrollback; a later mutation starts a fresh block below", async () => {
	const {terminal, dom} = await withPriorOutput();
	dom.document.body.innerHTML = "<div>first block</div>";
	await nextFrame(dom);

	// close() flushes the live region to scrollback and freezes it -- res.end().
	dom.document.close();

	// A new mutation is a fresh document, rendered below the sealed block.
	dom.document.body.innerHTML = "<div>second block</div>";
	await nextFrame(dom);

	// The prior command's output, the sealed block, and the new block all survive;
	// nothing was overwritten.
	const screen = read(terminal, 10);
	const all = [...screen.scrollback, ...screen.viewport];
	expect(all).toContain("PREV-1");
	expect(all).toContain("first block");
	expect(all).toContain("second block");

	dom.dispose();
});

test("the seal pays out the rows the region painted, not body's own box", async () => {
	// An inline body is a run member: its block children are hoisted out and
	// laid out beside it, so its own box measures one line however many rows
	// they paint. Sizing the payout from it wrote a different document than
	// the screen had shown.
	const terminal = new MockProcess({rows: 10, cols: 40});
	terminal.stdout.write("PRE-0\r\nPRE-1\r\nPRE-2\r\nPRE-3\r\nPRE-4\r\n");
	const dom = new TermDOM({transport: terminal.sharedTransport});
	const style = dom.document.createElement("style");
	style.textContent = ".pane { height: 4em; overflow-y: scroll; }";
	dom.document.head.appendChild(style);
	dom.document.body.innerHTML =
		"<div>HEAD</div>" +
		"<div id=\"pane\" class=\"pane\">" +
		Array.from({length: 20}, (_, i) => `<div>row ${i}</div>`).join("") +
		"</div>" +
		"<div>FOOT</div>";
	await nextFrame(dom);
	dom.document.body.setAttribute("style", "display: inline");
	await nextFrame(dom);
	(dom.document.getElementById("pane") as any).scrollTop = 1;
	await nextFrame(dom);

	const ours = (rows: string[]): string[] =>
		rows.filter((row) => row !== "" && !row.startsWith("PRE-"));
	const before = read(terminal, 10);
	expect(ours([...before.scrollback, ...before.viewport])).toEqual([
		"HEAD",
		"row 1",
		"row 2",
		"row 3",
		"row 4",
		"FOOT",
	]);

	dom.document.close();
	await nextFrame(dom);

	// What the screen showed survives the one write that commits.
	const after = read(terminal, 10);
	expect(ours([...after.scrollback, ...after.viewport]).slice(0, 6)).toEqual(
		ours([...before.scrollback, ...before.viewport]),
	);

	dom.dispose();
});

test("[Symbol.dispose] tears down, so `using` works", () => {
	const terminal = new MockProcess({rows: 10, cols: 30});
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML = "<div>hi</div>";

	// The explicit-resource-management hook delegates to dispose().
	dom[Symbol.dispose]();

	// Idempotent with an explicit dispose(); tearing down twice is safe.
	expect(() => dom.dispose()).not.toThrow();
});

test(":fullscreen matches the element the stack holds", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"stage\">x</div>";
	await nextFrame(dom);

	const stage = dom.document.getElementById("stage")!;
	expect(stage.matches(":fullscreen")).toBe(false);

	await stage.requestFullscreen();
	expect(stage.matches(":fullscreen")).toBe(true);
	expect(dom.document.body.matches(":fullscreen")).toBe(false);

	await dom.document.exitFullscreen();
	expect(stage.matches(":fullscreen")).toBe(false);
	dom.dispose();
});

test("a fullscreen transition reaches a document listener once", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"stage\">x</div>";
	await nextFrame(dom);

	// The event fires at the element and bubbles, so a document listener hears
	// it through the bubble. Firing at the document as well would deliver every
	// transition twice, which is the shape this pins.
	const onDocument: string[] = [];
	const onElement: string[] = [];
	dom.document.addEventListener("fullscreenchange", () => {
		onDocument.push("change");
	});
	const stage = dom.document.getElementById("stage")!;
	stage.addEventListener("fullscreenchange", () => {
		onElement.push("change");
	});

	await stage.requestFullscreen();
	expect(onElement).toEqual(["change"]);
	expect(onDocument).toEqual(["change"]);

	await dom.document.exitFullscreen();
	expect(onElement).toEqual(["change", "change"]);
	expect(onDocument).toEqual(["change", "change"]);

	dom.dispose();
});
