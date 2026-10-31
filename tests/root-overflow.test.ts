/**
 * The root element's overflow belongs to the viewport, or the body's when
 * the root's is visible, and the element it came from then has visible
 * overflow itself (css-overflow-3 §3.3). A viewport that hides or clips
 * still scrolls for scripts, but not for the wheel or the keys.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, until} from "./test-utils.js";

const PAGE_DOWN = "\x1b[6~";
const WHEEL_DOWN = "\x1b[<65;2;2M";

async function open(
	css: string,
): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>${css}</style>`;
	dom.document.body.innerHTML = Array.from(
		{length: 40},
		(_, i) => `<div>row ${i}</div>`,
	).join("");
	await dom.attach();
	await nextFrame(dom);
	return {terminal, dom};
}

async function send(terminal: MockProcess, data: string): Promise<void> {
	terminal.stdin.simulateResponse(data);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function firstRow(terminal: MockProcess): string {
	return terminal.getVisibleText().split("\n")[0].trim();
}

for (const css of [
	"html { height: 100%; overflow-y: auto }",
	"html { height: 100%; overflow: auto }",
	"html { height: 100%; overflow-y: scroll }",
	"html { height: 3px; overflow-y: auto }",
	"html, body { height: 100%; min-height: 100% }" +
		" html { overflow: hidden; overflow-y: auto }" +
		" body { overflow: hidden; height: auto }",
]) {
	test(`the page scrolls under ${css}`, async () => {
		const {terminal, dom} = await open(css);
		const html = dom.document.documentElement;
		await send(terminal, PAGE_DOWN);
		await until(() => dom.window.scrollY === 9);
		await nextFrame(dom);
		expect(html.scrollTop).toBe(9);
		expect(firstRow(terminal)).toBe("row 9");
		await send(terminal, WHEEL_DOWN);
		await until(() => dom.window.scrollY > 9);
		dom.window.scrollTo(0, 2);
		await nextFrame(dom);
		expect(firstRow(terminal)).toBe("row 2");
		expect(html.scrollHeight).toBeGreaterThan(html.clientHeight);
		await dom.dispose();
	});
}

test("the root keeps its computed overflow", async () => {
	const {dom} = await open("html { height: 100%; overflow-y: auto }");
	const style = dom.window.getComputedStyle(dom.document.documentElement);
	expect(style.overflowY).toBe("auto");
	await dom.dispose();
});

for (const css of [
	"html { height: 100%; overflow: hidden }",
	"html { overflow: hidden }",
	"body { overflow: hidden }",
	"html { overflow-y: clip }",
]) {
	test(`the wheel and keys leave the page alone under ${css}`, async () => {
		const {terminal, dom} = await open(css);
		await send(terminal, PAGE_DOWN);
		await send(terminal, WHEEL_DOWN);
		await nextFrame(dom);
		expect(dom.window.scrollY).toBe(0);
		expect(firstRow(terminal)).toBe("row 0");
		dom.window.scrollTo(0, 4);
		await nextFrame(dom);
		expect(dom.window.scrollY).toBe(4);
		expect(firstRow(terminal)).toBe("row 4");
		await dom.dispose();
	});
}

test("a body under a root with its own overflow keeps its own", async () => {
	const {terminal, dom} = await open(
		"html { overflow: auto } body { height: 3px; overflow: hidden }",
	);
	expect(firstRow(terminal)).toBe("row 0");
	expect(terminal.getVisibleText()).not.toContain("row 3");
	await send(terminal, PAGE_DOWN);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	await dom.dispose();
});

test("the body shows its overflow when it gives it to the viewport", async () => {
	const {terminal, dom} = await open("body { height: 3px; overflow: auto }");
	expect(terminal.getVisibleText()).toContain("row 9");
	await dom.dispose();
});

test("a root given overflow after the first frame scrolls the page", async () => {
	const {terminal, dom} = await open("html { height: 100% }");
	const html = dom.document.documentElement;
	html.style.overflowY = "auto";
	await nextFrame(dom);
	await send(terminal, PAGE_DOWN);
	await until(() => dom.window.scrollY === 9);
	html.style.overflowY = "hidden";
	await nextFrame(dom);
	await send(terminal, PAGE_DOWN);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(9);
	html.style.overflowY = "";
	await nextFrame(dom);
	await send(terminal, PAGE_DOWN);
	await until(() => dom.window.scrollY === 18);
	await dom.dispose();
});

test("the body's overflow moves to the viewport as the root's comes and goes", async () => {
	const {terminal, dom} = await open("body { height: 3px; overflow: hidden }");
	const html = dom.document.documentElement;
	expect(terminal.getVisibleText()).toContain("row 9");
	html.style.overflow = "auto";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).not.toContain("row 3");
	html.style.overflow = "";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("row 9");
	await dom.dispose();
});
