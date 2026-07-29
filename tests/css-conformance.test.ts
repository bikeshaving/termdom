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
		name: "text-align center and right",
		cols: 20,
		html: `<div style="text-align:center">mid</div><div style="text-align:right">end</div>`,
		contains: ["mid", "end"],
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

// Known-broken fixtures: filed as gaps, not silent failures. Each documents a
// confirmed conformance bug (verified against real output, not assumed). Move a
// fixture up into FIXTURES once its property/at-rule is implemented.
const KNOWN_GAPS: Array<Fixture & {bug: string}> = [
	{
		name: "text-transform: uppercase/capitalize/lowercase",
		bug: "text-transform is parsed (styles.ts) but never applied during text paint -- rendered text is untransformed",
		html: `<div style="text-transform:uppercase">shout</div>`,
		contains: ["SHOUT"],
	},
	{
		name: "visibility: hidden removes the element from paint",
		bug: "visibility:hidden still paints its text -- only display:none actually hides content",
		html: `<div>a</div><div style="visibility:hidden">gone</div><div>b</div>`,
		contains: ["a", "b"],
	},
];

for (const fx of KNOWN_GAPS) {
	test.todo(`css gap: ${fx.name} (${fx.bug})`, async () => {
		const {text} = await renderFixture(fx);
		for (const needle of fx.contains ?? []) {
			expect(text).toContain(needle);
		}
	});
}

// These three resolve to a *color*, not visible text, so they need a
// getComputedStyle assertion instead of a text-contains check.
test.todo(
	"css gap: var() resolves custom properties (currently returns the literal string)",
	() => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({process: terminal});
		dom.document.body.innerHTML = `<style>:root{--fg:red} p{color:var(--fg)}</style><p>x</p>`;
		const color = dom.window
			.getComputedStyle(dom.document.querySelector("p")!)
			.getPropertyValue("color");
		expect(color).toBe("rgb(255, 0, 0)");
		dom.dispose();
	},
);

test.todo(
	"css gap: !important wins the cascade over higher specificity (currently ignored)",
	() => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({process: terminal});
		dom.document.body.innerHTML = `<style>p{color:blue!important} #a{color:green}</style><p id="a">x</p>`;
		const color = dom.window
			.getComputedStyle(dom.document.querySelector("#a")!)
			.getPropertyValue("color");
		expect(color).toBe("rgb(0, 0, 255)");
		dom.dispose();
	},
);

test.todo(
	"css gap: @media rules apply when the query matches (currently dropped entirely)",
	() => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({process: terminal});
		dom.document.body.innerHTML = `<style>@media all{p{color:orange}}</style><p>x</p>`;
		const color = dom.window
			.getComputedStyle(dom.document.querySelector("p")!)
			.getPropertyValue("color");
		expect(color).toBe("rgb(255, 165, 0)");
		dom.dispose();
	},
);
