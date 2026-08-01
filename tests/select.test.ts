/**
 * <select> as a UA shadow tree: a flat field in the input family showing
 * the selected option's label plus a dim ▾ indicator -- both real parts
 * in a UA-internal root, painted by the normal pipeline. Arrow keys move
 * the selection in place (no popup machinery to degrade), firing input
 * and change like a browser's closed select. Options never render: the
 * shadow tree replaces the light children in composition.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function type(terminal: MockProcess, data: string) {
	(terminal.stdin as any).emit("data", Buffer.from(data));
}

function makeSelect(document: Document): HTMLSelectElement {
	const select = document.createElement("select");
	select.innerHTML =
		`<option value="a">Alpha</option>` +
		`<option value="b" disabled>Beta</option>` +
		`<option value="c">Gamma ray</option>`;
	return select;
}

test("select renders the selected label and indicator, never the option list", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("Alpha");
	expect(output).toContain("▾");
	expect(output).not.toContain("Beta");
	expect(output).not.toContain("Gamma");

	dom.dispose();
});

test("the field is sized to the longest option label", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);
	await nextFrame(dom);

	// "Gamma ray" (9) + " ▾" (2)
	expect(select.getBoundingClientRect().width).toBe(11);

	dom.dispose();
});

test("arrows change the selection in place, skipping disabled options", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	const events: string[] = [];
	select.addEventListener("input", () => events.push("input"));
	select.addEventListener("change", () =>
		events.push(`change:${select.value}`),
	);
	select.focus();
	await nextFrame(dom);

	type(terminal, "\x1b[B"); // ArrowDown: skips disabled Beta, lands on Gamma
	await nextFrame(dom);
	expect(select.value).toBe("c");
	expect(events).toEqual(["input", "change:c"]);
	expect(terminal.getPlainText()).toContain("Gamma ray");

	type(terminal, "\x1b[B"); // ArrowDown at the end: stays
	await nextFrame(dom);
	expect(select.value).toBe("c");

	type(terminal, "\x1b[A"); // ArrowUp: back to Alpha
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).toContain("Alpha");

	dom.dispose();
});

test("a focused select underlines its field, like the rest of the family", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);
	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();

	select.focus();
	await nextFrame(dom);
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();

	dom.dispose();
});

test("select internals are closed: no shadowRoot, attachShadow throws", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);
	await nextFrame(dom);

	expect(select.shadowRoot).toBeNull();
	expect(() => select.attachShadow({mode: "open"})).toThrow();

	dom.dispose();
});

test("Space opens the picker in the top layer, over following content", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	const below = document.createElement("div");
	below.textContent = "content underneath the picker";
	document.body.appendChild(below);
	select.focus();
	await nextFrame(dom);

	type(terminal, " ");
	await nextFrame(dom);
	await nextFrame(dom);
	const rows = terminal.getPlainText().split("\n");
	// The picker's bordered list covers the row the content held.
	expect(rows[1]).toContain("┌");
	expect(rows[2]).toContain("Alpha");
	expect(rows[3]).toContain("Beta");
	expect(rows[4]).toContain("Gamma ray");
	expect(rows[1]).not.toContain("underneath");

	dom.dispose();
});

test("picker: arrows highlight without committing; Enter commits and closes", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	const events: string[] = [];
	select.addEventListener("change", () => events.push(select.value));
	select.focus();
	await nextFrame(dom);

	type(terminal, " ");
	await nextFrame(dom);
	type(terminal, "\x1b[B"); // highlight moves (skips disabled Beta)...
	await nextFrame(dom);
	expect(select.value).toBe("a"); // ...but nothing committed yet
	expect(events).toEqual([]);

	type(terminal, "\r"); // Enter commits Gamma and closes
	await nextFrame(dom);
	await nextFrame(dom);
	expect(select.value).toBe("c");
	expect(events).toEqual(["c"]);
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: Escape dismisses without changing the value", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);

	type(terminal, " ");
	await nextFrame(dom);
	type(terminal, "\x1b[B");
	await nextFrame(dom);
	type(terminal, "\x1b"); // Escape
	await nextFrame(dom);
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: blurring the select closes it", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);
	type(terminal, " ");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("┌");

	select.blur();
	await nextFrame(dom);
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});
