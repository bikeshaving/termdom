import {expect, test} from "@b9g/libuild/test";

import {createDocumentWindow} from "../src/internal/dom.ts";
import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils";

function filler(rows: number): string {
	let html = "";
	for (let i = 0; i < rows; i++) {
		html += `<div>filler ${i}</div>`;
	}
	return html;
}

function closeCountingTransport(terminal: MockProcess): {
	transport: any;
	closes(): number;
} {
	const base = terminal.transport;
	let closes = 0;
	return {
		transport: {
			...base,
			cols: base.cols,
			rows: base.rows,
			close: () => {
				closes++;
			},
		},
		closes: () => closes,
	};
}

test("a details opened inside a shadow root scrolls into view", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = filler(20) + "<div id=host></div>";
	const root = document.getElementById("host")!.attachShadow({mode: "open"});
	root.innerHTML = "<details><summary>more</summary>revealed body</details>";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("filler 0");
	expect(terminal.getVisibleText()).not.toContain("revealed body");

	root.querySelector("details")!.open = true;
	await new Promise((r) => setTimeout(r, 20));
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("revealed body");
	await dom.dispose();
});

test("a change inside a shadow root reveals the control", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document, window} = dom;
	document.body.innerHTML = filler(20) + "<div id=host></div>";
	const root = document.getElementById("host")!.attachShadow({mode: "open"});
	root.innerHTML = "<select><option>alpha</option><option>beta</option></select>";
	const select = root.querySelector("select")!;
	await nextFrame(dom);
	select.focus();
	await nextFrame(dom);
	window.scrollTo(0, 0);
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("filler 0");
	expect(terminal.getVisibleText()).not.toContain("alpha");

	select.dispatchEvent(new window.Event("change", {bubbles: true}));
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("alpha");
	await dom.dispose();
});

test("a page's own beforeunload closes nothing; the window's does", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const watched = closeCountingTransport(terminal);
	const dom = new TermDOM({transport: watched.transport});
	dom.attach();
	dom.document.body.innerHTML = "<div>open</div>";
	await nextFrame(dom);

	dom.window.dispatchEvent(new dom.window.Event("beforeunload"));
	await new Promise((r) => setTimeout(r, 60));
	expect(watched.closes()).toBe(0);

	dom.window.close();
	await new Promise((r) => setTimeout(r, 60));
	expect(watched.closes()).toBe(1);
});

test("a document is visible from attach() to dispose()", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const states: string[] = [];
	document.addEventListener("visibilitychange", () => {
		states.push(document.visibilityState);
	});
	expect(document.hidden).toBe(true);
	expect(document.visibilityState).toBe("hidden");

	dom.attach();
	expect(document.hidden).toBe(false);
	expect(document.visibilityState).toBe("visible");
	await nextFrame(dom);

	await dom.dispose();
	expect(document.hidden).toBe(true);
	expect(states).toEqual(["visible", "hidden"]);
});

test("a headless document has no terminal to hide it", () => {
	const window = createDocumentWindow(
		"<!DOCTYPE html><html><head></head><body></body></html>",
	);
	expect(window.document.hidden).toBe(false);
	expect(window.document.visibilityState).toBe("visible");
});
