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

function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);

	// "Gamma ray" (9) + " ▾" (2)
	expect(select.getBoundingClientRect().width).toBe(11);

	dom.dispose();
});

test("arrows change the selection in place, skipping disabled options", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
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

	await type(terminal, "\x1b[B"); // ArrowDown: skips disabled Beta, lands on Gamma
	await nextFrame(dom);
	expect(select.value).toBe("c");
	expect(events).toEqual(["input", "change:c"]);
	expect(terminal.getPlainText()).toContain("Gamma ray");

	await type(terminal, "\x1b[B"); // ArrowDown at the end: stays
	await nextFrame(dom);
	expect(select.value).toBe("c");

	await type(terminal, "\x1b[A"); // ArrowUp: back to Alpha
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).toContain("Alpha");

	dom.dispose();
});

test("a focused select underlines its field, like the rest of the family", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);

	expect(select.shadowRoot).toBeNull();
	expect(() => select.attachShadow({mode: "open"})).toThrow();

	dom.dispose();
});

test("Space opens the picker in the top layer, over following content", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	const below = document.createElement("div");
	below.textContent = "content underneath the picker";
	document.body.appendChild(below);
	select.focus();
	await nextFrame(dom);

	await type(terminal, " ");
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
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	const events: string[] = [];
	select.addEventListener("change", () => events.push(select.value));
	select.focus();
	await nextFrame(dom);

	await type(terminal, " ");
	await nextFrame(dom);
	await type(terminal, "\x1b[B"); // highlight moves (skips disabled Beta)...
	await nextFrame(dom);
	expect(select.value).toBe("a"); // ...but nothing committed yet
	expect(events).toEqual([]);

	await type(terminal, "\r"); // Enter commits Gamma and closes
	await nextFrame(dom);
	expect(select.value).toBe("c");
	expect(events).toEqual(["c"]);
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: Escape dismisses without changing the value", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);

	await type(terminal, " ");
	await nextFrame(dom);
	await type(terminal, "\x1b[B");
	await nextFrame(dom);
	await type(terminal, "\x1b"); // Escape
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: blurring the select closes it", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);
	await type(terminal, " ");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("┌");

	select.blur();
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

function click(terminal: MockProcess, col: number, row: number): Promise<void> {
	return type(terminal, `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`);
}

test("picker: clicking the closed select opens it", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);

	await click(terminal, 2, 1);
	await nextFrame(dom);
	const output = terminal.getPlainText();
	expect(output).toContain("┌");
	expect(output).toContain("Gamma ray");

	dom.dispose();
});

test("picker: clicking an option row commits it, fires change, and closes", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	let changed = "";
	select.addEventListener("change", () => (changed = select.value));
	await nextFrame(dom);

	await click(terminal, 2, 1);
	await nextFrame(dom);
	// Rows: 1 field, 2 border, 3 Alpha, 4 Beta, 5 Gamma ray, 6 border.
	await click(terminal, 3, 5);
	await nextFrame(dom);

	expect(select.value).toBe("c");
	expect(changed).toBe("c");
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: a disabled row is inert; clicking the face again dismisses", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);

	await click(terminal, 2, 1);
	await nextFrame(dom);
	await click(terminal, 3, 4); // Beta, disabled -- no commit, stays open
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).toContain("┌");

	await click(terminal, 2, 1); // the closed face -- dismiss without change
	await nextFrame(dom);
	expect(select.value).toBe("a");
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("picker: the highlighted row is inverse video, the rest carry no underline", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);
	await type(terminal, " "); // open at Alpha
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// Rows: 0 field, 1 border, 2 Alpha (highlighted), 3 Beta, 4 Gamma ray.
	// The highlighted row paints SGR inverse -- the Highlight/HighlightText
	// UA pair -- across the row, not just under the label.
	expect(cellAt(2, 1).isInverse()).toBeTruthy();
	expect(cellAt(2, 6).isInverse()).toBeTruthy(); // past "Alpha": still the row
	// Unhighlighted rows are clean: the host's focus underline must not
	// inherit into the sheet.
	expect(cellAt(3, 1).isInverse()).toBeFalsy();
	expect(cellAt(3, 1).isUnderline()).toBeFalsy();
	expect(cellAt(4, 1).isUnderline()).toBeFalsy();

	dom.dispose();
});

function makeGroupedSelect(document: Document): HTMLSelectElement {
	const select = document.createElement("select");
	select.innerHTML =
		`<option value="none">None</option>` +
		`<optgroup label="Fruit">` +
		`<option value="apple">Apple</option>` +
		`<option value="pear" disabled>Pear</option>` +
		`</optgroup>` +
		`<optgroup label="Off" disabled>` +
		`<option value="rock">Rock</option>` +
		`</optgroup>`;
	return select;
}

test("picker: a group is a heading with its options indented beneath it", async () => {
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeGroupedSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);
	await type(terminal, " ");
	await nextFrame(dom);

	const rows = terminal.getPlainText().split("\n");
	// Row 0 is the field, row 1 the picker's top border.
	expect(rows[2]).toContain("None");
	expect(rows[3]).toContain("Fruit");
	expect(rows[4]).toContain("  Apple");
	expect(rows[5]).toContain("  Pear");
	expect(rows[6]).toContain("Off");
	expect(rows[7]).toContain("  Rock");

	dom.dispose();
});

test("picker: a heading cannot be picked, and a disabled group is inert", async () => {
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeGroupedSelect(document);
	document.body.appendChild(select);
	await nextFrame(dom);

	await click(terminal, 2, 1); // open
	await nextFrame(dom);
	await click(terminal, 3, 4); // the "Fruit" heading: not an option
	await nextFrame(dom);
	expect(select.value).toBe("none");
	expect(terminal.getPlainText()).toContain("┌");

	await click(terminal, 3, 8); // "Rock", inside the disabled group
	await nextFrame(dom);
	expect(select.value).toBe("none");
	expect(terminal.getPlainText()).toContain("┌");

	await click(terminal, 3, 5); // "Apple"
	await nextFrame(dom);
	expect(select.value).toBe("apple");
	expect(terminal.getPlainText()).not.toContain("┌");

	dom.dispose();
});

test("arrows skip a disabled group's options", async () => {
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const select = makeGroupedSelect(document);
	document.body.appendChild(select);
	select.focus();
	await nextFrame(dom);

	await type(terminal, "\x1b[B"); // None -> Apple
	await nextFrame(dom);
	expect(select.value).toBe("apple");

	await type(terminal, "\x1b[B"); // Pear disabled, Rock's group disabled: stays
	await nextFrame(dom);
	expect(select.value).toBe("apple");

	dom.dispose();
});

test("selectedOptions is live over the selection, not just over the tree", async () => {
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	// Detached: no UA tree reconciles behind a selection change, so nothing
	// but the selectedness itself moves what the collection revalidates on.
	const select = document.createElement("select");
	const options = ["a", "b", "c"].map((value) => {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
		return option;
	});

	const selected = select.selectedOptions;
	expect(Array.from(selected).map((o: any) => o.value)).toEqual(["a"]);

	select.value = "c";
	expect(Array.from(selected).map((o: any) => o.value)).toEqual(["c"]);

	select.selectedIndex = 1;
	expect(Array.from(selected).map((o: any) => o.value)).toEqual(["b"]);

	(options[2] as any).selected = true;
	expect(Array.from(selected).map((o: any) => o.value)).toEqual(["c"]);

	dom.dispose();
});
