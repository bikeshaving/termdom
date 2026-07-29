/**
 * CSS conformance snapshot corpus.
 *
 * A black-box net over the rendering surface: each fixture is a small HTML + CSS
 * document rendered to the terminal, snapshotted as visible ANSI. This is what
 * turns "seems fine" into "provably unchanged" -- it locks down what termdom
 * actually paints so refactors (and new feature work like var()/!important) can't
 * silently regress the cascade, box model, or layout.
 *
 * Snapshots are Bun-only (the node runner handles them differently); the
 * non-snapshot assertions run on both.
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

interface Fixture {
	name: string;
	cols?: number;
	rows?: number;
	html: string;
	/** A substring that must appear in the visible text, as a liveness check. */
	contains?: string[];
}

const FIXTURES: Fixture[] = [
	// --- Box model -----------------------------------------------------------
	{
		name: "block with border and padding",
		html: `<div style="border: 1px solid white; padding: 1px 2px; width: 20px">Boxed</div>`,
		contains: ["Boxed"],
	},
	{
		name: "margin offsets a block from the edge",
		html: `<div style="margin-left: 4px; margin-top: 1px">Indented</div>`,
		contains: ["Indented"],
	},
	{
		name: "nested blocks stack vertically",
		html: `<div>First</div><div>Second</div><div>Third</div>`,
		contains: ["First", "Second", "Third"],
	},

	// --- Display -------------------------------------------------------------
	{
		name: "inline elements share a line",
		html: `<span>one</span><span>two</span><span>three</span>`,
		contains: ["one", "two", "three"],
	},
	{
		name: "inline-block reserves a box on the line",
		html: `<span style="display:inline-block; width:8px; border:1px solid white">A</span><span style="display:inline-block; width:8px; border:1px solid white">B</span>`,
		contains: ["A", "B"],
	},
	{
		name: "display:none removes the element",
		html: `<div>visible</div><div style="display:none">hidden</div><div>after</div>`,
		contains: ["visible", "after"],
	},

	// --- Text styling --------------------------------------------------------
	{
		name: "bold italic underline strikethrough",
		html: `<span style="font-weight:bold">B</span> <span style="font-style:italic">I</span> <span style="text-decoration:underline">U</span> <span style="text-decoration:line-through">S</span>`,
		contains: ["B", "I", "U", "S"],
	},
	{
		name: "white-space:pre preserves spacing",
		html: `<pre style="white-space:pre">a    b\n  c</pre>`,
		contains: ["a    b"],
	},

	// --- Color ---------------------------------------------------------------
	{
		name: "named, hex, and rgb foreground colors",
		html: `<div style="color:red">named</div><div style="color:#00ff00">hex</div><div style="color:rgb(0,0,255)">rgb</div>`,
		contains: ["named", "hex", "rgb"],
	},
	{
		name: "background color fills the box",
		html: `<div style="background:blue; color:white; width:10px">bg</div>`,
		contains: ["bg"],
	},

	// --- Lists ---------------------------------------------------------------
	{
		name: "unordered list markers",
		html: `<ul><li>alpha</li><li>beta</li></ul>`,
		contains: ["alpha", "beta"],
	},
	{
		name: "ordered list numbering",
		html: `<ol><li>first</li><li>second</li></ol>`,
		contains: ["first", "second"],
	},

	// --- Tables --------------------------------------------------------------
	{
		name: "table with cells",
		html: `<table><tr><td>r1c1</td><td>r1c2</td></tr><tr><td>r2c1</td><td>r2c2</td></tr></table>`,
		contains: ["r1c1", "r2c2"],
	},

	// --- Flexbox -------------------------------------------------------------
	{
		name: "flex row with justify-content space-between",
		cols: 24,
		html: `<div style="display:flex; justify-content:space-between; width:20px"><span>L</span><span>R</span></div>`,
		contains: ["L", "R"],
	},
	{
		name: "flex column stacks children",
		html: `<div style="display:flex; flex-direction:column"><span>top</span><span>bottom</span></div>`,
		contains: ["top", "bottom"],
	},

	// --- Cascade / inheritance ----------------------------------------------
	{
		name: "color inherits through nested elements",
		html: `<div style="color:magenta"><p>outer <span>inner</span></p></div>`,
		contains: ["outer", "inner"],
	},
	{
		name: "id selector beats element selector (specificity)",
		html: `<style>p{color:green} #x{color:red}</style><p id="x">wins-red</p>`,
		contains: ["wins-red"],
	},
	{
		name: "later rule wins on equal specificity (source order)",
		html: `<style>p{color:green} p{color:blue}</style><p>wins-blue</p>`,
		contains: ["wins-blue"],
	},

	// --- text-transform (paint-time; can't affect layout in a monospace grid) -
	{
		name: "text-transform:uppercase",
		html: `<div style="text-transform:uppercase">shout</div>`,
		contains: ["SHOUT"],
	},
	{
		name: "text-transform:lowercase",
		html: `<div style="text-transform:lowercase">LOUD</div>`,
		contains: ["loud"],
	},
	{
		name: "text-transform:capitalize",
		html: `<div style="text-transform:capitalize">hi there</div>`,
		contains: ["Hi There"],
	},
];

async function renderFixture(fx: Fixture) {
	const terminal = new MockProcess({cols: fx.cols ?? 40, rows: fx.rows ?? 12});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = fx.html;
	await nextFrame(dom);
	const screen = terminal.getScreenContents();
	const text = terminal.getVisibleText();
	dom.dispose();
	return {screen, text};
}

for (const fx of FIXTURES) {
	test(`css: ${fx.name}`, async () => {
		const {screen, text} = await renderFixture(fx);

		// Liveness: the content actually rendered (guards against blank frames).
		for (const needle of fx.contains ?? []) {
			expect(text).toContain(needle);
		}

		// Full-fidelity lock: colors, styles, and layout together.
		if (typeof Bun !== "undefined")
			(expect(screen) as {toMatchSnapshot(): void}).toMatchSnapshot();
	});
}

test("css: visibility:hidden paints nothing, but reserves its box", async () => {
	const {text} = await renderFixture({
		name: "visibility",
		html: `<div>a</div><div style="visibility:hidden">gone</div><div>b</div>`,
	});
	expect(text).toContain("a");
	expect(text).toContain("b");
	expect(text).not.toContain("gone");
});

test("css: visibility:visible on a descendant re-shows inside a hidden ancestor", async () => {
	const {text} = await renderFixture({
		name: "visibility-override",
		html: `<div style="visibility:hidden">gone<span style="visibility:visible">shown</span></div>`,
	});
	expect(text).toContain("shown");
	expect(text).not.toContain("gone");
});

// text-align: assert actual horizontal position, not just presence -- a
// liveness-only check can't tell "centered" from "left-aligned but present".
// justify is intentionally not covered: it isn't implemented (see
// lineAlignOffset in layout.ts).
test("css: text-align:center centers a line within its container width", async () => {
	const {text} = await renderFixture({
		name: "text-align-center",
		cols: 20,
		html: `<div style="text-align:center; width:20px">mid</div>`,
	});
	expect(text.split("\n")[0]).toBe("         mid");
});

test("css: text-align:right pushes a line to the container's right edge", async () => {
	const {text} = await renderFixture({
		name: "text-align-right",
		cols: 20,
		html: `<div style="text-align:right; width:20px">end</div>`,
	});
	expect(text.split("\n")[0]).toBe("                 end");
});

test("css: text-align:left (the default) does not shift the line", async () => {
	const {text} = await renderFixture({
		name: "text-align-left",
		cols: 20,
		html: `<div style="width:20px">start</div>`,
	});
	expect(text.split("\n")[0]).toBe("start");
});

test("css: text-align:center re-centers each wrapped line independently", async () => {
	const {text} = await renderFixture({
		name: "text-align-center-wrap",
		cols: 20,
		rows: 6,
		html: `<div style="text-align:center; width:20px">aa bb cc dd ee ff gg hh ii jj kk ll</div>`,
	});
	const lines = text.split("\n").filter((l) => l.trim());
	// Each wrapped line is a different length, so a shared center offset would
	// prove alignment is only computed once for the block rather than per line.
	expect(lines).toEqual([" aa bb cc dd ee ff ", "  gg hh ii jj kk ll"]);
});

// Known-broken fixtures: filed as gaps, not silent failures. Each documents a
// confirmed conformance bug (verified against real output, not assumed). Move a
// fixture up into FIXTURES once its property/at-rule is implemented.
const KNOWN_GAPS: Array<Fixture & {bug: string}> = [];

for (const fx of KNOWN_GAPS) {
	test.todo(`css gap: ${fx.name} (${fx.bug})`, async () => {
		const {text} = await renderFixture(fx);
		for (const needle of fx.contains ?? []) {
			expect(text).toContain(needle);
		}
	});
}

// These resolve to a *color*, not visible text, so they need a getComputedStyle
// assertion (against the literal author value -- this cascade never normalizes
// named colors to rgb()) rather than a text-contains check.
async function colorOf(html: string, sel: string): Promise<string> {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const color = dom.window
		.getComputedStyle(dom.document.querySelector(sel)!)
		.getPropertyValue("color");
	dom.dispose();
	return color;
}

test("css: var() resolves custom properties, inherited from an ancestor", async () => {
	expect(
		await colorOf(
			`<style>:root{--fg:red} p{color:var(--fg)}</style><p>x</p>`,
			"p",
		),
	).toBe("red");
});

test("css: var() falls back when the custom property is unset", async () => {
	expect(
		await colorOf(`<p style="color:var(--missing, blue)">x</p>`, "p"),
	).toBe("blue");
});

test("css: !important wins the cascade over higher specificity", async () => {
	expect(
		await colorOf(
			`<style>p{color:blue!important} #a{color:green}</style><p id="a">x</p>`,
			"#a",
		),
	).toBe("blue");
});

test("css: an important inline style beats an important stylesheet rule", async () => {
	expect(
		await colorOf(
			`<style>p{color:blue!important}</style><p style="color:orange!important">x</p>`,
			"p",
		),
	).toBe("orange");
});

test("css: @media rules apply when the query matches", async () => {
	expect(
		await colorOf(`<style>@media all{p{color:orange}}</style><p>x</p>`, "p"),
	).toBe("orange");
});

test("css: @media rules do not apply when the query fails", async () => {
	expect(
		await colorOf(
			`<style>@media (min-width: 999999px){p{color:orange}}</style><p>x</p>`,
			"p",
		),
	).not.toBe("orange");
});

test("css: color:inherit resolves the parent's value", async () => {
	expect(
		await colorOf(
			`<div style="color:purple"><span id="s" style="color:inherit">x</span></div>`,
			"#s",
		),
	).toBe("purple");
});
