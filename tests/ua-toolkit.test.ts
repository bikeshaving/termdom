/**
 * The user-agent surface of the DOM module: the things an engine does that
 * the DOM API gives an author no way to do.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {
	getShadowRoot,
	mount,
	selectionRecordOf,
	type Document,
	parseHTMLDocument,
	upgradeUAWidget,
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
import {MockProcess} from "./test-utils.js";

test("a document takes one engine and refuses a second", async () => {
	// Two engines would build every UA widget twice and then disagree about
	// what is on screen.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	expect(() => mount(dom.document, {} as never)).toThrow();
	dom.dispose();
});

test("the UA surface reads past the type gate the author meets", () => {
	// The test is the user agent here: it upgrades the widgets itself, which
	// is the path an engine takes.
	const document = createHTMLDocument();
	document.body!.innerHTML =
		"<input id=\"n\" type=\"number\" value=\"12\">" +
		"<input id=\"c\" type=\"checkbox\"><div id=\"d\">plain</div>";

	const number = document.getElementById("n") as unknown as HTMLInputElement;
	const checkbox = document.getElementById("c") as unknown as HTMLInputElement;
	const div = document.getElementById("d")!;
	upgradeUAWidget(number);
	upgradeUAWidget(checkbox);
	// The author-facing API hides a number input's selection per spec.
	expect(number.selectionStart).toBe(null);

	const record = selectionRecordOf(number);
	expect(record).not.toBe(null);
	expect(typeof record!.start).toBe("number");
	// A toggle's selection is degenerate: always collapsed, never null --
	// its focus point is where the cursor parks.
	const toggled = selectionRecordOf(checkbox);
	expect(toggled).not.toBe(null);
	expect(toggled!.start).toBe(toggled!.end);
	expect(selectionRecordOf(div)).toBe(null);

	// A closed root hides from the author and answers to the engine.
	const host = document.createElement("div");
	document.body.appendChild(host as unknown as globalThis.Node);
	const closed = host.attachShadow({mode: "closed"});
	expect(host.shadowRoot).toBe(null);
	expect(getShadowRoot(host)).toBe(closed);
});
