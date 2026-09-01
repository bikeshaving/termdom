/**
 * The user-agent surface of the DOM module: the things an engine does that
 * the DOM API gives an author no way to do.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	adoptDocument,
	getShadowRoot,
	selectionRecordOf,
} from "../src/internal/dom.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("the UA surface reads past the type gate the author meets", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<input id=\"n\" type=\"number\" value=\"12\">" +
		"<input id=\"c\" type=\"checkbox\"><div id=\"d\">plain</div>";
	await nextFrame(dom);

	const number = document.getElementById("n") as unknown as HTMLInputElement;
	const checkbox = document.getElementById("c") as unknown as HTMLInputElement;
	const div = document.getElementById("d")!;
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
	document.body.appendChild(host);
	const closed = host.attachShadow({mode: "closed"});
	expect(host.shadowRoot).toBe(null);
	expect(getShadowRoot(host)).toBe(closed);
	dom.dispose();
});
