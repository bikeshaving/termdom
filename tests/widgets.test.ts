/**
 * The user-agent widgets past the form text controls: what a browser hides
 * (datalist, a closed dialog, a closed details), the disclosure a summary
 * opens, the bars progress and meter draw, and the chrome a fieldset puts
 * around its legend.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * The terminal text, once a repaint no test asked for has drawn a mark into
 * it. The wait is the mark's arrival, not a clock a loaded machine can
 * outrun; a mark that never arrives times out and the caller asserts on the
 * text as it stands. Nothing here requests a frame, which is the contract
 * the callers are testing.
 */
async function paintedText(
	terminal: MockProcess,
	mark: string,
): Promise<string> {
	const deadline = Date.now() + 5000;
	let text = terminal.getPlainText();
	while (!text.includes(mark) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1));
		text = terminal.getPlainText();
	}
	return text;
}

function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------- hidden content */

test("a hidden input is display: none, not a painter skip", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"before<input type=\"hidden\" value=\"secret\">after";
	await nextFrame(dom);

	// display: none generates no box, so the neighbours meet.
	expect(terminal.getPlainText()).toContain("beforeafter");
	expect(terminal.getPlainText()).not.toContain("secret");
	const input = dom.document.querySelector("input")!;
	expect(dom.window.getComputedStyle(input).display).toEqual("none");

	dom.dispose();
});

test("a datalist never renders its options", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<datalist id=\"suggestions\"><option>sugg</option></datalist>" +
		"<p>after</p>";
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
	document.body.innerHTML = "<dialog>dialog content</dialog>";
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
	dom.document.body.innerHTML = "<details><summary>More</summary><p>secret</p></details>";
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("More");
	expect(output).not.toContain("secret");

	dom.dispose();
});

test("an open details shows its body", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<details open><summary>More</summary><p>secret</p></details>";
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("More");
	expect(output).toContain("secret");

	dom.dispose();
});

test("a closed details hides a bare text child", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	// No light-tree selector reaches a text node: the child hides by
	// projecting into the UA shadow tree's content container.
	document.body.innerHTML = "<details><summary>More</summary>secret</details>";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("More");
	expect(terminal.getPlainText()).not.toContain("secret");

	const details = document.querySelector("details") as HTMLDetailsElement;
	details.setAttribute("open", "");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("secret");

	details.removeAttribute("open");
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("secret");

	dom.dispose();
});

test("only the first summary stays visible in a closed details", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	// Only the FIRST summary is the disclosure's caption; a second one is
	// ordinary content, hidden while closed (browser parity).
	document.body.innerHTML =
		"<details><summary>First</summary><summary>Second</summary></details>";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("First");
	expect(terminal.getPlainText()).not.toContain("Second");

	const details = document.querySelector("details") as HTMLDetailsElement;
	details.setAttribute("open", "");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("Second");

	dom.dispose();
});

test("children added to a live details slot into the right place", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<details><summary>More</summary></details>";
	await nextFrame(dom);

	const details = document.querySelector("details") as HTMLDetailsElement;
	details.appendChild(document.createTextNode("late text"));
	const paragraph = document.createElement("p");
	paragraph.textContent = "late element";
	details.appendChild(paragraph);
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("late text");
	expect(terminal.getPlainText()).not.toContain("late element");

	details.setAttribute("open", "");
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("late text");
	expect(terminal.getPlainText()).toContain("late element");

	dom.dispose();
});

/* ------------------------------------------------------ details/summary */

test("the disclosure marker follows the open state", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<details><summary>More</summary><p>body</p></details>";
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
	document.body.innerHTML = "<details><summary>More</summary><p>secret</p></details>";
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
	document.body.innerHTML = "<details><summary>More</summary><p>secret</p></details>";
	await nextFrame(dom);

	(document.querySelector("summary") as HTMLElement).focus();
	await type(terminal, "\r");
	const details = document.querySelector("details") as HTMLDetailsElement;
	expect(details.hasAttribute("open")).toBe(true);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("secret");

	dom.dispose();
});

/* ------------------------------------------------------------ the keycap */

/** The cell at a screen position, for reading its attributes. */
function cellAt(terminal: MockProcess, row: number, col: number): any {
	return (terminal as any).terminal.buffer.active.getLine(row).getCell(col);
}

test("a kbd is bold and underlined, the accelerator convention", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<kbd>q</kbd>uit";
	await nextFrame(dom);

	// The mark is a decoration, not generated content: no cells are added.
	expect(terminal.getPlainText()).toContain("quit");
	expect(terminal.getPlainText()).not.toContain("[");
	expect(cellAt(terminal, 0, 0).isBold()).toBeTruthy();
	expect(cellAt(terminal, 0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(terminal, 0, 1).isBold()).toBeFalsy();
	expect(cellAt(terminal, 0, 1).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("author rules restyle the keycap", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>" +
		"kbd { font-weight: normal; text-decoration: none; }" +
		"kbd::before { content: \"<\"; }" +
		"kbd::after { content: \">\"; }" +
		"</style>" +
		"<kbd>x</kbd>";
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("<x>");
	expect(cellAt(terminal, 0, 1).isBold()).toBeFalsy();
	expect(cellAt(terminal, 0, 1).isUnderline()).toBeFalsy();

	dom.dispose();
});

/* ---------------------------------------------------------- the gauges */

/** The row a gauge drew, trimmed of the screen's padding. */
function bar(terminal: MockProcess): string {
	return terminal.getPlainText().split("\n")[0].trimEnd();
}

test("a progress bar fills its track from value and max", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<progress value=\"4\" max=\"10\"></progress>";
	await nextFrame(dom);

	expect(bar(terminal)).toBe("████░░░░░░");

	dom.dispose();
});

test("a progress bar follows its value", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<progress value=\"0\" max=\"10\"></progress>";
	await nextFrame(dom);
	expect(bar(terminal)).toBe("░░░░░░░░░░");

	(document.querySelector("progress") as HTMLProgressElement).value = 10;
	await nextFrame(dom);
	expect(bar(terminal)).toBe("██████████");

	dom.dispose();
});

test("a progress bar with no value is an empty groove", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<progress></progress>";
	await nextFrame(dom);

	expect(bar(terminal)).toBe("░░░░░░░░░░");

	dom.dispose();
});

test("a gauge takes the width its author gives it", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>progress { width: 20ch; }</style>" +
		"<progress value=\"1\" max=\"4\"></progress>";
	await nextFrame(dom);

	expect(bar(terminal)).toBe("█████░░░░░░░░░░░░░░░");

	dom.dispose();
});

test("a meter fills between its min and max", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<meter min=\"10\" max=\"20\" value=\"15\"></meter>";
	await nextFrame(dom);

	expect(bar(terminal)).toBe("█████░░░░░");

	dom.dispose();
});

test("a meter's level reads its value against low, high and optimum", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<meter min=\"0\" max=\"10\" low=\"3\" high=\"7\" optimum=\"9\" value=\"9\"></meter>";
	await nextFrame(dom);

	const meter = document.querySelector("meter") as HTMLMeterElement;
	// Each level names its own colour in the UA sheet, so the reading has to
	// be the SGR itself. Asserting only that the three frames DIFFER proves
	// nothing: the bar fills proportionally, so 9, 5 and 1 already differ by
	// fill length whatever colour they are painted in.
	const sgrOf = (): string => {
		const match = terminal.getStaticANSI().match(/38;2;(\d+);(\d+);(\d+)/);
		return match ? `${match[1]},${match[2]},${match[3]}` : "none";
	};
	// Above high, with the optimum above high: the good region.
	expect(sgrOf()).toBe("95,175,95");
	// Between low and high: one region away from the optimum.
	meter.setAttribute("value", "5");
	await nextFrame(dom);
	expect(sgrOf()).toBe("215,175,95");
	// Below low: two regions away.
	meter.setAttribute("value", "1");
	await nextFrame(dom);
	expect(sgrOf()).toBe("215,95,95");

	dom.dispose();
});

/* --------------------------------------------------- fieldset and legend */

test("a fieldset draws a border its legend interrupts", async () => {
	const terminal = new MockProcess({rows: 6, cols: 24});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<fieldset><legend>Legend</legend>textControl body</fieldset>";
	await nextFrame(dom);

	expect(terminal.getPlainText()).toBe(
		"┌─ Legend ─────────────┐\n" +
		"│ textControl body           │\n" +
		"└──────────────────────┘\n",
	);

	dom.dispose();
});

test("a fieldset's blocks stack under the legend", async () => {
	const terminal = new MockProcess({rows: 6, cols: 24});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<fieldset><legend>Group</legend><div>one</div><div>two</div></fieldset>";
	await nextFrame(dom);

	expect(terminal.getPlainText()).toBe(
		"┌─ Group ──────────────┐\n" +
		"│ one                  │\n" +
		"│ two                  │\n" +
		"└──────────────────────┘\n",
	);

	dom.dispose();
});

test("Tab reaches a summary", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<details><summary>More</summary><p>secret</p></details>";
	await nextFrame(dom);

	await type(terminal, "\t");
	expect(document.activeElement?.tagName).toBe("SUMMARY");

	dom.dispose();
});

test("a checkedness that changes on its own repaints, and unchecks its group", async () => {
	// Setting .checked fires no event and mutates no attribute, so nothing
	// would schedule a frame if the glyph were only read at paint time: the
	// control writes its mark where the state moves, and that write is the
	// mutation the frame follows.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML =
		"<input type=\"checkbox\" id=\"c\">" +
		"<input type=\"radio\" name=\"g\" id=\"r1\"><input type=\"radio\" name=\"g\" id=\"r2\">";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("[ ]");

	const box = dom.document.getElementById("c") as HTMLInputElement;
	box.checked = true;
	// No frame is requested here: the repaint has to be the mutation's own.
	expect(await paintedText(terminal, "[x]")).toContain("[x]");

	const first = dom.document.getElementById("r1") as HTMLInputElement;
	const second = dom.document.getElementById("r2") as HTMLInputElement;
	second.checked = true;
	// The sibling the group unchecked shows it, with no event to have hooked.
	expect(await paintedText(terminal, "( )(x)")).toContain("( )(x)");
	expect(second.checked).toBe(true);
	expect(first.checked).toBe(false);

	dom.dispose();
});
