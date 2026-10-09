/**
 * The user-agent widgets past the form text controls: what a browser hides
 * (datalist, a closed dialog, a closed details), the disclosure a summary
 * opens, the bars progress and meter draw, and the chrome a fieldset puts
 * around its legend.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
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

/* ------------------------------------------------------- button inputs */

test("a button-type input draws its value, or its type's default label", async () => {
	const terminal = new MockProcess({rows: 4, cols: 60});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<input type=\"submit\">|<input type=\"submit\" value=\"Go\">|" +
		"<input type=\"reset\">|<input type=\"button\">|" +
		"<input type=\"button\" value=\"Next\">|<input type=\"image\" alt=\"Search\">|";
	await nextFrame(dom);

	expect(terminal.getVisibleText().split("\n")[0].trimEnd()).toBe(
		"[ Submit ]|[ Go ]|[ Reset ]|[  ]|[ Next ]|[ Search ]|",
	);
	const [submit] = dom.document.querySelectorAll("input");
	expect((submit as HTMLInputElement).value).toBe("");
	dom.dispose();
});

test("a button-type input redraws its label when its value changes", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<input id=\"a\" type=\"submit\">|<input id=\"b\" type=\"button\">|";
	await nextFrame(dom);

	dom.document.getElementById("a")!.setAttribute("value", "Send");
	(dom.document.getElementById("b") as HTMLInputElement).value = "Next";
	await nextFrame(dom);
	expect(terminal.getVisibleText().split("\n")[0].trimEnd()).toBe(
		"[ Send ]|[ Next ]|",
	);
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

test("toggling a details keeps its summary on its row, from a script or from the summary", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<div id=box style=\"height: 3em; overflow: auto\">" +
		"<p>one</p><p>two</p>" +
		"<details><summary>More</summary><p>a</p><p>b</p><p>c</p></details>" +
		"</div>";
	await nextFrame(dom);
	const box = document.getElementById("box")!;
	const details = document.querySelector("details") as HTMLDetailsElement;
	const summary = document.querySelector("summary") as HTMLElement;
	const row = () => summary.getBoundingClientRect().top;
	const before = row();

	details.open = true;
	await nextFrame(dom);
	await nextFrame(dom);
	expect([box.scrollTop, row()]).toEqual([0, before]);

	details.open = false;
	await nextFrame(dom);
	summary.click();
	await nextFrame(dom);
	await nextFrame(dom);
	expect([details.open, box.scrollTop, row()]).toEqual([true, 0, before]);

	dom.dispose();
});

test("a summary's disclosure marker is its ::marker, and list-style: none removes it", async () => {
	for (const [css, closed, open] of [
		["", "▸ More", "▾ Open"],
		["summary { list-style: none }", "More", "Open"],
		["summary::marker { color: red }", "▸ More", "▾ Open"],
	]) {
		const terminal = new MockProcess({rows: 6, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			`<style>${css}</style>` +
			"<details><summary>More</summary><p>x</p></details>" +
			"<details open><summary>Open</summary><p>body</p></details>";
		await nextFrame(dom);
		const lines = terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.trimEnd());
		expect(lines).toContain(closed);
		expect(lines).toContain(open);
		dom.dispose();
	}
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
	const getSgr = (): string => {
		const match = terminal.getStaticANSI().match(/38;2;(\d+);(\d+);(\d+)/);
		return match ? `${match[1]},${match[2]},${match[3]}` : "none";
	};
	// Above high, with the optimum above high: the good region.
	expect(getSgr()).toBe("95,175,95");
	// Between low and high: one region away from the optimum.
	meter.setAttribute("value", "5");
	await nextFrame(dom);
	expect(getSgr()).toBe("215,175,95");
	// Below low: two regions away.
	meter.setAttribute("value", "1");
	await nextFrame(dom);
	expect(getSgr()).toBe("215,95,95");

	dom.dispose();
});

test("a page's ::part() does not reach a gauge's insides", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>progress::part(bar) { color: #ff0000; }</style>" +
		"<progress max=\"10\" value=\"10\"></progress>";
	await nextFrame(dom);
	const ansi = terminal.getStaticANSI();
	expect(ansi).toContain("38;2;95;175;255");
	expect(ansi).not.toContain("38;2;255;0;0");
	dom.dispose();
});

test("a control's insides follow a change to what they inherit", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"color: #010203\"><input value=\"x\"></div>";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;1;2;3");
	dom.document.querySelector("div")!.style.color = "#040506";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;4;5;6");
	dom.dispose();
});

test("a progress bar's accent-color leaves its fill alone", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<progress style=\"accent-color: #00ff00\" max=\"10\" value=\"10\">" +
		"</progress>";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;95;175;255");
	dom.dispose();
});

async function gaugeANSI(html: string): Promise<string> {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const ansi = terminal.getStaticANSI();
	dom.dispose();
	return ansi;
}

test("a page colors a gauge through ::slider-fill and ::slider-track", async () => {
	const ansi = await gaugeANSI(
		"<style>" +
		"progress::slider-fill { color: #010203; }" +
		"progress::slider-track { color: #040506; }" +
		"</style>" +
		"<progress max=\"10\" value=\"5\"></progress>",
	);
	expect(ansi).toContain("38;2;1;2;3");
	expect(ansi).toContain("38;2;4;5;6");
	expect(ansi).not.toContain("38;2;95;175;255");
});

test("a meter's levels match :optimal-value, :low-value and :high-value", async () => {
	const ansi = await gaugeANSI(
		"<style>" +
		"meter:optimal-value::slider-fill { color: #000001; }" +
		"meter:low-value::slider-fill { color: #000002; }" +
		"meter:high-value::slider-fill { color: #000003; }" +
		"</style>" +
		"<meter low=\"3\" high=\"7\" optimum=\"5\" max=\"10\" value=\"5\"></meter>" +
		"<br><meter low=\"3\" high=\"7\" optimum=\"5\" max=\"10\" value=\"1\"></meter>" +
		"<br><meter low=\"3\" high=\"7\" optimum=\"5\" max=\"10\" value=\"9\"></meter>",
	);
	expect(ansi).toContain("38;2;0;0;1");
	expect(ansi).toContain("38;2;0;0;2");
	expect(ansi).toContain("38;2;0;0;3");
});

test("a meter's level pseudo-classes follow its attributes", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>meter:low-value::slider-fill { color: #000002; }</style>" +
		"<meter low=\"3\" high=\"7\" max=\"10\" value=\"5\"></meter>";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).not.toContain("38;2;0;0;2");
	expect(dom.document.querySelector("meter:low-value")).toBeNull();
	dom.document.querySelector("meter")!.setAttribute("low", "6");
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;0;0;2");
	expect(dom.document.querySelector("meter:low-value")).not.toBeNull();
	dom.dispose();
});

test("WebKit's and Firefox's gauge pseudo-elements are aliases", async () => {
	const webkit = await gaugeANSI(
		"<style>" +
		"progress::-webkit-progress-value { color: #000004; }" +
		"progress::-webkit-progress-bar { color: #000005; }" +
		"meter::-webkit-meter-optimum-value { color: #000006; }" +
		"meter::-webkit-meter-even-less-good-value { color: #000007; }" +
		"</style>" +
		"<progress max=\"10\" value=\"5\"></progress>" +
		"<br><meter low=\"3\" high=\"7\" optimum=\"9\" max=\"10\" value=\"9\"></meter>" +
		"<br><meter low=\"3\" high=\"7\" optimum=\"9\" max=\"10\" value=\"1\"></meter>",
	);
	for (const color of ["0;0;4", "0;0;5", "0;0;6", "0;0;7"]) {
		expect(webkit).toContain(`38;2;${color}`);
	}
	const firefox = await gaugeANSI(
		"<style>" +
		"progress::-moz-progress-bar { color: #000008; }" +
		"meter:-moz-meter-sub-optimum::-moz-meter-bar { color: #000009; }" +
		"</style>" +
		"<progress max=\"10\" value=\"5\"></progress>" +
		"<br><meter low=\"3\" high=\"7\" optimum=\"9\" max=\"10\" value=\"5\"></meter>",
	);
	expect(firefox).toContain("38;2;0;0;8");
	expect(firefox).toContain("38;2;0;0;9");
});

test("a page styles a select's icon through ::picker-icon", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>select::picker-icon { color: #040506; }</style>" +
		"<select><option>a</option></select>";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;4;5;6");
	dom.dispose();
});

test("a page restyles a details' ::details-content, and not a button's insides", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<style>" +
		"input::part(label)::before { content: \"< \"; }" +
		"details::details-content { padding-left: 2ch; }" +
		"</style>" +
		"<input type=\"button\" value=\"Go\">" +
		"<details open><summary>More</summary>inside</details>";
	await nextFrame(dom);
	const text = terminal.getPlainText();
	expect(text).toContain("[ Go ]");
	expect(text).toContain("\n  inside");
	dom.dispose();
});

test("a control's insides follow a change to what they inherit", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"color: #010203\"><input value=\"x\"></div>";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;1;2;3");
	dom.document.querySelector("div")!.style.color = "#040506";
	await nextFrame(dom);
	expect(terminal.getStaticANSI()).toContain("38;2;4;5;6");
	dom.dispose();
});

/* ------------------------------------------------------- range sliders */

async function mountSlider(
	html: string,
): Promise<{terminal: MockProcess; dom: TermDOM; input: HTMLInputElement}> {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;
	return {terminal, dom, input};
}

// The input and change events a slider fires, with the value each saw.
function recordEvents(input: HTMLInputElement): string[] {
	const events: string[] = [];
	for (const type of ["input", "change"]) {
		input.addEventListener(type, () => events.push(`${type} ${input.value}`));
	}
	return events;
}

test("a range input is a slider with its thumb at its value", async () => {
	const {terminal, dom} = await mountSlider(
		"<input type=\"range\">|<br>" +
		"<input type=\"range\" min=\"0\" max=\"10\" value=\"10\">|<br>" +
		"<input type=\"range\" value=\"0\">|",
	);
	expect(terminal.getPlainText().split("\n").slice(0, 3)).toEqual([
		"━━━━━━━━━━●─────────|",
		"━━━━━━━━━━━━━━━━━━━●|",
		"●───────────────────|",
	]);
	expect(terminal.getPlainText()).not.toContain("50");
	const input = dom.document.querySelector("input")!;
	input.setAttribute("max", "40");
	expect(input.value).toBe("40");
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0]).toBe("━━━━━━━━━━━━━━━━━━━●|");
	dom.dispose();
});

test("the keys move a slider's thumb and fire input then change", async () => {
	const {terminal, dom, input} = await mountSlider(
		"<input type=\"range\" min=\"0\" max=\"100\" step=\"5\" value=\"50\">",
	);
	const events = recordEvents(input);
	input.focus();
	await type(terminal, "\x1b[C");
	expect(input.value).toBe("55");
	await type(terminal, "\x1b[D\x1b[D");
	expect(input.value).toBe("45");
	await type(terminal, "\x1b[5~");
	expect(input.value).toBe("55");
	await type(terminal, "\x1b[6~");
	expect(input.value).toBe("45");
	await type(terminal, "\x1b[F");
	expect(input.value).toBe("100");
	await type(terminal, "\x1b[C");
	await type(terminal, "\x1b[H");
	expect(input.value).toBe("0");
	expect(events).toEqual([
		"input 55",
		"change 55",
		"input 50",
		"change 50",
		"input 45",
		"change 45",
		"input 55",
		"change 55",
		"input 45",
		"change 45",
		"input 100",
		"change 100",
		"input 0",
		"change 0",
	]);
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0]).toBe("●───────────────────");
	dom.dispose();
});

test("a press on a slider's track moves the thumb there and a drag carries it", async () => {
	const {terminal, dom, input} = await mountSlider(
		"<input type=\"range\" min=\"0\" max=\"19\" value=\"0\">",
	);
	const events = recordEvents(input);
	await type(terminal, "\x1b[<0;6;1M");
	expect(input.value).toBe("5");
	expect(dom.document.activeElement).toBe(input);
	await type(terminal, "\x1b[<32;11;1M");
	expect(input.value).toBe("10");
	await type(terminal, "\x1b[<32;40;1M");
	expect(input.value).toBe("19");
	await type(terminal, "\x1b[<0;40;1m");
	expect(events).toEqual(["input 5", "input 10", "input 19", "change 19"]);
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0]).toBe("━━━━━━━━━━━━━━━━━━━●");
	dom.dispose();
});

test("a canceled press leaves a slider where it was", async () => {
	const {terminal, dom, input} = await mountSlider(
		"<input type=\"range\" min=\"0\" max=\"19\" value=\"0\">",
	);
	input.addEventListener("mousedown", (event) => event.preventDefault());
	await type(terminal, "\x1b[<0;6;1M\x1b[<32;11;1M\x1b[<0;11;1m");
	expect(input.value).toBe("0");
	dom.dispose();
});

test("a page styles a slider through ::slider-track, ::slider-fill and ::slider-thumb", async () => {
	const ansi = await gaugeANSI(
		"<style>" +
		"input::slider-fill { color: #010203; }" +
		"input::slider-track { color: #040506; }" +
		"input::slider-thumb { color: #070809; }" +
		"</style>" +
		"<input type=\"range\">",
	);
	expect(ansi).toContain("38;2;1;2;3");
	expect(ansi).toContain("38;2;4;5;6");
	expect(ansi).toContain("38;2;7;8;9");
});

/* --------------------------------------------------- fieldset and legend */

test("a fieldset draws a border its legend interrupts", async () => {
	const terminal = new MockProcess({rows: 6, cols: 24});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<fieldset><legend>Legend</legend>field body</fieldset>";
	await nextFrame(dom);

	expect(terminal.getPlainText()).toBe(
		"┌─ Legend ─────────────┐\n" +
		"│ field body           │\n" +
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
