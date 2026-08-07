/**
 * attach() is the ONLY door to the terminal. Constructing a TermDOM and
 * mutating its document is inert: no stdout bytes, no raw mode, no lazy
 * takeover on first render. attach() takes the terminal and paints whatever
 * the document already holds; mutations after it render normally.
 */
import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM} from "../src/internal/termdom.js";

function countWrites(terminal: MockProcess): {count(): number} {
	let writes = 0;
	const original = terminal.stdout.write.bind(terminal.stdout);
	terminal.stdout.write = ((chunk: any, enc?: any, cb?: any) => {
		writes++;
		return original(chunk, enc, cb);
	}) as typeof terminal.stdout.write;
	return {count: () => writes};
}

test("mutations produce no stdout before attach()", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>should not paint</div>`;
	dom.document.body.appendChild(dom.document.createElement("p"));
	// Let the mutation observer microtask and any stray timers run.
	await new Promise((r) => setTimeout(r, 50));
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("attach() paints the document built before it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>early content</div>`;
	await new Promise((r) => setTimeout(r, 20));
	expect(terminal.getVisibleText()).not.toContain("early content");

	dom.attach();
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("early content");
	dom.dispose();
});

test("geometry reads work unattached, and stay silent", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="box" style="width:10px">x</div>`;
	const rect = dom.document.getElementById("box")!.getBoundingClientRect();
	expect(rect.width).toBe(10);
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("dispose() before attach() writes nothing", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>never shown</div>`;
	await new Promise((r) => setTimeout(r, 20));
	dom.dispose();
	expect(writes.count()).toBe(0);
});

test("requestFullscreen before attach() rejects and stays silent", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="stage">x</div>`;
	await expect(
		dom.document.getElementById("stage")!.requestFullscreen(),
	).rejects.toThrow();
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("renderToString returns ANSI without attach or stdout", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="color:red">static content</div>`;
	const ansi = dom.renderToString();
	expect(ansi).toContain("static content");
	expect(ansi).toContain("\x1b[38;2;255;0;0m");
	// A document string, not a terminal session: no modes, no cursor control.
	expect(ansi).not.toContain("\x1b[?");
	expect(ansi).not.toContain("\x1b[2J");
	expect(writes.count()).toBe(0);
	dom.dispose();
});

test("print() writes the document once, with no terminal takeover", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const writes = countWrites(terminal);
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>printed line</div>`;
	dom.print();
	expect(writes.count()).toBe(1);
	// The mock terminal ingests writes asynchronously; let it catch up.
	await new Promise((r) => setTimeout(r, 20));
	expect(terminal.getVisibleText()).toContain("printed line");
	dom.dispose();
	// dispose after a print still owes the terminal nothing.
	expect(writes.count()).toBe(1);
});
