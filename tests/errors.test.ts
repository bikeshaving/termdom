/**
 * An exception the page lets escape is reported the way a browser reports
 * it: the window hears an error event, and an unhandled one is logged
 * without touching the screen. The app keeps running.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const press = (col: number, row: number): string => `\x1b[<0;${col};${row}M`;
const release = (col: number, row: number): string => `\x1b[<0;${col};${row}m`;

async function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function attached(terminal: MockProcess): TermDOM {
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<button id=\"b\">go</button><p>page</p>";
	return dom;
}

test("a listener's exception reaches the window and not the screen", async () => {
	const terminal = new MockProcess({rows: 40, cols: 80});
	const dom = attached(terminal);
	const seen: string[] = [];
	dom.window.addEventListener("error", (event) => {
		seen.push((event as ErrorEvent).message);
	});
	dom.document.getElementById("b")!.addEventListener("click", () => {
		throw new Error("boom");
	});
	await nextFrame(dom);

	await type(terminal, press(2, 1) + release(2, 1));
	await nextFrame(dom);
	expect(seen).toEqual(["boom"]);
	expect(terminal.getScreenContents()).not.toContain("boom");

	// The page still works.
	dom.document.querySelector("p")!.textContent = "after";
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toContain("after");

	// The session's end prints what was held, below the document.
	await dom.dispose();
	const screen = terminal.getScreenContents();
	expect(screen).toContain("Error: boom");
	expect(screen.indexOf("after")).toBeLessThan(screen.indexOf("Error: boom"));
});

test("a handled error event is not printed", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = attached(terminal);
	dom.window.addEventListener("error", (event) => event.preventDefault());
	dom.document.getElementById("b")!.addEventListener("click", () => {
		throw new Error("quiet");
	});
	await nextFrame(dom);
	await type(terminal, press(2, 1) + release(2, 1));
	await nextFrame(dom);
	await dom.dispose();
	expect(terminal.getScreenContents()).not.toContain("quiet");
});

test("a stderr that is not the terminal takes the error at once", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const log: string[] = [];
	terminal.stderr = {isTTY: false, write: (chunk) => log.push(chunk)};
	const dom = attached(terminal);
	dom.document.getElementById("b")!.addEventListener("click", () => {
		throw new Error("logged");
	});
	await nextFrame(dom);
	await type(terminal, press(2, 1) + release(2, 1));
	await nextFrame(dom);
	expect(log.join("")).toContain("Error: logged");
	expect(terminal.getScreenContents()).not.toContain("logged");
	await dom.dispose();
	expect(terminal.getScreenContents()).not.toContain("logged");
});

test("a stderr that is the terminal is not written to", async () => {
	const terminal = new MockProcess({rows: 40, cols: 80});
	const log: string[] = [];
	terminal.stderr = {isTTY: true, write: (chunk) => log.push(chunk)};
	const dom = attached(terminal);
	dom.document.getElementById("b")!.addEventListener("click", () => {
		throw new Error("held");
	});
	await nextFrame(dom);
	await type(terminal, press(2, 1) + release(2, 1));
	await nextFrame(dom);
	expect(log).toEqual([]);
	await dom.dispose();
	expect(terminal.getScreenContents()).toContain("Error: held");
});

test("a frame callback's exception does not stop the frames", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = attached(terminal);
	const seen: string[] = [];
	dom.window.addEventListener("error", (event) => {
		seen.push((event as ErrorEvent).message);
		event.preventDefault();
	});
	await nextFrame(dom);
	dom.window.requestAnimationFrame(() => {
		throw new Error("frame");
	});
	await nextFrame(dom);
	expect(seen).toEqual(["frame"]);
	dom.document.querySelector("p")!.textContent = "next";
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toContain("next");
	await dom.dispose();
});

test("an observer's exception is reported and the observer goes on", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = attached(terminal);
	const seen: string[] = [];
	dom.window.addEventListener("error", (event) => {
		seen.push((event as ErrorEvent).message);
		event.preventDefault();
	});
	const p = dom.document.querySelector("p")!;
	let calls = 0;
	const observer = new dom.window.ResizeObserver(() => {
		calls++;
		throw new Error("observed");
	});
	observer.observe(p);
	await nextFrame(dom);
	expect(seen).toEqual(["observed"]);
	p.style.height = "3px";
	await nextFrame(dom);
	expect(calls).toBe(2);
	await dom.dispose();
});
