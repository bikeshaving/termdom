/**
 * The user-agent widgets past the form fields: what a browser hides
 * (datalist, a closed dialog, a closed details), the disclosure a summary
 * opens, the bars progress and meter draw, and the chrome a fieldset puts
 * around its legend.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/* ------------------------------------------------------- hidden content */

test("a datalist never renders its options", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		`<datalist id="suggestions"><option>sugg</option></datalist>` +
		`<p>after</p>`;
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).not.toContain("sugg");
	expect(output).toContain("after");

	dom.dispose();
});

test("a dialog renders only while it is open", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<dialog>dialog content</dialog>`;
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("dialog content");

	(document.querySelector("dialog") as HTMLDialogElement).show();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("dialog content");

	dom.dispose();
});

test("a closed details shows its summary and nothing else", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<details><summary>More</summary><p>secret</p></details>`;
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("More");
	expect(output).not.toContain("secret");

	dom.dispose();
});

test("an open details shows its body", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<details open><summary>More</summary><p>secret</p></details>`;
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("More");
	expect(output).toContain("secret");

	dom.dispose();
});
