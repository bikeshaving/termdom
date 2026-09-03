/**
 * List marker tests.
 *
 * Every expectation here is derived from CSS and the HTML list attributes, not
 * from the implementation. The existing list snapshots were re-recorded around a
 * marker bug once already, so they cannot be used as the oracle for markers:
 * they only pin the default cases, and every bug these tests cover lived in a
 * corner the snapshots never reached.
 *
 * Column positions matter. `list-style-position: outside` right-aligns the
 * marker in the list's padding, so the item text starts at the content edge and
 * the marker sits immediately before it, separated by exactly one cell.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
import {stripControlCodes} from "./test-utils.js";

/** Render HTML and return the non-blank rendered rows, ANSI stripped. */
async function renderRows(html: string, cols = 40): Promise<string[]> {
	const terminal = new MockProcess({cols, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const output = stripControlCodes(terminal.getStaticANSI());
	dom.dispose();
	return output
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);
}

test("list-style-type comes from the computed value, not the tag name", async () => {
	// An `ol` can be bulleted and a `ul` can be numbered. Deriving the marker from
	// the tag made both impossible.
	expect(
		await renderRows("<ol style=\"list-style-type:disc\"><li>A</li></ol>"),
	).toEqual(["  • A"]);
	expect(
		await renderRows("<ul style=\"list-style-type:decimal\"><li>A</li></ul>"),
	).toEqual([" 1. A"]);
});

test("list-style-type: none suppresses the marker on ol as well as ul", async () => {
	// Content still sits at the content edge; only the marker is gone.
	expect(
		await renderRows("<ol style=\"list-style-type:none\"><li>A</li></ol>"),
	).toEqual(["    A"]);
	expect(
		await renderRows("<ul style=\"list-style-type:none\"><li>A</li></ul>"),
	).toEqual(["    A"]);
});

test("list-style-type on the li itself wins", async () => {
	// list-style-type is inherited and applies to the list item, so setting it on
	// the item overrides the list.
	expect(
		await renderRows(
			"<ul><li>A</li><li style=\"list-style-type:square\">B</li></ul>",
		),
	).toEqual(["  • A", "  ▪ B"]);
});

test("the list-style shorthand is expanded", async () => {
	// An unexpanded `list-style` leaves list-style-type undeclared, and the
	// default marker is drawn regardless of what the author wrote.
	expect(
		await renderRows("<ul style=\"list-style: none\"><li>A</li></ul>"),
	).toEqual(["    A"]);
	expect(
		await renderRows("<ul style=\"list-style: square\"><li>A</li></ul>"),
	).toEqual(["  ▪ A"]);
	// Components may appear in any order, and a position keyword must not be
	// mistaken for a type.
	expect(
		await renderRows(
			"<ul style=\"list-style: outside square\"><li>A</li></ul>",
		),
	).toEqual(["  ▪ A"]);
});

test("nested lists cycle the bullet like a browser's UA stylesheet", async () => {
	// disc, then circle, then square, and square from there down.
	expect(
		await renderRows(
			"<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>",
		),
	).toEqual([
		"  • a",
		//    Each level indents by the list's 4ch padding: content at 4, 8, 12.
		"      ◦ b",
		"          ▪ c",
	]);
});

test("alphabetic counters are bijective base-26", async () => {
	// 26 is "z" and 27 is "aa". The old `96 + (n % 26)` produced a backtick at 26
	// and wrapped straight back to "a" at 27.
	expect(
		await renderRows(
			"<ol start=\"25\" style=\"list-style-type:lower-alpha\"><li>Y</li><li>Z</li><li>AA</li></ol>",
		),
	).toEqual([" y. Y", " z. Z", "aa. AA"]);
});

test("roman numerals fall back to decimal outside their range", async () => {
	// toRoman(0) is the empty string, which rendered a bare ". Zero".
	expect(
		await renderRows(
			"<ol start=\"0\" style=\"list-style-type:lower-roman\"><li>Zero</li></ol>",
		),
	).toEqual([" 0. Zero"]);
});

test("an invalid start attribute falls back to 1", async () => {
	// parseInt("abc") is NaN, which rendered a literal "NaN." marker.
	expect(await renderRows("<ol start=\"abc\"><li>A</li></ol>")).toEqual([
		" 1. A",
	]);
});

test("li value resets the counter and later items carry on from it", async () => {
	expect(
		await renderRows(
			"<ol><li>One</li><li value=\"5\">Five</li><li>Six</li></ol>",
		),
	).toEqual([" 1. One", " 5. Five", " 6. Six"]);
});

test("ol reversed counts down", async () => {
	expect(
		await renderRows("<ol reversed><li>a</li><li>b</li><li>c</li></ol>"),
	).toEqual([" 3. a", " 2. b", " 1. c"]);
});

test("the gutter fits the widest marker, so wide markers keep their separator", async () => {
	// "iii." is 4 cells and its separating space makes 5, which did not fit the
	// fixed 4-cell gutter: the item's text overwrote the space, giving "iii.Third".
	expect(
		await renderRows(
			"<ol style=\"list-style-type:lower-roman\"><li>One</li><li>Two</li><li>Three</li></ol>",
		),
	).toEqual(["  i. One", " ii. Two", "iii. Three"]);
});

test("the gutter is measured in cells, not code units", async () => {
	// "日本 " is 3 code units but 5 cells. Right-aligning it by String#length put
	// the marker two cells too far right, painting over the item's own first
	// character.
	expect(
		await renderRows(
			"<style>li::marker{content:\"日本 \";}</style><ul><li>First</li></ul>",
		),
	).toEqual(["日本 First"]);
});

test("a custom ::marker content is what the gutter is sized to", async () => {
	// The gutter used to be measured from the *default* marker while the renderer
	// drew the ::marker content, so any custom marker overran it.
	expect(
		await renderRows(
			"<style>li::marker{content:\">>>>>> \";}</style><ul><li>First</li></ul>",
		),
	).toEqual([">>>>>> First"]);
});

test("counter() in ::marker content keeps its quotes out of the output", async () => {
	// A content value is a sequence of components. Only stripping quotes when the
	// whole value was one quoted string left literal `"` characters in the marker.
	expect(
		await renderRows(
			"<style>li::marker{content:counter(list-item) \") \";}</style><ol><li>First</li></ol>",
		),
	).toEqual([" 1) First"]);
});

test("counter() past 26 spells the ordinal list-style-type would", async () => {
	// The 27th item is "aa", not "a" -- and lower-latin names the same style
	// lower-alpha does.
	const terminal = new MockProcess({cols: 40, rows: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const items = Array.from({length: 27}, () => "<li>x</li>").join("");
	dom.document.body.innerHTML =
		"<style>li::marker{content:counter(list-item, lower-latin) \". \";}</style>" +
		`<ol>${items}</ol>`;
	await nextFrame(dom);
	const rows = stripControlCodes(terminal.getStaticANSI())
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);
	dom.dispose();

	expect(rows[0]).toBe(" a. x");
	expect(rows[25]).toBe(" z. x");
	expect(rows[26]).toBe("aa. x");
});

test("the gutter is recomputed when items are added", async () => {
	// The gutter is derived from the list's children, so a childList mutation
	// invalidates the list itself -- not just the item that moved. Without that
	// the gutter stayed at what the original items needed and a wider marker added
	// later overran it, bringing the "iii.Third" collision straight back.
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	document.body.innerHTML = "<ol style=\"list-style-type:lower-roman\"><li>one</li><li>two</li><li>three</li></ol>";
	await nextFrame(dom);

	const list = document.querySelector("ol")!;
	// Widest marker is now "viii. " -- 6 cells, where "iii. " needed 5.
	for (let i = 4; i <= 8; i++) {
		const item = document.createElement("li");
		item.textContent = `item${i}`;
		list.appendChild(item);
	}
	await nextFrame(dom);

	const rows = stripControlCodes(terminal.getStaticANSI())
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);

	expect(rows).toContain("viii. item8");
	dom.dispose();
});

test("::marker inherits color from its list item", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<ul><li style=\"color:green\">A</li></ul>";
	await nextFrame(dom);
	const output = terminal.getStaticANSI();
	dom.dispose();

	// The bullet must carry the item's colour, not render unstyled.
	const bullet = output.indexOf("•");
	expect(bullet).toBeGreaterThan(-1);
	expect(output.slice(0, bullet)).toContain("38;2;0;128;0");
});
