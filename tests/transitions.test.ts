/**
 * CSS transitions: started by style change events, read back through
 * getComputedStyle mid-flight, reported through the four transition events,
 * and painted through the frame the tick schedules.
 *
 * `steps(1, jump-both)` is the timing function of choice here: its output is
 * 1/2 for any input strictly between the endpoints, so a mid-flight read has
 * one deterministic answer however long the frame took to arrive.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function attached(html: string): {
	terminal: MockProcess;
	dom: TermDOM;
	document: TermDOM["document"];
	window: TermDOM["window"];
} {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport, html});
	return {terminal, dom, document: dom.document, window: dom.window};
}

test("transition events fire in order with their payloads", async () => {
	const {dom, document, window} = attached(
		"<style>#box { width: 10px; height: 1px; transition: width 0.05s linear; }</style><div id='box'></div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const events: Array<[string, string, number, boolean, boolean]> = [];
	for (const type of [
		"transitionrun",
		"transitionstart",
		"transitionend",
		"transitioncancel",
	]) {
		box.addEventListener(type, (event) => {
			const e = event as unknown as {
				propertyName: string;
				elapsedTime: number;
				bubbles: boolean;
				isTrusted: boolean;
			};
			events.push([
				type,
				e.propertyName,
				e.elapsedTime,
				e.bubbles,
				e.isTrusted,
			]);
		});
	}
	box.style.width = "20px";
	await new Promise<void>((resolve) =>
		box.addEventListener("transitionend", () => resolve()),
	);
	expect(events).toEqual([
		["transitionrun", "width", 0, true, true],
		["transitionstart", "width", 0, true, true],
		["transitionend", "width", 0.05, true, true],
	]);
	expect(window.getComputedStyle(box).width).toBe("20px");
	await dom.dispose();
});

test("getComputedStyle answers the interpolated value mid-transition", async () => {
	const {dom, document, window} = attached(
		"<style>#box { width: 10px; height: 1px; color: rgb(0, 0, 0); " +
		"transition: width 100s steps(1, jump-both), color 100s steps(1, jump-both); }" +
		"</style><div id='box'>x</div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	box.style.width = "20px";
	box.style.color = "rgb(255, 255, 255)";
	await nextFrame(dom);
	const style = window.getComputedStyle(box);
	expect(style.width).toBe("15px");
	expect(style.color).toBe("rgb(128, 128, 128)");
	await dom.dispose();
});

test("a non-interpolable property flips at the midpoint", async () => {
	const {dom, document, window} = attached(
		"<style>#box { text-align: left; height: 1px; " +
		"transition: text-align 100s steps(1, jump-both); }" +
		"</style><div id='box'>x</div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	box.style.textAlign = "center";
	await nextFrame(dom);
	// Eased progress stands at 1/2, and the flip lands on the target side.
	expect(window.getComputedStyle(box).textAlign).toBe("center");
	await dom.dispose();
});

test("a pseudo-element transitions, and its events name it", async () => {
	const {dom, document, window} = attached(
		"<style>" +
		"#host::before { content: 'x'; color: rgb(0, 0, 0); " +
		"transition: color 100s steps(1, jump-both); }" +
		"#host.hot::before { color: rgb(255, 0, 255); }" +
		"</style><div id='host'>host</div>",
	);
	await nextFrame(dom);
	const host = document.getElementById("host")!;
	const started = new Promise<{propertyName: string; pseudoElement: string}>(
		(resolve) =>
			host.addEventListener("transitionstart", (event) =>
				resolve(event as unknown as {
					propertyName: string;
					pseudoElement: string;
				}),
			),
	);
	host.className = "hot";
	const event = await started;
	expect(event.propertyName).toBe("color");
	expect(event.pseudoElement).toBe("::before");
	await nextFrame(dom);
	expect(window.getComputedStyle(host, "::before").color).toBe(
		"rgb(128, 0, 128)",
	);
	await dom.dispose();
});

test("removing the transition declaration cancels mid-flight", async () => {
	const {dom, document} = attached(
		"<style>" +
		"#box { width: 10px; height: 1px; }" +
		"#box.eased { transition: width 100s linear; }" +
		"</style><div id='box' class='eased'></div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const canceled = new Promise<{propertyName: string}>((resolve) =>
		box.addEventListener("transitioncancel", (event) =>
			resolve(event as unknown as {propertyName: string}),
		),
	);
	box.style.width = "20px";
	await new Promise<void>((resolve) =>
		box.addEventListener("transitionstart", () => resolve()),
	);
	box.classList.remove("eased");
	await nextFrame(dom);
	expect((await canceled).propertyName).toBe("width");
	await dom.dispose();
});

test("removing the element cancels its transitions", async () => {
	const {dom, document} = attached(
		"<style>#box { width: 10px; height: 1px; transition: width 100s linear; }" +
		"</style><div id='box'></div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const canceled = new Promise<{propertyName: string}>((resolve) =>
		box.addEventListener("transitioncancel", (event) =>
			resolve(event as unknown as {propertyName: string}),
		),
	);
	box.style.width = "20px";
	await new Promise<void>((resolve) =>
		box.addEventListener("transitionstart", () => resolve()),
	);
	box.remove();
	expect((await canceled).propertyName).toBe("width");
	await dom.dispose();
});

test("retargeting mid-flight cancels and starts over from here", async () => {
	const {dom, document, window} = attached(
		"<style>#box { width: 10px; height: 1px; " +
		"transition: width 100s steps(1, jump-both); }" +
		"</style><div id='box'></div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const events: string[] = [];
	for (const type of ["transitionrun", "transitioncancel"]) {
		box.addEventListener(type, () => events.push(type));
	}
	box.style.width = "30px";
	await nextFrame(dom);
	// Standing at 20px; the new target starts a fresh transition from here.
	box.style.width = "60px";
	await nextFrame(dom);
	expect(events).toEqual([
		"transitionrun",
		"transitioncancel",
		"transitionrun",
	]);
	// Midway from 20px to 60px.
	expect(window.getComputedStyle(box).width).toBe("40px");
	await dom.dispose();
});

test("the transition longhands serialize from the shorthand", async () => {
	const {dom, document, window} = attached(
		"<style>#box { transition: left 2s ease-in 0.5s, color 1s; }" +
		"</style><div id='box'></div>",
	);
	await nextFrame(dom);
	const style = window.getComputedStyle(document.getElementById("box")!);
	expect(style.transitionProperty).toBe("left, color");
	expect(style.transitionDuration).toBe("2s, 1s");
	expect(style.transitionDelay).toBe("0.5s, 0s");
	expect(style.transitionTimingFunction).toBe("ease-in, ease");
	await dom.dispose();
});

test("a delayed transition holds its start value, then runs", async () => {
	const {dom, document, window} = attached(
		"<style>#box { width: 10px; height: 1px; " +
		"transition: width 0.05s steps(1, jump-both) 0.06s; }" +
		"</style><div id='box'></div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const types: string[] = [];
	for (const type of ["transitionrun", "transitionstart", "transitionend"]) {
		box.addEventListener(type, () => types.push(type));
	}
	box.style.width = "20px";
	await nextFrame(dom);
	// Inside the delay: transitionrun has fired, transitionstart has not,
	// and the value still reads as where it started.
	expect(types).toEqual(["transitionrun"]);
	expect(window.getComputedStyle(box).width).toBe("10px");
	await new Promise<void>((resolve) =>
		box.addEventListener("transitionend", () => resolve()),
	);
	expect(types).toEqual(["transitionrun", "transitionstart", "transitionend"]);
	expect(window.getComputedStyle(box).width).toBe("20px");
	await dom.dispose();
});

test("the painter draws the interpolated color", async () => {
	const {terminal, dom, document} = attached(
		"<style>#box { color: rgb(0, 0, 0); height: 1px; " +
		"transition: color 100s steps(1, jump-both); }" +
		"</style><div id='box'>mid</div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	box.style.color = "rgb(255, 255, 255)";
	await nextFrame(dom);
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toMatch(/38;2;128;128;128/);
	await dom.dispose();
});

test("a transition declared and retargeted in one event still runs", async () => {
	const {dom, document} = attached("<div id='box' style='height: 1px'></div>");
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const {window} = dom;
	// The read is what makes a before-change value: nothing transitions
	// from a value nothing ever computed.
	expect(window.getComputedStyle(box).color).toBe("rgb(0, 0, 0)");
	const started = new Promise<{propertyName: string}>((resolve) =>
		box.addEventListener("transitionstart", (event) =>
			resolve(event as unknown as {propertyName: string}),
		),
	);
	box.style.color = "rgb(0, 128, 0)";
	box.style.transition = "color 0.05s";
	expect((await started).propertyName).toBe("color");
	await dom.dispose();
});

test("a linear() stop list eases by its stops", async () => {
	const {dom, document, window} = attached(
		"<style>#box { color: rgb(0, 0, 0); height: 1px; " +
		"transition: color 100s linear(0.25 0% 50%, 1 100%); }" +
		"</style><div id='box'>x</div>",
	);
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	box.style.color = "rgb(200, 200, 200)";
	await nextFrame(dom);
	// The flat opening segment holds the eased output at 0.25 through the
	// first half, so a read at any early progress lands on channel 50.
	expect(window.getComputedStyle(box).color).toBe("rgb(50, 50, 50)");
	await dom.dispose();
});
