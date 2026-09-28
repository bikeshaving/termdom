/**
 * text-overflow: ellipsis, and text-align inside an inline-block: the two
 * places a line's text is placed against a box's edge rather than the
 * space it was broken in.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function render(html: string, cols = 30): Promise<string[]> {
	const terminal = new MockProcess({cols, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	await new Promise<void>((resolve) =>
		(terminal as any).terminal.write("", resolve),
	);
	const lines = terminal
		.getVisibleText()
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""),
		);
	dom.dispose();
	return lines;
}

test("a clipped line that runs past the edge ends in an ellipsis", async () => {
	const lines = await render(
		"<div style=\"width:8ch;white-space:nowrap;overflow:hidden;" +
			"text-overflow:ellipsis\">abc<b>defghijk</b>lmnop</div>" +
			"<div style=\"width:8ch;white-space:nowrap;overflow:hidden;" +
			"text-overflow:ellipsis\">short</div>",
	);
	expect(lines[0]).toBe("abcdefg…");
	expect(lines[1]).toBe("short");
});

test("an ellipsis needs a clip, and marks each overflowing line", async () => {
	const lines = await render(
		"<div style=\"width:6ch;white-space:nowrap;text-overflow:ellipsis\">" +
			"abcdefghij</div>" +
			"<div style=\"width:6ch;overflow:hidden;text-overflow:ellipsis\">" +
			"ab abcdefghij cd</div>",
	);
	// Without overflow the text simply runs on, as in a browser.
	expect(lines[0]).toBe("abcdefghij");
	expect(lines.slice(1, 4)).toEqual(["ab", "abcde…", "cd"]);
});

test("a right-to-left line overflows to the left, and ends in an ellipsis there", async () => {
	const lines = await render(
		"<div style=\"width:6ch;white-space:nowrap;overflow:hidden;" +
			"direction:rtl\">abcdefghij</div>" +
			"<div style=\"width:6ch;white-space:nowrap;overflow:hidden;" +
			"text-overflow:ellipsis;direction:rtl\">abcdefghij</div>",
	);
	// A line too long for its box starts at its start edge, the right.
	expect(lines[0]).toBe("efghij");
	expect(lines[1]).toBe("…fghij");
});

test("an inline-block aligns its lines within its own width", async () => {
	const lines = await render(
		"<span style=\"display:inline-block;width:5ch;text-align:right\">c</span>|" +
			"<span style=\"display:inline-block;width:5ch;text-align:center\">" +
			"c</span>|",
	);
	expect(lines[0]).toBe("    c|  c  |");
});
