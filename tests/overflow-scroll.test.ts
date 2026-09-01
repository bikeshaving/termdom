/**
 * Element scrollers: a box with overflow auto or scroll clips to its own
 * rows and moves its content by its scrollTop/scrollLeft -- whole cells,
 * clamped to the content's laid-out extent -- with the wheel, hit-testing
 * and scrollIntoView all reading the same offsets.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function makeScrollerApp(options?: {
	boxHeight?: number;
	lines?: number;
	rows?: number;
}): {
	terminal: MockProcess;
	dom: TermDOM;
	box: HTMLElement;
} {
	const {boxHeight = 3, lines = 8, rows = 10} = options ?? {};
	const terminal = new MockProcess({cols: 20, rows});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const box = document.createElement("div");
	box.id = "box";
	box.style.height = `${boxHeight}px`;
	box.style.overflow = "auto";
	for (let i = 0; i < lines; i++) {
		const line = document.createElement("div");
		line.id = `line-${i}`;
		line.textContent = `row ${i}`;
		box.appendChild(line);
	}
	document.body.appendChild(box);
	return {terminal, dom, box: box as HTMLElement};
}

/** Feed terminal input (a mouse report) and let the transport deliver it. */
function send(terminal: MockProcess, data: string): Promise<void> {
	terminal.stdin.simulateResponse(data);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("scrollHeight reports the content's extent, clientHeight the box", async () => {
	const {dom, box} = makeScrollerApp();
	await nextFrame(dom);
	expect(box.clientHeight).toBe(3);
	expect(box.scrollHeight).toBe(8);
	dom.dispose();
});

test("a box whose content fits reports its client size as the extent", async () => {
	const {dom, box} = makeScrollerApp({boxHeight: 8, lines: 4});
	await nextFrame(dom);
	expect(box.clientHeight).toBe(8);
	expect(box.scrollHeight).toBe(8);
	dom.dispose();
});

test("scrollWidth reports child boxes wider than the scroller", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const box = dom.document.createElement("div");
	box.style.width = "6ch";
	box.style.overflow = "auto";
	const wide = dom.document.createElement("div");
	wide.style.width = "15ch";
	wide.style.height = "1px";
	box.appendChild(wide);
	dom.document.body.appendChild(box);
	await nextFrame(dom);
	expect(box.clientWidth).toBe(6);
	expect(box.scrollWidth).toBe(15);
	dom.dispose();
});

test("scrollTop writes round to whole rows and clamp to the extent", async () => {
	const {dom, box} = makeScrollerApp();
	await nextFrame(dom);

	box.scrollTop = 2.6;
	expect(box.scrollTop).toBe(3);

	box.scrollTop = -4;
	expect(box.scrollTop).toBe(0);

	// 8 rows of content in a 3-row box: 5 rows of room.
	box.scrollTop = 99;
	expect(box.scrollTop).toBe(5);
	dom.dispose();
});

test("scrollTop pins to 0 on a box whose overflow is visible", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const box = dom.document.createElement("div");
	box.style.height = "2px";
	for (let i = 0; i < 5; i++) {
		const line = dom.document.createElement("div");
		line.textContent = `row ${i}`;
		box.appendChild(line);
	}
	dom.document.body.appendChild(box);
	await nextFrame(dom);
	box.scrollTop = 2;
	expect(box.scrollTop).toBe(0);
	dom.dispose();
});

test("a mutation that shrinks the content pulls the offset back", async () => {
	const {dom, box} = makeScrollerApp();
	await nextFrame(dom);

	box.scrollTop = 5;
	expect(box.scrollTop).toBe(5);

	// Down to 4 rows of content in a 3-row box: 1 row of room.
	while (box.children.length > 4) {
		box.removeChild(box.lastChild!);
	}
	await nextFrame(dom);
	expect(box.scrollTop).toBe(1);
	dom.dispose();
});

test("painted rows shift by scrollTop, clipped to the box", async () => {
	const {terminal, dom, box} = makeScrollerApp();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toBe("row 0\nrow 1\nrow 2\n");

	box.scrollTop = 4;
	await nextFrame(dom);
	expect(terminal.getPlainText()).toBe("row 4\nrow 5\nrow 6\n");
	dom.dispose();
});

test("painted columns shift by scrollLeft", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const box = dom.document.createElement("div");
	box.style.width = "4ch";
	box.style.overflow = "auto";
	const wide = dom.document.createElement("div");
	wide.style.width = "8ch";
	wide.textContent = "abcdefgh";
	box.appendChild(wide);
	dom.document.body.appendChild(box);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toBe("abcd\n");

	box.scrollLeft = 3;
	await nextFrame(dom);
	expect(terminal.getPlainText()).toBe("defg\n");
	dom.dispose();
});

test("elementFromPoint sees the row the scroll put there", async () => {
	const {dom, box} = makeScrollerApp();
	await nextFrame(dom);
	expect(dom.document.elementFromPoint(1, 1)?.id).toBe("line-1");

	box.scrollTop = 4;
	await nextFrame(dom);
	expect(dom.document.elementFromPoint(1, 1)?.id).toBe("line-5");
	dom.dispose();
});

test("a click after scrolling lands on the element shown there", async () => {
	const {terminal, dom, box} = makeScrollerApp();
	await nextFrame(dom);
	box.scrollTop = 4;
	await nextFrame(dom);

	let clicked: string | null = null;
	dom.document.addEventListener("click", (event) => {
		clicked = (event.target as Element).id;
	});
	// Press and release on the box's second visual row (screen row 2).
	await send(terminal, "\x1b[<0;2;2M");
	await send(terminal, "\x1b[<0;2;2m");
	expect(clicked).toBe("line-5");
	dom.dispose();
});

test("wheel scrolls the innermost scroller, then chains to the camera", async () => {
	// 8 scroller rows over enough document lines to give the camera room.
	const {terminal, dom, box} = makeScrollerApp({rows: 5, lines: 5});
	const {document} = dom;
	for (let i = 0; i < 10; i++) {
		const div = document.createElement("div");
		div.textContent = `below ${i}`;
		document.body.appendChild(div);
	}
	await nextFrame(dom);

	// A wheel tick is 3 rows. The scroller has 2 rows of room (5 lines in
	// 3), so the first tick exhausts it -- and the camera doesn't move.
	await send(terminal, "\x1b[<65;2;2M");
	expect(box.scrollTop).toBe(2);
	expect(dom.window.scrollY).toBe(0);

	// The next tick chains outward to the camera.
	await send(terminal, "\x1b[<65;2;2M");
	await nextFrame(dom);
	expect(box.scrollTop).toBe(2);
	expect(dom.window.scrollY).toBe(3);

	// The camera has scrolled the box off screen, so wheel up belongs to
	// the camera; once the box is back under the pointer, the wheel is its.
	await send(terminal, "\x1b[<64;2;1M");
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	await send(terminal, "\x1b[<64;2;2M");
	expect(box.scrollTop).toBe(0);
	expect(dom.window.scrollY).toBe(0);
	dom.dispose();
});

test("preventDefault on wheel keeps a scroller still", async () => {
	const {terminal, dom, box} = makeScrollerApp();
	await nextFrame(dom);
	dom.document.addEventListener(
		"wheel",
		(event) => event.preventDefault(),
		{passive: false},
	);
	await send(terminal, "\x1b[<65;2;2M");
	expect(box.scrollTop).toBe(0);
	dom.dispose();
});

test("scrollTo/scroll/scrollBy move a scroller in both their forms", async () => {
	const {dom, box} = makeScrollerApp();
	await nextFrame(dom);

	box.scrollTo(0, 2);
	expect(box.scrollTop).toBe(2);

	box.scrollTo({top: 1});
	expect(box.scrollTop).toBe(1);

	box.scroll(0, 3);
	expect(box.scrollTop).toBe(3);

	box.scrollBy(0, 1);
	expect(box.scrollTop).toBe(4);

	box.scrollBy({top: -2});
	expect(box.scrollTop).toBe(2);
	dom.dispose();
});

test("scrollIntoView scrolls ancestor scrollers, then the camera", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	// Padding above pushes the outer scroller past the first screen.
	for (let i = 0; i < 6; i++) {
		const div = document.createElement("div");
		div.textContent = `above ${i}`;
		document.body.appendChild(div);
	}
	const outer = document.createElement("div");
	outer.style.height = "3px";
	outer.style.overflow = "auto";
	const inner = document.createElement("div");
	inner.style.height = "2px";
	inner.style.overflow = "auto";
	let target: HTMLElement | null = null;
	for (let i = 0; i < 6; i++) {
		const line = document.createElement("div");
		line.id = `deep-${i}`;
		line.textContent = `deep ${i}`;
		inner.appendChild(line);
		if (i === 5) {
			target = line as HTMLElement;
		}
	}
	outer.appendChild(inner);
	const tail = document.createElement("div");
	tail.textContent = "tail";
	outer.appendChild(tail);
	document.body.appendChild(outer);
	await nextFrame(dom);

	target!.scrollIntoView();
	await nextFrame(dom);
	// The inner scroller reveals its last row, the outer reveals the
	// inner's bottom, and the camera reveals the outer's rows.
	expect(inner.scrollTop).toBe(4);
	expect(outer.scrollTop).toBe(0);
	const rect = target!.getBoundingClientRect();
	expect(rect.top).toBeGreaterThanOrEqual(0);
	expect(rect.bottom).toBeLessThanOrEqual(4);
	expect(terminal.getPlainText()).toContain("deep 5");
	dom.dispose();
});
