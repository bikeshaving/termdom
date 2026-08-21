/**
 * The UA capability handshake: installUAEngine hands its caller the things a
 * user agent may do that a page may not, exactly once per document, scoped
 * to that document.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM, kUAToolkit} from "../src/internal/termdom.js";
import {installUAEngine, createHTMLDocument} from "../src/internal/dom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("a document takes one user agent and refuses a second", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	expect(() => installUAEngine(dom.document, {} as never)).toThrow();
	dom.dispose();
});

test("a toolkit taken on another document opens nothing here", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<input value=\"x\">";
	await nextFrame(dom);
	const input = dom.document.querySelector("input")!;

	const bystander = createHTMLDocument();
	const stolen = installUAEngine(bystander, {} as never);
	expect(stolen.shadowRootOf(input)).toBe(null);
	expect(stolen.selectionOf(input)).toBe(null);
	expect(stolen.valueTextOf(input)).toBe(null);

	dom.dispose();
});

test("the toolkit reads past the type gate the author meets", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<input id=\"n\" type=\"number\" value=\"12\">" +
		"<input id=\"c\" type=\"checkbox\"><div id=\"d\">plain</div>";
	await nextFrame(dom);

	const number = dom.document.getElementById("n") as HTMLInputElement;
	const checkbox = dom.document.getElementById("c") as HTMLInputElement;
	const div = dom.document.getElementById("d")!;
	// The author-facing API hides a number input's selection per spec.
	expect(number.selectionStart).toBe(null);

	const toolkit = dom[kUAToolkit];
	const record = toolkit.selectionOf(number);
	expect(record).not.toBe(null);
	expect(typeof record!.start).toBe("number");
	// A toggle's selection is degenerate: always collapsed, never null --
	// its focus point is where the cursor parks.
	const toggled = toolkit.selectionOf(checkbox);
	expect(toggled).not.toBe(null);
	expect(toggled!.start).toBe(toggled!.end);
	expect(toolkit.selectionOf(div)).toBe(null);
	expect(toolkit.shadowRootOf(number)).not.toBe(null);

	dom.dispose();
});
