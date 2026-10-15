/**
 * A frame repaints only the rows that changed, and every way a page can
 * change has to name its rows. Each test makes one change after a first
 * frame and holds the result to two oracles: the partial-frame check,
 * which paints the frame whole beside it, and the terminal itself, whose
 * screen must not change when the page is then repainted from scratch.
 * The tests also count the frames the check compared, so a change that
 * repaints whole cannot pass for one that repaints rows.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {invalidate, repaintAll} from "../src/internal/framebuffer.ts";
import {partialFrameCheck} from "../src/internal/painter.ts";
import {_} from "../src/internal/slots.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

async function repaint(
	html: string,
	change: (document: any, window: any) => void | Promise<void>,
	{head = "", cols = 40, rows = 12} = {},
): Promise<{partial: number; terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	if (head) {
		dom.document.head.innerHTML = head;
	}
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	await nextFrame(dom);
	const before = partialFrameCheck.checked;
	await change(dom.document, dom.window);
	await nextFrame(dom);
	const partial = partialFrameCheck.checked - before;

	const shown = terminal.getScreenContents();
	const slots = _(dom as any) as any;
	repaintAll(slots.framebuffer);
	invalidate(slots.framebuffer);
	await nextFrame(dom);
	expect(shown).toBe(terminal.getScreenContents());
	return {partial, terminal, dom};
}

const lines = (count: number, prefix = "line") =>
	Array.from({length: count}, (_, i) => `<p>${prefix} ${i}</p>`).join("");

test("a z-index swap repaints the boxes it reorders", async () => {
	const {partial, dom} = await repaint(
		lines(3) +
			"<div id=a style=\"position: absolute; top: 5px; left: 2px; " +
			"z-index: 1; background: red\">aaaa</div>" +
			"<div id=b style=\"position: absolute; top: 5px; left: 4px; " +
			"z-index: 2; background: blue\">bbbb</div>",
		(document) => {
			document.getElementById("a").style.zIndex = "3";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("visibility hides a word in place", async () => {
	const {partial, dom} = await repaint(
		lines(4) + "<p>keep <span id=s>this</span> word</p>",
		(document) => {
			document.getElementById("s").style.visibility = "hidden";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("an outline drawn outside its box repaints the rows it reaches", async () => {
	const {partial, dom} = await repaint(
		lines(3) + "<div id=d style=\"margin: 2px 4px\">boxed</div>" + lines(3),
		(document) => {
			const d = document.getElementById("d");
			d.style.outline = "1px solid";
			d.style.outlineOffset = "1px";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("an inherited color reaches every descendant's rows", async () => {
	const {partial, dom} = await repaint(
		lines(2) + "<div id=d><p>one <b>two</b></p><p>three</p></div>",
		(document) => {
			document.getElementById("d").style.color = "rgb(0, 128, 0)";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a custom property on the root recolors text deep below it", async () => {
	const {dom} = await repaint(
		lines(2) + "<div><p><span class=c>deep</span></p></div>",
		(document) => {
			document.documentElement.style.setProperty("--c", "rgb(255, 0, 0)");
		},
		{
			head: "<style>:root { --c: rgb(0, 0, 255) } .c { color: var(--c) }</style>",
		},
	);
	dom.dispose();
});

test("an ordered list renumbers below an item taken out", async () => {
	const {dom} = await repaint(
		"<ol>" +
		Array.from({length: 5}, (_, i) => `<li id=i${i}>item</li>`).join("") +
		"</ol>",
		(document) => {
			document.getElementById("i1").remove();
		},
	);
	dom.dispose();
});

test("an ordered list renumbers when its start changes", async () => {
	const {dom} = await repaint(
		"<ol id=o><li>a</li><li>b</li><li>c</li></ol>",
		(document) => {
			document.getElementById("o").setAttribute("start", "7");
		},
	);
	dom.dispose();
});

test("generated content follows the attribute it reads", async () => {
	const {dom} = await repaint(
		lines(2) + "<p id=p data-n=\"1\">count</p>",
		(document) => {
			document.getElementById("p").setAttribute("data-n", "2");
		},
		{head: "<style>#p::before { content: attr(data-n) \" \" }</style>"},
	);
	dom.dispose();
});

test("text edited to the same length repaints its row", async () => {
	const {partial, dom} = await repaint(
		lines(3) + "<p id=p>abcdef</p>" + lines(3),
		(document) => {
			document.getElementById("p").firstChild.data = "uvwxyz";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("an input's value set by property repaints the field", async () => {
	const {dom} = await repaint(
		lines(2) + "<input id=i value=old>",
		(document) => {
			document.getElementById("i").value = "new value";
		},
	);
	dom.dispose();
});

test("the last child leaving a box of fixed height clears its rows", async () => {
	const {partial, dom} = await repaint(
		"<div style=\"height: 6px\"><p>first</p><p id=last>last</p></div>" +
			lines(2),
		(document) => {
			document.getElementById("last").remove();
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a plain box hidden with display: none clears its text", async () => {
	const {partial, dom} = await repaint(
		lines(2) + "<div id=d><p>gone</p><p>soon</p></div>" + lines(2),
		(document) => {
			document.getElementById("d").style.display = "none";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a border removed beside another unjoins their corners", async () => {
	const {partial, dom} = await repaint(
		lines(2) +
			"<div style=\"display: flex\"><div id=a style=\"border: 1px solid\">" +
			"a</div><div style=\"border: 1px solid\">b</div></div>" +
		lines(2),
		(document) => {
			document.getElementById("a").style.border = "none";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a selection made from script highlights, then collapses", async () => {
	const {dom} = await repaint(
		lines(2) + "<p id=p>select these words</p>" + lines(2),
		async (document, window) => {
			const range = document.createRange();
			range.setStart(document.getElementById("p").firstChild, 7);
			range.setEnd(document.getElementById("p").firstChild, 12);
			window.getSelection().addRange(range);
		},
	);
	dom.dispose();
});

test("a highlight registered and removed repaints its text", async () => {
	const {dom} = await repaint(
		lines(2) + "<p id=p>highlight me</p>",
		(document, window) => {
			const range = document.createRange();
			range.selectNodeContents(document.getElementById("p"));
			window.CSS.highlights.set("mark", new window.Highlight(range));
		},
		{head: "<style>::highlight(mark) { background-color: yellow }</style>"},
	);
	dom.dispose();
});

test("a canvas drawn on repaints its cells", async () => {
	const {dom} = await repaint(
		lines(2) + "<canvas id=c width=80 height=48></canvas>",
		(document) => {
			const ctx = document.getElementById("c").getContext("2d");
			ctx.fillStyle = "red";
			ctx.fillRect(0, 0, 40, 24);
		},
	);
	dom.dispose();
});

test("a table cell's background repaints the cell", async () => {
	const {partial, dom} = await repaint(
		lines(2) + "<table><tr><td id=c>a</td><td>b</td></tr></table>",
		(document) => {
			document.getElementById("c").style.background = "blue";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("an inline-block's text changes inside its line", async () => {
	const {partial, dom} = await repaint(
		lines(2) +
		"<p>before <span id=s style=\"display: inline-block; " +
			"border: 1px solid\">box</span> after</p>",
		(document) => {
			document.getElementById("s").firstChild.data = "bix";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("text-align moves a block's lines without moving the block", async () => {
	const {partial, dom} = await repaint(
		lines(2) + "<p id=p>centered later</p>" + lines(2),
		(document) => {
			document.getElementById("p").style.textAlign = "center";
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a class that bolds a word repaints its row", async () => {
	const {partial, dom} = await repaint(
		lines(3) + "<p>one <span id=s>two</span> three</p>",
		(document) => {
			document.getElementById("s").className = "b";
		},
		{head: "<style>.b { font-weight: bold }</style>"},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a fixed bar changes while the document is scrolled", async () => {
	const {dom} = await repaint(
		"<div id=bar style=\"position: fixed; top: 0; left: 0; " +
			"background: navy\">bar one</div>" +
		lines(40),
		async (document, window) => {
			window.scrollTo(0, 10);
			await nextFrame({window, document});
			document.getElementById("bar").firstChild.data = "bar two";
		},
	);
	dom.dispose();
});

test("a sticky header in a scrolled box keeps its place", async () => {
	const {dom} = await repaint(
		"<div id=s style=\"height: 6px; overflow: auto\">" +
			"<div style=\"position: sticky; top: 0; background: navy\">head</div>" +
			lines(20) +
		"</div>",
		(document) => {
			document.getElementById("s").scrollTop = 4;
		},
	);
	dom.dispose();
});

test("a transition repaints each of its frames", async () => {
	const {dom} = await repaint(
		lines(2) +
		"<p id=p style=\"transition: color 50ms linear; " +
			"color: rgb(0, 0, 0)\">fading</p>",
		async (document, window) => {
			document.getElementById("p").style.color = "rgb(255, 255, 255)";
			for (let i = 0; i < 4; i++) {
				await nextFrame({window, document});
			}
		},
	);
	dom.dispose();
});

test("a counter set on one element renumbers the ones after it", async () => {
	const {dom} = await repaint(
		"<div id=a class=n>a</div><div class=n>b</div><div class=n>c</div>",
		(document) => {
			document.getElementById("a").style.counterIncrement = "n 5";
		},
		{
			head:
				"<style>body { counter-reset: n } .n { counter-increment: n } " +
				".n::before { content: counter(n) \" \" }</style>",
		},
	);
	dom.dispose();
});

test("a sticky header moves when the box it sticks in shrinks", async () => {
	const {partial, dom} = await repaint(
		"<div style=\"display: flex; flex-direction: column; height: 20px; " +
			"gap: 3px\"><div style=\"flex: 1\"><div style=\"position: sticky; " +
			"top: 0; background: navy\">head</div></div><div id=q>q</div></div>" +
			"<div style=\"height: 40px\"></div>",
		async (document, window) => {
			window.scrollTo(0, 6);
			await nextFrame({window, document});
			document.getElementById("q").innerHTML = "q<br>".repeat(12);
		},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});

test("a box that stops painting as it moves clears its old rows", async () => {
	const {partial, dom} = await repaint(
		lines(6) +
			"<div id=bar class=tall style=\"position: fixed; bottom: 0; " +
			"left: 0\">bar</div>",
		(document) => {
			document.getElementById("bar").classList.remove("tall");
		},
		{head: "<style>.tall { top: 0; background: navy }</style>"},
	);
	expect(partial).toBeGreaterThan(0);
	dom.dispose();
});
