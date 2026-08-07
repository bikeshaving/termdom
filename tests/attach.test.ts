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
