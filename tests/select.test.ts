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
