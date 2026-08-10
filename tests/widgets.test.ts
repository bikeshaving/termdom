/**
 * The user-agent widgets past the form fields: what a browser hides
 * (datalist, a closed dialog, a closed details), the disclosure a summary
 * opens, the bars progress and meter draw, and the chrome a fieldset puts
 * around its legend.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

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

/* ------------------------------------------------------ details/summary */

test("the disclosure marker follows the open state", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<details><summary>More</summary><p>body</p></details>`;
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("▸ More");

	const details = document.querySelector("details") as HTMLDetailsElement;
	details.setAttribute("open", "");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("▾ More");

	dom.dispose();
});

test("clicking the summary toggles open and fires toggle", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<details><summary>More</summary><p>secret</p></details>`;
	await nextFrame(dom);

	const details = document.querySelector("details") as HTMLDetailsElement;
	const states: string[] = [];
	details.addEventListener("toggle", (event) => {
		states.push((event as any).newState);
	});

	(document.querySelector("summary") as HTMLElement).click();
	expect(details.hasAttribute("open")).toBe(true);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("secret");

	(document.querySelector("summary") as HTMLElement).click();
	expect(details.hasAttribute("open")).toBe(false);
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("secret");

	expect(states).toEqual(["open", "closed"]);

	dom.dispose();
});

test("Enter on a focused summary toggles the disclosure", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<details><summary>More</summary><p>secret</p></details>`;
	await nextFrame(dom);

	(document.querySelector("summary") as HTMLElement).focus();
	await type(terminal, "\r");
	const details = document.querySelector("details") as HTMLDetailsElement;
	expect(details.hasAttribute("open")).toBe(true);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("secret");

	dom.dispose();
});

test("Tab reaches a summary", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<details><summary>More</summary><p>secret</p></details>`;
	await nextFrame(dom);

	await type(terminal, "\t");
	expect(document.activeElement?.tagName).toBe("SUMMARY");

	dom.dispose();
});
