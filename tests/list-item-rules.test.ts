import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function lines(head: string, body: string): Promise<string[]> {
	const terminal = new MockProcess({cols: 24, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = head;
	dom.document.body.innerHTML = body;
	await nextFrame(dom);
	const text = terminal.getPlainText().split("\n");
	dom.dispose();
	return text.filter((line) => line.trim() !== "");
}

test("list items keep their markers with no author list-item rule", async () => {
	expect(
		await lines(
			"",
			"<ul><li>one</li></ul><ul style=\"list-style: square inside\"><li>two</li></ul><div>three</div>",
		),
	).toEqual(["  • one", "    ▪ two", "three"]);
});

test("an element a rule styles as a list item gets a marker", async () => {
	expect(
		await lines(
			"<style>.item { display: list-item; list-style: square inside }</style>",
			"<div class=\"item\">one</div><div class=\"item\">two</div>",
		),
	).toEqual(["▪ one", "▪ two"]);
	expect(
		await lines(
			"<style>.item { display: list-item; list-style: decimal; padding-left: 4ch }</style>",
			"<div class=\"item\">one</div><div class=\"item\">two</div><p>three</p>",
		),
	).toEqual([" 1. one", " 2. two", "three"]);
});

test("an inline list-item style gets a marker", async () => {
	expect(
		await lines(
			"",
			"<div style=\"display: list-item; list-style: square inside\">one</div>",
		),
	).toEqual(["▪ one"]);
});
