/**
 * ResizeObserver and IntersectionObserver.
 *
 * Both read boxes the layout engine already produces each frame, so the tests
 * drive real renders and assert the callbacks fire with the right values. JSDOM
 * ships neither observer, so before this they were simply `undefined`.
 */
import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";

function make(rows = 10, cols = 40) {
	const terminal = new MockProcess({rows, cols});
	const dom = new TermDOM({process: terminal});
	return {terminal, dom, document: dom.document, window: dom.window as any};
}

test("both observers exist on the window", () => {
	const {dom, window} = make();
	expect(typeof window.ResizeObserver).toBe("function");
	expect(typeof window.IntersectionObserver).toBe("function");
	dom.dispose();
});

test("ResizeObserver fires an initial entry when it starts observing", async () => {
	const {dom, document, window} = make() as any;
	const box = document.createElement("div");
	box.style.width = "20px";
	box.style.height = "4px";
	document.body.appendChild(box);

	const sizes: string[] = [];
	const ro = new window.ResizeObserver((entries: any[]) => {
		for (const e of entries) {
			sizes.push(`${e.contentRect.width}x${e.contentRect.height}`);
		}
	});
	ro.observe(box);
	await dom.render();

	expect(sizes).toEqual(["20x4"]);
	dom.dispose();
});

test("ResizeObserver fires when the terminal resizes a percentage-sized box", async () => {
	const {terminal, dom, document, window} = make(10, 40) as any;
	const box = document.createElement("div");
	box.style.width = "100%";
	box.style.height = "2px";
	document.body.appendChild(box);

	const widths: number[] = [];
	const ro = new window.ResizeObserver((entries: any[]) => {
		for (const e of entries) widths.push(e.contentRect.width);
	});
	ro.observe(box);
	await dom.render();

	terminal.resize(60, 10);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 60));

	// Full-width at 40 columns, then full-width at 60.
	expect(widths).toEqual([40, 60]);
	dom.dispose();
});

test("ResizeObserver does not fire when the size is unchanged", async () => {
	const {dom, document, window} = make() as any;
	const box = document.createElement("div");
	box.style.width = "10px";
	box.style.height = "2px";
	document.body.appendChild(box);

	let calls = 0;
	const ro = new window.ResizeObserver(() => calls++);
	ro.observe(box);
	await dom.render();
	await dom.render(); // no change
	await dom.render();

	expect(calls).toBe(1);
	dom.dispose();
});

test("unobserve stops further ResizeObserver callbacks", async () => {
	const {terminal, dom, document, window} = make(10, 40) as any;
	const box = document.createElement("div");
	box.style.width = "100%";
	box.style.height = "2px";
	document.body.appendChild(box);

	let calls = 0;
	const ro = new window.ResizeObserver(() => calls++);
	ro.observe(box);
	await dom.render();
	expect(calls).toBe(1);

	ro.unobserve(box);
	terminal.resize(60, 10);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 60));

	expect(calls).toBe(1); // no further call
	dom.dispose();
});

test("IntersectionObserver reports an off-screen element as not intersecting", async () => {
	const {dom, document, window} = make(10, 40) as any;
	document.body.innerHTML = Array.from(
		{length: 20},
		(_, i) => `<div id="r${i}">row ${i}</div>`,
	).join("");

	const states: boolean[] = [];
	const io = new window.IntersectionObserver((entries: any[]) => {
		for (const e of entries) states.push(e.isIntersecting);
	});
	// Row 18 is below a 10-row viewport.
	io.observe(document.getElementById("r18"));
	dom.setViewportMode("document");
	await dom.render();

	expect(states).toEqual([false]);
	dom.dispose();
});

test("IntersectionObserver fires again when a target scrolls into view", async () => {
	const {dom, document, window} = make(10, 40) as any;
	document.body.innerHTML = Array.from(
		{length: 20},
		(_, i) => `<div id="r${i}">row ${i}</div>`,
	).join("");

	const states: boolean[] = [];
	const io = new window.IntersectionObserver((entries: any[]) => {
		for (const e of entries) states.push(e.isIntersecting);
	});
	io.observe(document.getElementById("r18"));
	dom.setViewportMode("document");
	await dom.render();

	dom.scrollDocumentBy(15);
	await dom.render();

	// Off-screen, then scrolled into view -- two callbacks, on each flip.
	expect(states).toEqual([false, true]);
	dom.dispose();
});

test("IntersectionObserver honours a ratio threshold", async () => {
	// A target taller than the viewport can never be more than partly visible, so a
	// threshold of 1 (fully visible) is never met.
	const {dom, document, window} = make(4, 40) as any;
	document.body.innerHTML = `<div id="tall" style="height:8px">tall block</div>`;

	const states: boolean[] = [];
	const io = new window.IntersectionObserver(
		(entries: any[]) => {
			for (const e of entries) states.push(e.isIntersecting);
		},
		{threshold: 1},
	);
	io.observe(document.getElementById("tall"));
	dom.setViewportMode("document");
	await dom.render();

	// The initial callback reports the starting state, as the DOM does. The block
	// overlaps the viewport but is only half visible (4 of 8 rows), which does not
	// meet a threshold of 1, so that state is "not intersecting" -- and it never
	// becomes intersecting, so there is only ever the one initial entry.
	expect(states).toEqual([false]);
	dom.dispose();
});
