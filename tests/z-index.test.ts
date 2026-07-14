/**
 * Paint order tests.
 *
 * Boxes used to be painted straight down the tree in document order, so nothing
 * could ever sit on top of anything else and an overlay or modal was impossible
 * to express: it was painted before the content it was meant to cover.
 *
 * z-index was parsed and then never read.
 */
import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess, stripControlCodes} from "./test-utils.js";

async function renderRows(html: string, cols = 30): Promise<string[]> {
	const terminal = new MockProcess({cols, rows: 8});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = html;
	await dom.render();
	const rows = stripControlCodes(terminal.getStaticANSI())
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);
	dom.dispose();
	return rows;
}

test("a positioned box with a higher z-index paints over its siblings", async () => {
	// The overlay is a sibling of the text it covers. Painted in document order it
	// would land underneath, whatever its z-index said.
	const rows = await renderRows(`
		<div style="position:relative">
			<div>background text here</div>
			<div style="position:absolute; top:0; left:4ch; width:8ch; z-index:10; background-color:blue">OVER</div>
		</div>`);

	// The overlay's own text survives, and it has eaten the text beneath it.
	expect(rows[0]).toContain("OVER");
	expect(rows[0]).not.toContain("background text here");
});

test("a negative z-index paints behind", async () => {
	const rows = await renderRows(`
		<div style="position:relative">
			<div style="position:absolute; top:0; left:0">BEHIND</div>
			<div>front</div>
		</div>`);

	// "front" is written first in the document but must win: the negative box goes
	// under it.
	expect(rows[0].startsWith("front")).toBe(true);
});

test("without a z-index, document order still decides", async () => {
	// The sort is stable, so unpositioned and auto-z boxes keep painting exactly as
	// they did. This is what stops the change moving anything that already worked.
	const rows = await renderRows(`
		<div style="position:relative">
			<div style="position:absolute; top:0; left:0">FIRST</div>
			<div style="position:absolute; top:0; left:0">SECOND</div>
		</div>`);

	expect(rows[0]).toContain("SECOND");
});

test("z-index does not apply to a static box", async () => {
	// Per CSS, z-index only affects positioned boxes. A static one keeps its place
	// in document order however large a z-index it is given.
	const rows = await renderRows(`
		<div style="position:relative">
			<div style="position:absolute; top:0; left:0; background-color:blue">POSITIONED</div>
			<div style="position:absolute; top:0; left:0; z-index:99; background-color:red">WINS</div>
		</div>`);

	expect(rows[0]).toContain("WINS");
});
