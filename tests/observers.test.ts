/**
 * ResizeObserver and IntersectionObserver.
 *
 * Both read boxes the layout engine already produces each frame, so the tests
 * drive real renders and assert the callbacks fire with the right values.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function make(rows = 10, cols = 40) {
	const terminal = new MockProcess({rows, cols});
	const dom = new TermDOM({transport: terminal.transport});
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
	await nextFrame(dom);

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
		for (const e of entries) {
			widths.push(e.contentRect.width);
		}
	});
	ro.observe(box);
	await nextFrame(dom);

	terminal.resize(60, 10);
	(terminal as any).emit("SIGWINCH");
	// The resize pipeline is debounced (RESIZE_DEBOUNCE_MS) and re-anchors
	// through an async cursor query -- wait for the observation itself, not a
	// guessed interval.
	const deadline = Date.now() + 2000;
	while (widths.length < 2 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}

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
	await nextFrame(dom); // no change
	await nextFrame(dom);

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
	await nextFrame(dom);
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
		for (const e of entries) {
			states.push(e.isIntersecting);
		}
	});
	// Row 18 is below a 10-row viewport.
	io.observe(document.getElementById("r18"));
	await nextFrame(dom);

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
		for (const e of entries) {
			states.push(e.isIntersecting);
		}
	});
	io.observe(document.getElementById("r18"));
	await nextFrame(dom);

	dom.window.scrollBy(0, 15);
	await nextFrame(dom);

	// Off-screen, then scrolled into view -- two callbacks, on each flip.
	expect(states).toEqual([false, true]);
	dom.dispose();
});

test("IntersectionObserver honours a ratio threshold", async () => {
	// A target taller than the viewport can never be more than partly visible, so a
	// threshold of 1 (fully visible) is never met.
	const {dom, document, window} = make(4, 40) as any;
	document.body.innerHTML = "<div id=\"tall\" style=\"height:8px\">tall block</div>";

	const states: boolean[] = [];
	const io = new window.IntersectionObserver(
		(entries: any[]) => {
			for (const e of entries) {
				states.push(e.isIntersecting);
			}
		},
		{threshold: 1},
	);
	io.observe(document.getElementById("tall"));
	await nextFrame(dom);

	// The initial callback reports the starting state, as the DOM does. The block
	// overlaps the viewport but is only half visible (4 of 8 rows), which does not
	// meet a threshold of 1, so that state is "not intersecting" -- and it never
	// becomes intersecting, so there is only ever the one initial entry.
	expect(states).toEqual([false]);
	dom.dispose();
});

test("the manager hook is not part of the public surface", () => {
	// These objects are handed to author code as window.ResizeObserver, so their
	// surface has to be the DOM's. The measure hook the manager calls is keyed by
	// a module-private symbol precisely so it cannot be seen or called from here.
	const {dom, window} = make() as any;
	const ro = new window.ResizeObserver(() => {});
	const io = new window.IntersectionObserver(() => {});

	expect((ro as {check?: unknown}).check).toBeUndefined();
	expect((io as {check?: unknown}).check).toBeUndefined();
	// Nor reachable by enumerating what the object exposes.
	const names = new Set<string>();
	for (
		let o = ro;
		o && o !== Object.prototype;
		o = Object.getPrototypeOf(o) as typeof ro
	) {
		for (const key of Object.getOwnPropertyNames(o)) {
			names.add(key);
		}
	}
	expect([...names].some((n) => /check/i.test(n))).toBe(false);

	dom.dispose();
});

test("ResizeObserver reports the content box's own origin", async () => {
	const {dom, document, window} = make() as any;
	document.body.innerHTML = "<div id=\"a\" style=\"width:10ch;height:3px;padding:1px 2ch\">A</div>";
	await nextFrame(dom);

	const entries: Array<{contentRect: {top: number; left: number}}> = [];
	const ro = new window.ResizeObserver((es: typeof entries) =>
		entries.push(...es),
	);
	ro.observe(document.getElementById("a"));
	await nextFrame(dom);

	// Not 0,0: contentRect's origin is what precedes the content inside the
	// border box, which here is one row of padding and two columns of it.
	expect(entries[0].contentRect.top).toBe(1);
	expect(entries[0].contentRect.left).toBe(2);

	dom.dispose();
});

test("ResizeObserver reports 0x0 when an element is hidden", async () => {
	const {dom, document, window} = make() as any;
	document.body.innerHTML = "<div id=\"a\" style=\"width:10ch;height:3px\">A</div>";
	await nextFrame(dom);

	const entries: Array<{
		contentRect: {top: number; left: number; width: number; height: number};
	}> = [];
	const ro = new window.ResizeObserver((es: typeof entries) =>
		entries.push(...es),
	);
	ro.observe(document.getElementById("a"));
	await nextFrame(dom);
	entries.length = 0;

	document.getElementById("a").style.display = "none";
	await nextFrame(dom);

	// Reporting the hide is how a component learns it has been hidden; skipping
	// it left the observer holding the last size the element ever had.
	expect(entries.length).toBe(1);
	// contentRect is a real DOMRect (as in a browser), so compare fields
	// rather than structure.
	const rect = entries[0].contentRect;
	expect(rect.top).toBe(0);
	expect(rect.left).toBe(0);
	expect(rect.width).toBe(0);
	expect(rect.height).toBe(0);

	dom.dispose();
});

test("display:none stops taking up rows", async () => {
	// Not an observer bug: styleFlexNode set DISPLAY_NONE and then a later branch
	// reset it to flex, so a hidden element stopped painting but kept its space.
	const {dom, terminal, document} = make(8, 30) as any;
	document.body.innerHTML = "<div id=\"a\" style=\"height:3px\">AAA</div><div>after</div>";
	await nextFrame(dom);

	const rows = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((l: string) => l.replace(/\s+$/, ""));
	expect(rows()[3]).toBe("after");

	document.getElementById("a").style.display = "none";
	await nextFrame(dom);
	expect(rows()[0]).toBe("after");

	// And comes back.
	document.getElementById("a").style.display = "";
	await nextFrame(dom);
	expect(rows()[0]).toBe("AAA");
	expect(rows()[3]).toBe("after");

	dom.dispose();
});

test("IntersectionObserver honours rootMargin", async () => {
	const {dom, document, window} = make(5, 40) as any;
	document.body.innerHTML = "<div style=\"height:20px\">spacer</div><div id=\"far\" style=\"height:2px\">far</div>";
	await nextFrame(dom);
	const far = document.getElementById("far");

	const without: boolean[] = [];
	const a = new window.IntersectionObserver(
		(es: Array<{isIntersecting: boolean}>) => {
			for (const e of es) {
				without.push(e.isIntersecting);
			}
		},
	);
	a.observe(far);
	await nextFrame(dom);
	expect(without).toEqual([false]);

	const withMargin: boolean[] = [];
	const b = new window.IntersectionObserver(
		(es: Array<{isIntersecting: boolean}>) => {
			for (const e of es) {
				withMargin.push(e.isIntersecting);
			}
		},
		{rootMargin: "100px"},
	);
	b.observe(far);
	await nextFrame(dom);
	// The whole point of the option: start work before the row scrolls in.
	expect(withMargin).toEqual([true]);

	dom.dispose();
});

test("IntersectionObserver fires at every threshold crossing", async () => {
	const {dom, document, window} = make(6, 40) as any;
	document.body.innerHTML =
		"<div style=\"height:3px\">top</div>" +
		"<div id=\"target\" style=\"height:4px\">target</div>" +
		"<div style=\"height:40px\">filler</div>";
	await nextFrame(dom);

	const ratios: number[] = [];
	const io = new window.IntersectionObserver(
		(es: Array<{intersectionRatio: number}>) => {
			for (const e of es) {
				ratios.push(e.intersectionRatio);
			}
		},
		{threshold: [0, 0.25, 0.5, 0.75, 1]},
	);
	io.observe(document.getElementById("target"));
	await nextFrame(dom);
	for (let i = 0; i < 5; i++) {
		dom.window.scrollBy(0, 1);
		await nextFrame(dom);
	}

	// Tracking only the boolean "is it intersecting" collapsed the whole scroll
	// into a single callback and made threshold arrays decorative.
	expect(ratios.length).toBeGreaterThan(1);

	dom.dispose();
});

test("IntersectionObserver exposes root, rootMargin and thresholds", () => {
	const {dom, document, window} = make() as any;
	document.body.innerHTML = "<div id=\"r\"></div>";
	const root = document.getElementById("r");
	const io = new window.IntersectionObserver(() => {}, {
		root,
		rootMargin: "10px",
		threshold: [1, 0, 0.5],
	});

	expect(io.root).toBe(root);
	expect(io.rootMargin).toBe("10px");
	expect(io.thresholds).toEqual([0, 0.5, 1]); // sorted, as the DOM requires
	expect(typeof io.takeRecords).toBe("function");
	expect(io.takeRecords()).toEqual([]);

	dom.dispose();
});

test("observe({box}) chooses which box's change is worth reporting", async () => {
	const {dom, document, window} = make() as any;
	const box = document.createElement("div");
	box.style.boxSizing = "border-box";
	box.style.width = "20px";
	box.style.height = "4px";
	document.body.appendChild(box);

	const content: string[] = [];
	const border: string[] = [];
	const record = (into: string[]) => (entries: any[]) => {
		for (const e of entries) {
			into.push(
				`${e.contentBoxSize[0].inlineSize}/${e.borderBoxSize[0].inlineSize}`,
			);
		}
	};
	const contentRO = new window.ResizeObserver(record(content));
	const borderRO = new window.ResizeObserver(record(border));
	contentRO.observe(box, {box: "content-box"});
	borderRO.observe(box, {box: "border-box"});
	await nextFrame(dom);
	expect(content).toEqual(["20/20"]);
	expect(border).toEqual(["20/20"]);

	// Padding moves the content box while border-box sizing pins the border box.
	box.style.paddingLeft = "2px";
	box.style.paddingRight = "2px";
	await nextFrame(dom);
	expect(content).toEqual(["20/20", "16/20"]);
	expect(border).toEqual(["20/20"]);

	dom.dispose();
});

test("observe() rejects a box name the DOM does not enumerate", () => {
	const {dom, document, window} = make() as any;
	const box = document.createElement("div");
	document.body.appendChild(box);
	const ro = new window.ResizeObserver(() => {});
	expect(() => ro.observe(box, {box: "padding-box"})).toThrow(TypeError);
	ro.observe(box, {box: "device-pixel-content-box"});
	dom.dispose();
});
