/**
 * A box scrolled with the terminal's own scroll: the rows the shift
 * carried are left as they are, and the frame paints the rows it exposed
 * and the rows that changed. The test utilities compare each such frame
 * with a whole repaint, so a row carried wrongly fails here.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {partialFrameCheck} from "../src/internal/painter.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const STYLE =
	"<style>body { margin: 0; height: 100vh; display: flex; " +
	"flex-direction: column } ul { flex: 1; overflow: auto; margin: 0; " +
	"padding: 0; list-style: none } li.on { background: navy; color: white } " +
	"li:nth-child(odd) { color: gray }</style>";

async function list(
	extra = "",
): Promise<{terminal: MockProcess; dom: TermDOM; items: Element[]}> {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		STYLE +
		"<header>Inbox</header><ul>" +
		Array.from({length: 40}, (_, i) => `<li>item ${i}</li>`).join("") +
		"</ul><footer>status</footer>" +
		extra;
	await dom.attach();
	await nextFrame(dom);
	return {
		terminal,
		dom,
		items: [...dom.document.querySelectorAll("li")] as Element[],
	};
}

async function walk(dom: TermDOM, items: Element[], to: number): Promise<void> {
	for (let at = 1; at <= to; at++) {
		items[at - 1].classList.remove("on");
		items[at].classList.add("on");
		items[at].scrollIntoView({block: "nearest"});
		await nextFrame(dom);
	}
}

test("a list scrolled a row at a time paints only what the shift exposed", async () => {
	const {terminal, dom, items} = await list();
	const checked = partialFrameCheck.checked;
	await walk(dom, items, 20);
	expect(partialFrameCheck.checked - checked).toBeGreaterThanOrEqual(20);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Inbox");
	expect(rows.some((row) => row.includes("item 20"))).toBe(true);
	expect(rows.some((row) => row.includes("item 9"))).toBe(false);
	expect(rows.filter((row) => row.trim() !== "").at(-1)).toContain("status");
	dom.dispose();
});

test("a box under a fixed bar is repainted whole as it scrolls", async () => {
	const {terminal, dom, items} = await list(
		"<div style=\"position: fixed; top: 4em; left: 10ch; width: 8ch; " +
		"background: maroon\">overlay</div>",
	);
	await walk(dom, items, 15);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[4]).toContain("overlay");
	expect(rows.filter((row) => row.includes("overlay"))).toHaveLength(1);
	dom.dispose();
});

test("a sticky row in a scrolled box stays where it sticks", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		STYLE +
		"<ul>" +
		"<li style=\"position: sticky; top: 0; background: teal\">pinned</li>" +
		Array.from({length: 40}, (_, i) => `<li>item ${i}</li>`).join("") +
		"</ul>";
	await dom.attach();
	await nextFrame(dom);
	const items = [...dom.document.querySelectorAll("li")].slice(1) as Element[];
	await walk(dom, items, 15);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("pinned");
	expect(rows.filter((row) => row.includes("pinned"))).toHaveLength(1);
	dom.dispose();
});
