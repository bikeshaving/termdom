/**
 * The UA capability handshake: installUAEngine hands its caller the things a
 * user agent may do that a page may not, exactly once per document, scoped
 * to that document.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {
	claimUAToolkit,
	installUAEngine,
	type Document,
	parseHTMLDocument,
} from "../src/internal/dom.js";

// The door a test document comes through. The parser is the one that hands
// a document the realm's custom element registry, as it does the engine's.
function createHTMLDocument(title?: string): Document {
	return parseHTMLDocument(
		title === undefined ?
			"<!doctype html>" :
			`<!doctype html><title>${title}</title>`,
	);
}
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

test("the toolkit reads past the type gate the author meets", () => {
	// The test is the user agent here: it claims the toolkit on a document
	// no engine holds and upgrades the widgets itself -- the same path an
	// engine takes, through the same two public doors.
	const document = createHTMLDocument();
	const toolkit = claimUAToolkit(document);
	document.body!.innerHTML =
		"<input id=\"n\" type=\"number\" value=\"12\">" +
		"<input id=\"c\" type=\"checkbox\"><div id=\"d\">plain</div>";

	const number = document.getElementById("n") as unknown as HTMLInputElement;
	const checkbox = document.getElementById("c") as unknown as HTMLInputElement;
	const div = document.getElementById("d")!;
	toolkit.upgradeWidget(number);
	toolkit.upgradeWidget(checkbox);
	// The author-facing API hides a number input's selection per spec.
	expect(number.selectionStart).toBe(null);

	const record = toolkit.selectionOf(number);
	expect(record).not.toBe(null);
	expect(typeof record!.start).toBe("number");
	// A toggle's selection is degenerate: always collapsed, never null --
	// its focus point is where the cursor parks.
	const toggled = toolkit.selectionOf(checkbox);
	expect(toggled).not.toBe(null);
	expect(toggled!.start).toBe(toggled!.end);
	expect(toolkit.selectionOf(div)).toBe(null);

	// A closed root hides from the author and answers to the toolkit.
	const host = document.createElement("div");
	document.body!.appendChild(host);
	const closed = host.attachShadow({mode: "closed"});
	expect(host.shadowRoot).toBe(null);
	expect(toolkit.shadowRootOf(host)).toBe(closed);
});
