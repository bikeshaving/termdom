/**
 * position: fixed anchors to the VIEWPORT: the camera scrolls the document
 * underneath it, offsets resolve against the terminal's dimensions, and the
 * box never moves. The painter's camera-cancel and hit-testing's coordinate
 * conversion always assumed this; layout now provides it -- fixed boxes
 * hoist to the terminal-sized viewport root, not the document root.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils";

function makeTallDoc(dom: TermDOM): void {
	dom.document.body.innerHTML =
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%;background-color:#333\">STATUS" +
		"<span id=\"pct\" style=\"position:absolute;right:1ch;top:0\">42%</span></div>";
}

test("a fixed bottom bar sits on the viewport's last row, unscrolled", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	makeTallDoc(dom);
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	expect(rows[0]).toContain("row 0");
	dom.dispose();
});

test("the bar stays pinned while the camera scrolls", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	makeTallDoc(dom);
	await nextFrame(dom);

	dom.window.scrollBy(0, 12);
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	// An absolute box INSIDE the fixed subtree rides with it: fixed-space is
	// a property of the containing-block chain, not of the one element.
	expect(rows[9]).toContain("42%");
	expect(rows[0]).toContain("row 12");
	// The bar's rect is viewport-relative and scroll-invariant, per spec.
	const rect = dom.document.getElementById("bar")!.getBoundingClientRect();
	expect(rect.top).toBe(9);
	dom.dispose();
});

test("a fixed bar inside a scrolled fullscreen scroller stays on the last row", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	await pane.requestFullscreen();
	await nextFrame(dom);
	pane.scrollTop = 7;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("row 7");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

test("a fixed bar inside a plain scrolled scroller stays on the last row", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:6px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 4;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("row 4");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

test("a fixed box ignores scrollLeft on the scroller above it", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"width:20ch;overflow-x:auto;white-space:nowrap\">" +
		"<div style=\"width:60ch\">0123456789012345678901234567890123456789</div>" +
		"<div id=\"tag\" style=\"position:fixed;top:0;left:0\">TAG</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollLeft = 5;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0].startsWith("TAG")).toBe(true);
	const tag = dom.document.getElementById("tag")!;
	expect(tag.getBoundingClientRect().left).toBe(0);
	expect(dom.document.elementFromPoint(1, 0)).toBe(tag);
	dom.dispose();
});

test("an absolute box inside a fixed bar rides with it under a scroller", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:10px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS" +
		"<span id=\"pct\" style=\"position:absolute;right:1ch;top:0\">42%</span></div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 6;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	expect(rows[9]).toContain("42%");
	const pct = dom.document.getElementById("pct")!;
	expect(pct.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(37, 9)).toBe(pct);
	dom.dispose();
});

test("a fixed box under nested scrollers ignores both", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"outer\" style=\"height:8px;overflow-y:auto\">" +
		"<div>outer top</div>" +
		"<div id=\"inner\" style=\"height:5px;overflow-y:auto\">" +
		Array.from({length: 20}, (_, i) => `<div>inner ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>" +
		Array.from({length: 20}, (_, i) => `<div>outer ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("outer")!.scrollTop = 1;
	dom.document.getElementById("inner")!.scrollTop = 3;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("inner 3");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

test("a fixed box that scrolls still moves its own content", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:10px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"panel\" style=\"position:fixed;top:0;left:0;width:100%;height:3px;overflow-y:auto\">" +
		Array.from({length: 8}, (_, i) => `<div>line ${i}</div>`).join("") +
		"</div>" +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 5;
	dom.document.getElementById("panel")!.scrollTop = 2;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("line 2");
	expect(rows[2]).toContain("line 4");
	expect(rows[3]).toContain("row 8");
	expect(dom.document.elementFromPoint(2, 1)!.textContent).toBe("line 3");
	dom.dispose();
});

test("a fixed bar under a scroller stays put while the camera scrolls too", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		Array.from({length: 5}, (_, i) => `<div>lead ${i}</div>`).join("") +
		"<div id=\"pane\" style=\"height:6px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>" +
		Array.from({length: 20}, (_, i) => `<div>tail ${i}</div>`).join("");
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 3;
	dom.window.scrollBy(0, 4);
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("lead 4");
	expect(rows[1]).toContain("row 3");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

// A vim-style page: the document scrolls between a fixed header and a
// fixed status bar, which the terminal's scroll margins leave in place.
test("a document scroll shifts only the rows between full-width fixed bars", async () => {
	const html =
		"<div style=\"position:fixed;top:0;left:0;right:0;background:#036\">HEAD</div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div style=\"position:fixed;bottom:0;left:0;right:0;background:#333\">FOOT</div>";
	const terminal = new MockProcess({cols: 40, rows: 10});
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const before = written().length;
	dom.window.scrollBy(0, 3);
	await nextFrame(dom);
	const frame = written().slice(before);
	expect(frame).toContain("\x1b[2;9r");
	expect(frame).not.toContain("HEAD");
	expect(frame).not.toContain("FOOT");

	const fresh = new MockProcess({cols: 40, rows: 10});
	const again = new TermDOM({transport: fresh.transport});
	await again.attach();
	again.document.body.innerHTML = html;
	again.window.scrollBy(0, 3);
	await nextFrame(again);
	expect(terminal.getStaticANSI()).toBe(fresh.getStaticANSI());
	dom.dispose();
	again.dispose();
});

// A mail client draws each message below header lines it vouches for.
// The message must not be able to paint a fixed box over them.
const HEADERS = "<div>From: alice</div><div>Checked: pass</div>";
const FAKE = Array.from({length: 5}, () => "<div>XXXXXXXXXXXXXXXXXXXX</div>")
	.join("");

test("contain: paint holds a fixed box at its corner and clips it", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		HEADERS +
		"<div id=\"host\" style=\"contain:paint;position:relative;margin-left:4ch;" +
		"width:12ch;height:5px;border:1px solid\">" +
		"<div id=\"fake\" style=\"position:fixed;top:0;left:0;width:20ch\">" +
		FAKE +
		"</div></div><div>after</div>";
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("From: alice");
	expect(rows[1]).toContain("Checked: pass");
	expect(rows[3].slice(0, 16)).toBe("    │XXXXXXXXXX│");
	expect(rows[5].slice(0, 16)).toBe("    │XXXXXXXXXX│");
	expect(rows[6]).not.toContain("X");
	expect(rows[7]).toContain("after");
	const fake = dom.document.getElementById("fake")!;
	const rect = fake.getBoundingClientRect();
	expect(rect.left).toBe(5);
	expect(rect.top).toBe(3);
	expect(fake.offsetParent).toBe(dom.document.getElementById("host"));
	expect(dom.window.getComputedStyle(fake).top).toBe("0px");
	dom.dispose();
});

test("contain: paint on a shadow host holds a fixed box in its shadow tree", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		HEADERS +
		"<mail-view style=\"display:block;contain:paint;position:relative;" +
		"margin-left:4ch;width:12ch;height:3px\"></mail-view><div>after</div>";
	const view = dom.document.querySelector("mail-view")!;
	view.attachShadow({mode: "open"}).innerHTML =
		"<div id=\"fake\" style=\"position:fixed;top:0;left:0;width:20ch\">" +
		FAKE +
		"</div>";
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("From: alice");
	expect(rows[1]).toContain("Checked: pass");
	expect(rows[2].slice(0, 16)).toBe("    XXXXXXXXXXXX");
	expect(rows[4].slice(0, 16)).toBe("    XXXXXXXXXXXX");
	expect(rows[5]).toContain("after");
	expect(rows[5]).not.toContain("X");
	const fake = view.shadowRoot!.getElementById("fake")!;
	expect(fake.getBoundingClientRect().top).toBe(2);
	expect(fake.getBoundingClientRect().left).toBe(4);
	dom.dispose();
});

for (const style of [
	"contain:layout",
	"transform:translate(0)",
	"filter:opacity(1)",
	"will-change:transform",
]) {
	test(`${style} gives a fixed box a containing block`, async () => {
		const terminal = new MockProcess({cols: 30, rows: 10});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			HEADERS +
			`<div id="host" style="${style};margin-left:4ch;width:12ch;height:3px">` +
			"<div id=\"fake\" style=\"position:fixed;top:1px;left:2ch\">FAKE</div>" +
			"</div>";
		await nextFrame(dom);
		const rows = terminal.getVisibleText().split("\n");
		expect(rows[0]).toContain("From: alice");
		expect(rows[1]).toContain("Checked: pass");
		expect(rows[3].slice(0, 10)).toBe("      FAKE");
		const fake = dom.document.getElementById("fake")!;
		expect(fake.getBoundingClientRect().top).toBe(3);
		expect(fake.getBoundingClientRect().left).toBe(6);
		expect(fake.offsetParent).toBe(dom.document.getElementById("host"));
		dom.dispose();
	});
}

test("a transform gives an absolute box a containing block without position", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"position:relative\"><div>top</div>" +
		"<div id=\"host\" style=\"transform:translate(0);margin-left:4ch\">" +
		"<div id=\"abs\" style=\"position:absolute;top:0;left:1ch\">ABS</div>host" +
		"</div></div>";
	await nextFrame(dom);
	const abs = dom.document.getElementById("abs")!;
	expect(abs.getBoundingClientRect().top).toBe(1);
	expect(abs.getBoundingClientRect().left).toBe(5);
	expect(abs.offsetParent).toBe(dom.document.getElementById("host"));
	dom.dispose();
});

test("without containment a fixed box still takes the viewport", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		HEADERS +
		"<div style=\"position:relative;margin-left:4ch;width:12ch;height:3px;" +
		"overflow:hidden\">" +
		"<div id=\"fake\" style=\"position:fixed;top:0;left:0\">FAKE</div></div>";
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0].startsWith("FAKE")).toBe(true);
	const fake = dom.document.getElementById("fake")!;
	expect(fake.getBoundingClientRect().top).toBe(0);
	expect(fake.getBoundingClientRect().left).toBe(0);
	expect(fake.offsetParent).toBe(null);
	dom.dispose();
});

test("a fixed box follows its containing block in and out", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		HEADERS +
		"<div id=\"host\" style=\"margin-left:4ch;width:12ch;height:3px\">" +
		"<div id=\"fake\" style=\"position:fixed;top:0;left:0\">FAKE</div></div>";
	await nextFrame(dom);
	const host = dom.document.getElementById("host")!;
	const fake = dom.document.getElementById("fake")!;
	expect(fake.getBoundingClientRect().top).toBe(0);
	host.style.contain = "paint";
	await nextFrame(dom);
	expect(fake.getBoundingClientRect().top).toBe(2);
	expect(fake.getBoundingClientRect().left).toBe(4);
	expect(terminal.getVisibleText().split("\n")[0]).toContain("From: alice");
	host.style.contain = "";
	await nextFrame(dom);
	expect(fake.getBoundingClientRect().top).toBe(0);
	expect(terminal.getVisibleText().split("\n")[0].startsWith("FAKE")).toBe(
		true,
	);
	dom.dispose();
});

test("a contained fixed box scrolls with the document", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		HEADERS +
		"<div style=\"contain:paint\">" +
		"<div id=\"fake\" style=\"position:fixed;top:0;left:0\">FAKE</div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	dom.window.scrollBy(0, 1);
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Checked: pass");
	expect(rows[1].startsWith("FAKE")).toBe(true);
	expect(dom.document.getElementById("fake")!.getBoundingClientRect().top)
		.toBe(1);
	dom.dispose();
});

test("contain: paint clips content that overflows it", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"contain:paint;width:6ch;height:2px;white-space:nowrap\">" +
		"<div>line 0 is long</div><div>line 1</div><div>line 2</div>" +
		"<div>line 3</div></div><div>after</div>";
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0].trimEnd()).toBe("line 0");
	expect(rows[1].trimEnd()).toBe("line 1");
	expect(rows[2].trimEnd()).toBe("after");
	expect(terminal.getVisibleText()).not.toContain("line 2");
	dom.dispose();
});
