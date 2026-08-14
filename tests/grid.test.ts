/**
 * CSS Grid layout tests.
 *
 * The expectations are derived from css-grid-2 and css-align-3 and written as
 * literals, with the derivation in a comment beside each one. None were read
 * off the implementation: an expectation generated from the code under test
 * only proves the code agrees with itself.
 *
 * Two things are asserted throughout that a browser test would not have to be:
 * that tracks tile the terminal exactly (a cell is indivisible, so a fractional
 * track has to round to edges that still meet), and that a grid built by
 * mutation lands where the same grid built at once does.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface Rendered {
	dom: TermDOM;
	document: Document;
	/** The nth <i> in the document, which every fixture uses for its items. */
	item(index: number): Box;
	items(): Box[];
	box(selector: string, index?: number): Box;
	rows(): string[];
	/** The painted frame, colors and all. */
	painted(): string;
	/** A resolved value off the grid container, which every fixture calls #g. */
	resolved(property: string, selector?: string): string;
}

function boxOf(element: Element): Box {
	const rect = element.getBoundingClientRect();
	return {
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
	};
}

async function render(html: string, cols = 30, rows = 12): Promise<Rendered> {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);

	const query = (selector: string, index: number): Element => {
		const found = dom.document.querySelectorAll(selector)[index];
		if (!found) throw new Error(`no ${selector} at ${index}`);
		return found;
	};

	return {
		dom,
		document: dom.document,
		item: (index) => boxOf(query("i", index)),
		items: () => Array.from(dom.document.querySelectorAll("i")).map(boxOf),
		box: (selector, index = 0) => boxOf(query(selector, index)),
		rows: () => {
			const lines = terminal
				.getVisibleText()
				.split("\n")
				.map((line) => line.replace(/\s+$/, ""));
			// The rows below the last painted one say nothing about layout,
			// and how many the terminal still reports depends on how much was
			// painted before.
			while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			return lines;
		},
		painted: () => terminal.getScreenContents(),
		resolved: (property, selector = "#g") =>
			dom.window
				.getComputedStyle(query(selector, 0))
				.getPropertyValue(property),
	};
}

/** A grid container with the given container styles, holding `items` <i>s. */
function grid(styles: string, items: string): string {
	// A single-quoted attribute, so a double-quoted CSS string (an area map)
	// can sit inside it as written.
	return `<div id="g" style='display:grid;${styles}'>${items}</div>`;
}

/** `count` items whose text is a, b, c, ... */
function letters(count: number, styles = ""): string {
	return Array.from(
		{length: count},
		(_, index) => `<i style='${styles}'>${String.fromCharCode(97 + index)}</i>`,
	).join("");
}

// ---------------------------------------------------------------------------
// Explicit tracks (css-grid-2 §7.2)
// ---------------------------------------------------------------------------

test("a length track list places items at the lengths it states", async () => {
	// Columns 6 and 4 wide: the first item occupies 0..6, the second 6..10.
	const {item} = await render(
		grid("grid-template-columns: 6px 4px", letters(2)),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 6, height: 1});
	expect(item(1)).toEqual({left: 6, top: 0, width: 4, height: 1});
});

test("a percentage track resolves against the container's content box", async () => {
	// 50% of a 20-cell content box is 10 cells, twice over.
	const {item} = await render(
		grid("grid-template-columns: 50% 50%; width: 20px", letters(2)),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 10, height: 1});
	expect(item(1)).toEqual({left: 10, top: 0, width: 10, height: 1});
});

test("fr shares the leftover space in proportion to its factor", async () => {
	// 30 cells, minus the 6-cell fixed track, is 24 for 1fr + 2fr: 8 and 16.
	const {item} = await render(
		grid("grid-template-columns: 6px 1fr 2fr", letters(3)),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 6, height: 1});
	expect(item(1)).toEqual({left: 6, top: 0, width: 8, height: 1});
	expect(item(2)).toEqual({left: 14, top: 0, width: 16, height: 1});
});

test("a flex factor below one leaves part of the free space unclaimed", async () => {
	// css-grid-2 §12.7.1: a total flex factor under 1 is treated as 1, so
	// `0.5fr 0.5fr` over 20 cells takes 10 each and nothing is left over --
	// but `0.5fr` alone takes half the space and leaves the rest.
	const {item} = await render(
		grid("grid-template-columns: 0.5fr; width: 20px", letters(1)),
	);
	expect(item(0).width).toBe(10);
});

test("auto tracks size to their content and share what is left", async () => {
	// css-grid-2 §12.8: with align-content/justify-content at their initial
	// `normal`, the leftover space is shared out equally among the auto
	// tracks -- 30 cells over two of them is 15 each.
	const {item} = await render(
		grid("grid-template-columns: auto auto", letters(2)),
	);
	expect(item(0).width).toBe(15);
	expect(item(1)).toEqual({left: 15, top: 0, width: 15, height: 1});
});

test("min-content and max-content size a track to its content", async () => {
	// The word cannot break, so both are its width: 8 cells, and the second
	// track takes the rest.
	const {item, resolved} = await render(
		grid("grid-template-columns: min-content auto", `<i>unbreakab</i><i>x</i>`),
	);
	expect(item(0).width).toBe(9);
	expect(resolved("grid-template-columns")).toBe("9px 21px");
});

test("minmax clamps a track between its two breadths", async () => {
	// minmax(4px, 8px) can never leave [4, 8]; the flexible track beside it
	// takes the remaining 22 of 30.
	const {item} = await render(
		grid(
			"grid-template-columns: minmax(4px, 8px) minmax(2px, 1fr)",
			letters(2),
		),
	);
	expect(item(0).width).toBe(8);
	expect(item(1)).toEqual({left: 8, top: 0, width: 22, height: 1});
});

test("minmax with an intrinsic minimum floors the track at its content", async () => {
	// minmax(min-content, 4px): the growth limit is 4, but a track never goes
	// below its base size, and the base is the 9-cell unbreakable word.
	const {item} = await render(
		grid(
			"grid-template-columns: minmax(min-content, 4px) 5px",
			`<i>unbreakab</i><i>x</i>`,
		),
	);
	expect(item(0).width).toBe(9);
	expect(item(1).left).toBe(9);
});

test("fit-content caps a track at its argument", async () => {
	// fit-content(6px) is minmax(auto, max-content) clamped at 6: the content
	// wraps to two lines rather than taking its 8-cell max-content width.
	const {item} = await render(
		grid(
			"grid-template-columns: fit-content(6px) 5px",
			`<i>aaa bbb</i><i>x</i>`,
		),
	);
	expect(item(0).width).toBe(6);
	expect(item(0).height).toBe(2);
});

test("fit-content never clamps below the content's own minimum", async () => {
	// The clamp is on the growth limit, and a growth limit below the base size
	// is raised to it: an unbreakable 9-cell word overflows a fit-content(4px)
	// track in a browser too.
	const {item} = await render(
		grid(
			"grid-template-columns: fit-content(4px) 5px",
			`<i>unbreakab</i><i>x</i>`,
		),
	);
	expect(item(0).width).toBe(9);
});

test("repeat(N) states the same track N times", async () => {
	const {items, resolved} = await render(
		grid("grid-template-columns: repeat(3, 6px)", letters(3)),
	);
	expect(items().map((box) => box.left)).toEqual([0, 6, 12]);
	expect(resolved("grid-template-columns")).toBe("6px 6px 6px");
});

test("repeat(auto-fill) fits as many tracks as the container holds", async () => {
	// 30 cells hold four 7-cell tracks (28) and not five (35), so the track
	// list is four long however few items there are.
	const {resolved} = await render(
		grid("grid-template-columns: repeat(auto-fill, 7px)", letters(2)),
	);
	expect(resolved("grid-template-columns")).toBe("7px 7px 7px 7px");
});

test("repeat(auto-fill) counts the gaps between its tracks", async () => {
	// With a 2-cell gap each repetition costs 9, and 30 + 2 holds three of
	// them (27) but not four (36).
	const {resolved} = await render(
		grid(
			"grid-template-columns: repeat(auto-fill, 7px); column-gap: 2px",
			letters(2),
		),
	);
	expect(resolved("grid-template-columns")).toBe("7px 7px 7px");
});

test("repeat(auto-fit) collapses the tracks no item landed in", async () => {
	// Same four tracks as auto-fill, but the two nobody occupies collapse to
	// zero (css-grid-2 §7.2.3.2).
	const {items, resolved} = await render(
		grid("grid-template-columns: repeat(auto-fit, 7px)", letters(2)),
	);
	expect(resolved("grid-template-columns")).toBe("7px 7px 0px 0px");
	expect(items().map((box) => box.left)).toEqual([0, 7]);
});

test("an auto-fit track that took an item does not collapse", async () => {
	const {resolved} = await render(
		grid("grid-template-columns: repeat(auto-fit, 7px)", letters(4)),
	);
	expect(resolved("grid-template-columns")).toBe("7px 7px 7px 7px");
});

test("a track list with no definite space repeats once", async () => {
	// An auto-width container offers no space to fill, so auto-fill has
	// nothing to count against and states one repetition.
	const {resolved} = await render(
		`<div style="display:inline-block"><div id="g" style="display:grid; grid-template-columns: repeat(auto-fill, 7px)"><i>a</i></div></div>`,
	);
	expect(resolved("grid-template-columns")).toBe("7px");
});

test("grid-template-rows sizes the rows", async () => {
	const {item} = await render(
		grid("grid-template-columns: 5px; grid-template-rows: 2px 3px", letters(2)),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 5, height: 2});
	expect(item(1)).toEqual({left: 0, top: 2, width: 5, height: 3});
});

test("a row sized auto takes the height of the tallest item in it", async () => {
	const {item} = await render(
		grid("grid-template-columns: 4px 4px", `<i>aa bb cc</i><i>x</i>`),
	);
	// "aa bb cc" wraps to three lines at 4 cells wide, so the row is 3 tall
	// and the shorter item stretches to it.
	expect(item(0).height).toBe(3);
	expect(item(1).height).toBe(3);
});

// ---------------------------------------------------------------------------
// Integer tiling
// ---------------------------------------------------------------------------

/** Items whose boxes are laid out rather than measured as a run of text. */
function boxes(count: number, styles = ""): string {
	return Array.from(
		{length: count},
		(_, index) =>
			`<i style='${styles}'><div>${String.fromCharCode(97 + index)}</div></i>`,
	).join("");
}

test("three equal columns tile an odd width with no gap and no overlap", async () => {
	// 80 / 3 is 26.67, which no per-track rounding can tile. Rounding the
	// track EDGES instead gives 27 + 26 + 27 = 80, meeting exactly.
	const {items, resolved} = await render(
		grid("grid-template-columns: repeat(3, 1fr)", boxes(3)),
		80,
	);
	const laid = items();
	expect(laid.map((box) => box.width)).toEqual([27, 26, 27]);
	expect(laid.map((box) => box.left)).toEqual([0, 27, 53]);
	expect(laid[2].left + laid[2].width).toBe(80);
	expect(resolved("grid-template-columns")).toBe("27px 26px 27px");
});

test("seven equal columns tile a prime width", async () => {
	const {items} = await render(
		grid("grid-template-columns: repeat(7, 1fr)", boxes(7)),
		79,
	);
	const laid = items();
	expect(laid.reduce((sum, box) => sum + box.width, 0)).toBe(79);
	for (let index = 1; index < laid.length; index++) {
		expect(laid[index].left).toBe(laid[index - 1].left + laid[index - 1].width);
	}
});

test("the tracks tile whatever width the terminal is", async () => {
	// Every width from 20 to 40 cells, over five flexible tracks: the reported
	// used sizes always come to the container exactly.
	for (let width = 20; width <= 40; width++) {
		const {resolved} = await render(
			grid("grid-template-columns: repeat(5, 1fr)", boxes(5)),
			width,
		);
		const sizes = resolved("grid-template-columns")
			.split(" ")
			.map((size) => parseInt(size, 10));
		expect(`${width}: ${sizes.reduce((sum, size) => sum + size, 0)}`).toBe(
			`${width}: ${width}`,
		);
	}
});

test("the tiled grid paints without a seam", async () => {
	const {painted} = await render(
		grid(
			"grid-template-columns: repeat(3, 1fr)",
			`<i style='background-color:red'><div>a</div></i>` +
				`<i style='background-color:green'><div>b</div></i>` +
				`<i style='background-color:blue'><div>c</div></i>`,
		),
		80,
		4,
	);
	expect(painted()).toMatchSnapshot();
});

// ---------------------------------------------------------------------------
// Placement (css-grid-2 §8.3, §8.4)
// ---------------------------------------------------------------------------

test("line numbers place an item between them", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px",
			`<i style="grid-column: 2 / 3">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("a negative line number counts back from the explicit grid's end", async () => {
	// -1 is the last line of a three-track grid, so 2 / -1 spans tracks 2 and 3.
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px",
			`<i style="grid-column: 2 / -1">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 10, height: 1});
});

test("two negative lines place an item at the end of the grid", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px",
			`<i style="grid-column: -3 / -2">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("lines given out of order are swapped", async () => {
	// css-grid-2 §8.3: a start after its end swaps with it rather than
	// producing a negative area.
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px",
			`<i style="grid-column: 3 / 1">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 10, height: 1});
});

test("a start and end on the same line span one track", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px",
			`<i style="grid-column: 2 / 2">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("span N widens an item from its start line", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px",
			`<i style="grid-column: 1 / span 2">a</i>`,
		),
	);
	expect(item(0).width).toBe(8);
});

test("span N before a definite end line places the start", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px",
			`<i style="grid-column: span 2 / 4">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 0, width: 8, height: 1});
});

test("an end line alone spans the one track before it", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px",
			`<i style="grid-column-end: 3">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 0, width: 4, height: 1});
});

test("two spans discard the end one", async () => {
	// css-grid-2 §8.3: when both ends are spans, the end span is dropped and
	// the item is auto-placed with the start's span.
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px",
			`<i style="grid-column: span 2 / span 3">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 8, height: 1});
});

test("named lines place an item by name", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: [s] 5px [m] 5px [e] 5px",
			`<i style="grid-column: m / e">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("a line can carry more than one name", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: [a b] 5px [c d] 5px [e f] 5px",
			`<i style="grid-column: d / f">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("a repeated name is counted by its ordinal", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: [c] 5px [c] 5px [c] 5px",
			`<i style="grid-column: c 2 / c 3">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
});

test("span N <name> counts named lines rather than tracks", async () => {
	// From line 1, the second line named `c` is the third line of the grid.
	const {item} = await render(
		grid(
			"grid-template-columns: [c] 5px [c] 5px [c] 5px",
			`<i style="grid-column: 1 / span 2 c">a</i>`,
		),
	);
	expect(item(0).width).toBe(10);
});

test("a name with no line takes an implicit line past the explicit grid", async () => {
	// css-grid-2 §8.3: where a name names no line, every implicit line is
	// assumed to carry it -- so the item lands in a new track after the grid,
	// past the empty implicit track the name counted over.
	const {item, resolved} = await render(
		grid(
			"grid-template-columns: 5px 5px; grid-auto-columns: 4px",
			`<i style='grid-column: nowhere'>a</i>`,
		),
	);
	expect(resolved("grid-template-columns")).toBe("5px 5px 4px 4px");
	expect(item(0).left).toBe(14);
});

test("named lines from repeat() are counted through the repetitions", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: repeat(3, [c] 4px)",
			`<i style="grid-column: c 3 / span 1">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 8, top: 0, width: 4, height: 1});
});

test("rows and columns place independently", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px; grid-template-rows: 2px 2px",
			`<i style="grid-row: 2; grid-column: 2">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 2, width: 4, height: 2});
});

// ---------------------------------------------------------------------------
// grid-template-areas (css-grid-2 §7.3)
// ---------------------------------------------------------------------------

test("an area map places items by name", async () => {
	const {box} = await render(
		grid(
			`grid-template-areas: "h h" "s m"; grid-template-columns: 6px 6px; grid-template-rows: 1px 1px`,
			`<i class="m" style="grid-area:m">m</i><i class="h" style="grid-area:h">h</i><i class="s" style="grid-area:s">s</i>`,
		),
	);
	expect(box("i.h")).toEqual({left: 0, top: 0, width: 12, height: 1});
	expect(box("i.s")).toEqual({left: 0, top: 1, width: 6, height: 1});
	expect(box("i.m")).toEqual({left: 6, top: 1, width: 6, height: 1});
});

test("a named area names its four edge lines", async () => {
	// The area `m` generates m-start and m-end on both axes, which is what
	// lets an item be placed against one edge of it.
	const {item} = await render(
		grid(
			`grid-template-areas: "h h" "s m"; grid-template-columns: 6px 6px; grid-template-rows: 1px 1px`,
			`<i style="grid-column: m-start / m-end; grid-row: 1">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 6, top: 0, width: 6, height: 1});
});

test("a dot in an area map is a cell no name reaches", async () => {
	const {item} = await render(
		grid(
			`grid-template-areas: ". a" "b b"; grid-template-columns: 5px 5px; grid-template-rows: 1px 1px`,
			`<i style="grid-area:a">a</i><i style="grid-area:b">b</i>`,
		),
	);
	expect(item(0)).toEqual({left: 5, top: 0, width: 5, height: 1});
	expect(item(1)).toEqual({left: 0, top: 1, width: 10, height: 1});
});

test("a run of dots is one null cell however long it is", async () => {
	const {item} = await render(
		grid(
			`grid-template-areas: "... a"; grid-template-columns: 5px 5px`,
			`<i style="grid-area:a">a</i>`,
		),
	);
	expect(item(0).left).toBe(5);
});

test("an area map with unequal rows declares nothing", async () => {
	// Not a valid map (css-grid-2 §7.3), so no area named `b` exists and the
	// name resolves to an implicit line past the explicit grid instead.
	const {item} = await render(
		grid(
			`grid-template-areas: "a a" "b"; grid-template-columns: 5px 5px; grid-auto-columns: 4px`,
			`<i style='grid-area:b'>b</i>`,
		),
	);
	expect(item(0).left).toBe(14);
});

test("a non-rectangular area declares nothing", async () => {
	const {item} = await render(
		grid(
			`grid-template-areas: "a b a"; grid-template-columns: 5px 5px 5px; grid-auto-columns: 4px`,
			`<i style='grid-area:a'>a</i>`,
		),
	);
	expect(item(0).left).toBe(19);
});

test("an area map creates the tracks the template did not state", async () => {
	// Three columns named and none sized: the extra tracks come from
	// grid-auto-columns, which shares the container between them.
	const {resolved} = await render(
		grid(`grid-template-areas: "a b c"`, `<i style="grid-area:b">b</i>`),
	);
	expect(resolved("grid-template-columns")).toBe("10px 10px 10px");
});

// ---------------------------------------------------------------------------
// Auto-placement (css-grid-2 §8.5)
// ---------------------------------------------------------------------------

test("items fill the rows in order", async () => {
	const {items} = await render(
		grid("grid-template-columns: 4px 4px", letters(5)),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[4, 0],
		[0, 1],
		[4, 1],
		[0, 2],
	]);
});

test("an item too wide for the row left starts the next one", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: repeat(3, 4px)",
			`<i>a</i><i style="grid-column: span 3">b</i><i>c</i>`,
		),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[0, 1],
		[0, 2],
	]);
});

test("sparse packing never goes back for a hole it left", async () => {
	// The cursor only moves forward, so the cell before the placed item stays
	// empty and the last item lands after it.
	const {items} = await render(
		grid(
			"grid-template-columns: repeat(3, 4px)",
			`<i style="grid-column: 2 / 4">a</i><i style="grid-column: span 2">b</i><i>c</i>`,
		),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[4, 0],
		[0, 1],
		[8, 1],
	]);
});

test("dense packing goes back and fills the hole", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: repeat(3, 4px); grid-auto-flow: row dense",
			`<i style="grid-column: 2 / 4">a</i><i style="grid-column: span 2">b</i><i>c</i>`,
		),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[4, 0],
		[0, 1],
		[0, 0],
	]);
});

test("grid-auto-flow: column fills down before it fills across", async () => {
	const {items} = await render(
		grid(
			"grid-template-rows: 1px 1px; grid-auto-flow: column; grid-auto-columns: 4px",
			letters(3),
		),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[0, 1],
		[4, 0],
	]);
});

test("an item locked to a row is placed within that row", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: repeat(3, 4px); grid-template-rows: 1px 1px",
			`<i>a</i><i style="grid-row: 1">b</i><i style="grid-row: 1">c</i>`,
		),
	);
	// The two locked items are placed first (§8.5 step 2), so the auto-placed
	// one takes the cell they left rather than the first cell of the row.
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[8, 0],
		[0, 0],
		[4, 0],
	]);
});

test("implicit rows take their size from grid-auto-rows", async () => {
	const {items, resolved} = await render(
		grid("grid-template-columns: 4px 4px; grid-auto-rows: 2px", letters(3)),
	);
	expect(items()[2]).toEqual({left: 0, top: 2, width: 4, height: 2});
	expect(resolved("grid-template-rows")).toBe("2px 2px");
});

test("grid-auto-rows cycles over the implicit rows", async () => {
	const {resolved} = await render(
		grid("grid-template-columns: 4px; grid-auto-rows: 1px 3px", letters(4)),
	);
	expect(resolved("grid-template-rows")).toBe("1px 3px 1px 3px");
});

test("implicit columns are created past the explicit grid", async () => {
	const {item, resolved} = await render(
		grid(
			"grid-template-columns: 4px; grid-auto-columns: 6px",
			`<i style="grid-column: 2">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 0, width: 6, height: 1});
	expect(resolved("grid-template-columns")).toBe("4px 6px");
});

test("an implicit track before the explicit grid shifts everything after it", async () => {
	// A negative line creates tracks in front of line 1, and the explicit
	// grid slides right by them.
	const {items, resolved} = await render(
		grid(
			"grid-template-columns: 4px; grid-auto-columns: 3px",
			`<i style="grid-column: -2 / -1">a</i><i style="grid-column: 1 / 2">b</i>`,
		),
	);
	expect(resolved("grid-template-columns")).toBe("4px");
	expect(items()[0].left).toBe(0);
});

test("order moves an item's place on the grid, not only its painting", async () => {
	const {items} = await render(
		grid("grid-template-columns: 4px 4px", `<i style="order:2">a</i><i>b</i>`),
	);
	// Auto-placement runs in order-modified document order, so `b` takes the
	// first cell and `a` the second.
	expect(items()[0].left).toBe(4);
	expect(items()[1].left).toBe(0);
});

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

test("column-gap separates the columns and comes off the free space", async () => {
	// 30 cells, minus one 2-cell gap, over two flexible tracks: 14 each, with
	// the second starting after the gap.
	const {items, resolved} = await render(
		grid("grid-template-columns: 1fr 1fr; column-gap: 2px", letters(2)),
	);
	expect(items()[0].width).toBe(14);
	expect(items()[1].left).toBe(16);
	expect(resolved("grid-template-columns")).toBe("14px 14px");
});

test("row-gap separates the rows", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px; grid-auto-rows: 1px; row-gap: 1px",
			letters(2),
		),
	);
	expect(items()[1].top).toBe(2);
});

test("the gap shorthand states the row gap first", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px; grid-auto-rows: 1px; gap: 1px 2px",
			letters(4),
		),
	);
	expect(items()[1].left).toBe(6);
	expect(items()[2].top).toBe(2);
});

test("the legacy grid-gap shorthand declares the same gaps", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px; grid-auto-rows: 1px; grid-gap: 1px 2px",
			letters(4),
		),
	);
	expect(items()[1].left).toBe(6);
	expect(items()[2].top).toBe(2);
});

test("a gap does not become part of anybody's area", async () => {
	const {items} = await render(
		grid("grid-template-columns: 4px 4px; column-gap: 3px", letters(2)),
	);
	expect(items()[0].width).toBe(4);
	expect(items()[1].left).toBe(7);
});

test("an item spanning a gap takes the gap with it", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px; column-gap: 3px",
			`<i style="grid-column: 1 / 3">a</i>`,
		),
	);
	expect(item(0).width).toBe(11);
});

// ---------------------------------------------------------------------------
// Alignment (css-grid-2 §10, css-align-3)
// ---------------------------------------------------------------------------

test("an item stretches to its area by default", async () => {
	const {item} = await render(
		grid("grid-template-columns: 10px; grid-template-rows: 4px", letters(1)),
	);
	expect(item(0)).toEqual({left: 0, top: 0, width: 10, height: 4});
});

test("justify-items places every item on the inline axis", async () => {
	const {item} = await render(
		grid("grid-template-columns: 8px; justify-items: center", `<i>ab</i>`),
	);
	// A 2-cell box centered in an 8-cell area starts at 3.
	expect(item(0)).toEqual({left: 3, top: 0, width: 2, height: 1});
});

test("justify-items: end pushes items to the inline end", async () => {
	const {item} = await render(
		grid("grid-template-columns: 8px; justify-items: end", `<i>ab</i>`),
	);
	expect(item(0).left).toBe(6);
});

test("justify-self overrides justify-items for one item", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 8px 8px; justify-items: start",
			`<i>ab</i><i style="justify-self: end">cd</i>`,
		),
	);
	expect(items()[0].left).toBe(0);
	expect(items()[1].left).toBe(14);
});

test("align-items places every item on the block axis", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 6px; grid-template-rows: 5px; align-items: center",
			letters(1),
		),
	);
	// A 1-cell box centered in a 5-cell area starts at row 2.
	expect(item(0)).toEqual({left: 0, top: 2, width: 6, height: 1});
});

test("align-self: end pushes one item to the block end", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 6px; grid-template-rows: 5px",
			`<i style="align-self: end">a</i>`,
		),
	);
	expect(item(0).top).toBe(4);
});

test("the place-items shorthand states both axes", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 8px; grid-template-rows: 5px; place-items: center end",
			`<i>ab</i>`,
		),
	);
	expect(item(0)).toEqual({left: 6, top: 2, width: 2, height: 1});
});

test("start and end mean the same edges as flex-start and flex-end", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 8px 8px",
			`<i style="justify-self: start">ab</i><i style="justify-self: flex-end">cd</i>`,
		),
	);
	expect(items()[0].left).toBe(0);
	expect(items()[1].left).toBe(14);
});

test("left and right name the inline edges", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 8px 8px",
			`<i style="justify-self: right">ab</i><i style="justify-self: left">cd</i>`,
		),
	);
	expect(items()[0].left).toBe(6);
	expect(items()[1].left).toBe(8);
});

test("justify-content places the whole track set on the inline axis", async () => {
	// Two 4-cell tracks in 30 cells leave 22 free; centering puts 11 in front.
	const {items} = await render(
		grid("grid-template-columns: 4px 4px; justify-content: center", letters(2)),
	);
	expect(items()[0].left).toBe(11);
	expect(items()[1].left).toBe(15);
});

test("justify-content: space-between puts the free space between the tracks", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px; justify-content: space-between",
			letters(2),
		),
	);
	expect(items()[0]).toEqual({left: 0, top: 0, width: 4, height: 1});
	expect(items()[1]).toEqual({left: 26, top: 0, width: 4, height: 1});
});

test("justify-content: space-around gives each track half a share either side", async () => {
	// 20 free over two tracks: 10 each, half of it before the first track and
	// half after the last.
	const {items} = await render(
		grid(
			"grid-template-columns: 5px 5px; justify-content: space-around",
			letters(2),
		),
	);
	expect(items()[0].left).toBe(5);
	expect(items()[1].left).toBe(20);
});

test("justify-content: space-evenly gives every gap the same share", async () => {
	// 18 free over three gaps: 6 before, between and after.
	const {items} = await render(
		grid(
			"grid-template-columns: 6px 6px; justify-content: space-evenly",
			letters(2),
		),
	);
	expect(items()[0].left).toBe(6);
	expect(items()[1].left).toBe(18);
});

test("align-content places the track set on the block axis", async () => {
	const {items} = await render(
		grid(
			"grid-template-rows: 1px 1px; height: 6px; align-content: center",
			letters(2),
		),
	);
	expect(items().map((box) => box.top)).toEqual([2, 3]);
});

test("align-content: end pushes the rows to the bottom", async () => {
	const {items} = await render(
		grid(
			"grid-template-rows: 1px 1px; height: 6px; align-content: end",
			letters(2),
		),
	);
	expect(items().map((box) => box.top)).toEqual([4, 5]);
});

test("align-content: space-between spreads the rows over the height", async () => {
	const {items} = await render(
		grid(
			"grid-template-rows: 1px 1px; height: 6px; align-content: space-between",
			letters(2),
		),
	);
	expect(items().map((box) => box.top)).toEqual([0, 5]);
});

test("the place-content shorthand states both axes", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px; grid-template-rows: 1px; height: 5px; place-content: end center",
			letters(2),
		),
	);
	expect(items()[0].top).toBe(4);
	expect(items()[0].left).toBe(11);
});

test("auto margins take the free space before alignment does", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 9px",
			`<i style="margin: auto; width: 3px">a</i>`,
		),
	);
	// 6 cells free, split between the two auto margins.
	expect(item(0)).toEqual({left: 3, top: 0, width: 3, height: 1});
});

test("one auto margin pushes the item to the far edge", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 9px",
			`<i style="margin-left: auto; width: 3px">a</i>`,
		),
	);
	expect(item(0).left).toBe(6);
});

test("baseline alignment puts first rows on a line", async () => {
	// The padded item's first row sits two cells down inside its box, so the
	// item beside it is pushed down to meet it.
	const {items} = await render(
		grid(
			"grid-template-columns: 6px 6px; align-items: baseline",
			`<i style="padding-top: 2px">a</i><i>b</i>`,
		),
	);
	expect(items()[0].top).toBe(0);
	expect(items()[1].top).toBe(2);
});

test("a row is sized for the baseline alignment it is about to be given", async () => {
	// The pushed item is two rows tall and starts two rows down, so the row
	// has to be four tall for both to fit (css-grid-2 §12.5).
	const {items, resolved} = await render(
		grid(
			"grid-template-columns: 6px 6px; align-items: baseline",
			`<i style="padding-top: 2px">a</i><i>b<br>c</i>`,
		),
	);
	expect(resolved("grid-template-rows")).toBe("4px");
	expect(items()[1].top).toBe(2);
});

test("baseline groups are per row", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 6px 6px; grid-auto-rows: 3px; align-items: baseline",
			`<i style="padding-top: 2px">a</i><i>b</i><i>c</i><i>d</i>`,
		),
	);
	// The second row has no padded item, so nothing in it is pushed down.
	expect(items()[2].top).toBe(3);
	expect(items()[3].top).toBe(3);
});

// ---------------------------------------------------------------------------
// Absolutely positioned children (css-grid-2 §9)
// ---------------------------------------------------------------------------

test("a placed out-of-flow child is contained by its grid area", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px; position: relative; height: 3px",
			`<i>x</i><i style="position: absolute; grid-column: 2 / 4; grid-row: 1">p</i>`,
		),
	);
	expect(item(1)).toEqual({left: 5, top: 0, width: 10, height: 3});
});

test("insets on a placed out-of-flow child measure from its area", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px 5px; position: relative; grid-template-rows: 4px",
			`<i>x</i><i style="position: absolute; grid-column: 2 / 4; grid-row: 1; left: 1px; top: 1px; width: 3px; height: 1px">p</i>`,
		),
	);
	expect(item(1)).toEqual({left: 6, top: 1, width: 3, height: 1});
});

test("an out-of-flow child with no placement hangs from the padding box", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 5px 5px; position: relative; padding-left: 2px; height: 3px",
			`<i>x</i><i style="position: absolute; width: 2px; height: 1px">p</i>`,
		),
	);
	expect(item(1).left).toBe(0);
	expect(item(1).top).toBe(0);
});

test("an out-of-flow child takes no cell on the grid", async () => {
	// It is not a grid item, so auto-placement never sees it and the item
	// after it takes the cell it appears to sit in.
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px; position: relative",
			`<i style="position:absolute">p</i><i>a</i><i>b</i>`,
		),
	);
	expect(items()[1].left).toBe(0);
	expect(items()[2].left).toBe(4);
});

// ---------------------------------------------------------------------------
// display: grid and inline-grid
// ---------------------------------------------------------------------------

test("a grid container fills its block container's width", async () => {
	const {box} = await render(grid("", letters(1)));
	expect(box("#g").width).toBe(30);
});

test("a grid container with no items is as tall as its explicit rows", async () => {
	const {box} = await render(grid("grid-template-rows: 2px 3px", ""));
	expect(box("#g").height).toBe(5);
});

test("an inline-grid sits on the line whole", async () => {
	const {box, rows} = await render(
		`<p>before <span id="g" style="display:inline-grid; grid-template-columns: 4px 4px"><i>ab</i><i>cd</i><i>ef</i></span> after</p>`,
	);
	// The grid is two 4-cell columns and two rows, placed on the line after
	// "before ".
	expect(box("#g")).toEqual({left: 7, top: 0, width: 8, height: 2});
	expect(rows()[0]).toBe("before ab  cd   after");
	expect(rows()[1]).toBe("       ef");
});

test("collapsible white space between items is not an item", async () => {
	// css-flexbox-1 §4, which css-grid-2 §6 takes over: an anonymous item of
	// nothing but collapsible white space is not rendered, so the newlines in
	// multi-line markup do not eat cells.
	const {items} = await render(
		`<div id="g" style="display:grid; grid-template-columns: 4px 4px">
			<i>a</i>
			<i>b</i>
		</div>`,
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[4, 0],
	]);
});

test("text directly in a grid container becomes an item of its own", async () => {
	const {items} = await render(
		`<div id="g" style="display:grid; grid-template-columns: 4px 4px">loose<i>a</i></div>`,
	);
	expect(items()[0].left).toBe(4);
});

test("a grid item is blockified", async () => {
	// css-display-3 §2.7: an inline child of a grid container computes to
	// block, so its width applies.
	const {item} = await render(
		grid("grid-template-columns: 10px", `<i style="width: 4px">a</i>`),
	);
	expect(item(0).width).toBe(4);
});

test("display:none on an item removes it from the grid", async () => {
	const {items} = await render(
		grid(
			"grid-template-columns: 4px 4px",
			`<i style="display:none">a</i><i>b</i>`,
		),
	);
	expect(items()[1].left).toBe(0);
});

// ---------------------------------------------------------------------------
// Item sizing
// ---------------------------------------------------------------------------

test("a definite width on an item wins over the stretch", async () => {
	const {item} = await render(
		grid("grid-template-columns: 10px", `<i style="width: 4px">a</i>`),
	);
	expect(item(0).width).toBe(4);
});

test("min-width floors a stretched item", async () => {
	const {item} = await render(
		grid("grid-template-columns: 4px", `<i style="min-width: 7px">a</i>`),
	);
	expect(item(0).width).toBe(7);
});

test("max-width caps a stretched item", async () => {
	const {item} = await render(
		grid("grid-template-columns: 10px", `<i style="max-width: 4px">a</i>`),
	);
	expect(item(0).width).toBe(4);
});

test("an item's margins come off its area", async () => {
	const {item} = await render(
		grid("grid-template-columns: 10px", `<i style="margin: 0 2px">a</i>`),
	);
	expect(item(0)).toEqual({left: 2, top: 0, width: 6, height: 1});
});

test("an item's padding and border stay inside its area", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 10px",
			`<i style="border: 1px solid; padding: 0 1px">a</i>`,
		),
	);
	expect(item(0).width).toBe(10);
	expect(item(0).height).toBe(3);
});

test("a percentage width on an item resolves against its area", async () => {
	const {item} = await render(
		grid("grid-template-columns: 10px 10px", `<i style="width: 50%">a</i>`),
	);
	expect(item(0).width).toBe(5);
});

test("an item's own content decides an auto track's size", async () => {
	const {resolved} = await render(
		grid(
			"grid-template-columns: auto auto; justify-content: start",
			`<i>abcd</i><i>xy</i>`,
		),
	);
	expect(resolved("grid-template-columns")).toBe("4px 2px");
});

test("a spanning item widens the tracks it crosses only by what it needs", async () => {
	// css-grid-2 §12.5.3: the spanning item's 12 cells are shared out over
	// what the two auto tracks do not already provide.
	const {resolved} = await render(
		grid(
			"grid-template-columns: auto auto; justify-content: start",
			`<i>ab</i><i>cd</i><i style="grid-column: 1 / 3">unbreakable1</i>`,
		),
	);
	expect(resolved("grid-template-columns")).toBe("6px 6px");
});

test("a spanning item does not widen a fixed track", async () => {
	const {resolved} = await render(
		grid(
			"grid-template-columns: 3px auto; justify-content: start",
			`<i style="grid-column: 1 / 3">unbreakable1</i>`,
		),
	);
	expect(resolved("grid-template-columns")).toBe("3px 9px");
});

// ---------------------------------------------------------------------------
// The shorthands (css-grid-2 §7.4, §8.4)
// ---------------------------------------------------------------------------

test("grid-template states rows and columns across a slash", async () => {
	const {items, resolved} = await render(
		grid("grid-template: 2px 2px / 4px 4px", letters(3)),
	);
	expect(resolved("grid-template-columns")).toBe("4px 4px");
	expect(resolved("grid-template-rows")).toBe("2px 2px");
	expect(items()[2]).toEqual({left: 0, top: 2, width: 4, height: 2});
});

test("grid-template's visual form states the areas and the row sizes", async () => {
	const {box, resolved} = await render(
		grid(
			`grid-template: "h h" 1px "s m" 2px / 6px 6px`,
			`<i class="m" style="grid-area:m">m</i><i class="h" style="grid-area:h">h</i>`,
		),
	);
	expect(resolved("grid-template-rows")).toBe("1px 2px");
	expect(box("i.h")).toEqual({left: 0, top: 0, width: 12, height: 1});
	expect(box("i.m")).toEqual({left: 6, top: 1, width: 6, height: 2});
});

test("grid-template's visual form carries line names between its rows", async () => {
	const {item} = await render(
		grid(
			`grid-template: [top] "a a" 1px [mid] "b b" 2px [bot] / 6px 6px`,
			`<i style="grid-row: mid / bot; grid-column: 1">x</i>`,
		),
	);
	expect(item(0)).toEqual({left: 0, top: 1, width: 6, height: 2});
});

test("the grid shorthand states the whole explicit grid", async () => {
	const {resolved} = await render(grid("grid: 2px 2px / 4px 4px", letters(2)));
	expect(resolved("grid-template-columns")).toBe("4px 4px");
	expect(resolved("grid-template-rows")).toBe("2px 2px");
});

test("grid with auto-flow sizes the implicit tracks", async () => {
	const {resolved, items} = await render(
		grid("grid: auto-flow 2px / 4px 4px", letters(3)),
	);
	expect(resolved("grid-template-columns")).toBe("4px 4px");
	expect(resolved("grid-template-rows")).toBe("2px 2px");
	expect(items()[2].top).toBe(2);
});

test("grid with auto-flow on the other side of the slash flows in columns", async () => {
	const {items} = await render(
		grid("grid: 1px 1px / auto-flow 4px", letters(3)),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[0, 1],
		[4, 0],
	]);
});

test("grid-area states all four lines", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px; grid-template-rows: 1px 1px",
			`<i style="grid-area: 1 / 2 / 3 / 4">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 0, width: 8, height: 2});
});

test("grid-area with one name places by that area", async () => {
	const {item} = await render(
		grid(
			`grid-template-areas: "x y"; grid-template-columns: 5px 5px`,
			`<i style="grid-area: y">a</i>`,
		),
	);
	expect(item(0).left).toBe(5);
});

test("grid-row with one number spans one track", async () => {
	const {item} = await render(
		grid(
			"grid-template-columns: 4px; grid-template-rows: 1px 1px 1px",
			`<i style="grid-row: 2">a</i>`,
		),
	);
	expect(item(0)).toEqual({left: 0, top: 1, width: 4, height: 1});
});

test("grid-column with one name spans the area of that name", async () => {
	// css-grid-2 §8.3.2: an omitted end repeats a custom-ident start, so a
	// name alone names both edges of its area.
	const {item} = await render(
		grid(
			`grid-template-areas: "a b b"; grid-template-columns: 4px 4px 4px`,
			`<i style="grid-column: b">x</i>`,
		),
	);
	expect(item(0)).toEqual({left: 4, top: 0, width: 8, height: 1});
});

// ---------------------------------------------------------------------------
// Resolved values (CSSOM)
// ---------------------------------------------------------------------------

test("grid-template-columns resolves to the used track sizes", async () => {
	const {resolved} = await render(
		grid("grid-template-columns: repeat(2, 1fr)", letters(2)),
		21,
	);
	// 21 cells over two flexible tracks: 10.5 each, tiling as 11 and 10.
	expect(resolved("grid-template-columns")).toBe("11px 10px");
});

test("grid-template-rows resolves to the used track sizes, implicit ones included", async () => {
	const {resolved} = await render(
		grid(
			"grid-template-columns: 4px; grid-template-rows: 2px; grid-auto-rows: 3px",
			letters(2),
		),
	);
	expect(resolved("grid-template-rows")).toBe("2px 3px");
});

test("a box that is not a grid reports the track list it was given", async () => {
	const {resolved} = await render(
		`<div id="g" style="grid-template-columns: 1fr 1fr"><i>a</i></div>`,
	);
	expect(resolved("grid-template-columns")).toBe("1fr 1fr");
});

test("a grid with no tracks resolves to none", async () => {
	const {resolved} = await render(`<div id="g" style="display:grid"></div>`);
	expect(resolved("grid-template-columns")).toBe("none");
});

test("the placement properties report what was declared", async () => {
	const {resolved} = await render(
		grid(
			"grid-template-columns: 4px 4px 4px",
			`<i id="i" style="grid-column: 2 / span 2">a</i>`,
		),
	);
	expect(resolved("grid-column-start", "#i")).toBe("2");
	expect(resolved("grid-column-end", "#i")).toBe("span 2");
	expect(resolved("grid-row-start", "#i")).toBe("auto");
});

test("grid-template-areas reports its rows", async () => {
	const {resolved} = await render(grid(`grid-template-areas: "a b" "c d"`, ""));
	expect(resolved("grid-template-areas")).toBe(`"a b" "c d"`);
});

test("a length in a track list computes to cells", async () => {
	const {resolved} = await render(
		`<div id="g" style="grid-template-columns: 2ch 1em"></div>`,
	);
	expect(resolved("grid-template-columns")).toBe("2px 1px");
});

test("grid-auto-flow reports its keywords", async () => {
	const {resolved} = await render(grid("grid-auto-flow: column dense", ""));
	expect(resolved("grid-auto-flow")).toBe("column dense");
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

test("subgrid is refused, and the track list declares nothing", async () => {
	// css-grid-2 §9.5 takes an ancestor grid's tracks, which this engine does
	// not implement: the declaration is invalid here, exactly as it is in a
	// browser that does not implement it.
	const {items} = await render(
		grid("grid-template-columns: subgrid", letters(2)),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[0, 1],
	]);
});

test("masonry is refused", async () => {
	const {items} = await render(
		grid(
			"grid-template-rows: masonry; grid-template-columns: 4px 4px",
			letters(2),
		),
	);
	expect(items().map((box) => [box.left, box.top])).toEqual([
		[0, 0],
		[4, 0],
	]);
});

test("a track list this engine cannot parse declares nothing", async () => {
	const {item} = await render(
		grid("grid-template-columns: 4px nonsense(2)", letters(1)),
	);
	expect(item(0).width).toBe(30);
});

// ---------------------------------------------------------------------------
// Mutation: a grid built by mutation matches one built at once
// ---------------------------------------------------------------------------

/**
 * Render `initial`, run `mutate`, and compare the result -- geometry and
 * painted cells alike -- against the same document rendered from scratch.
 * The two paths through the engine are the incremental one and the fresh
 * one, and a grid is only correct if they agree.
 */
async function mutationMatchesFresh(
	initial: string,
	mutate: (document: Document) => void,
	cols = 30,
	rows = 8,
): Promise<void> {
	const before = await render(initial, cols, rows);
	mutate(before.document);
	await nextFrame(before.dom);

	const finalHTML = before.document.body.innerHTML;
	const fresh = await render(finalHTML, cols, rows);

	expect(before.rows()).toEqual(fresh.rows());
	const geometry = (rendered: Rendered) =>
		Array.from(rendered.document.querySelectorAll("*")).map((element) => {
			const box = boxOf(element);
			return `${element.tagName}#${element.id}.${element.className}: ${box.left},${box.top} ${box.width}x${box.height}`;
		});
	expect(geometry(before)).toEqual(geometry(fresh));
}

test("rewriting the track list relays the grid out", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 10px 10px", letters(4)),
		(document) => {
			const container = document.querySelector("#g") as HTMLElement;
			container.style.gridTemplateColumns = "6px 1fr 4px";
		},
	);
});

test("moving an item to another cell relays the grid out", async () => {
	await mutationMatchesFresh(
		grid(
			"grid-template-columns: repeat(3, 8px); grid-auto-rows: 1px",
			letters(4),
		),
		(document) => {
			const item = document.querySelectorAll("i")[0] as HTMLElement;
			item.style.gridColumn = "2 / 4";
			item.style.gridRow = "2";
		},
	);
});

test("hiding an item after the first frame repacks the grid", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 8px 8px", letters(5)),
		(document) => {
			(document.querySelectorAll("i")[1] as HTMLElement).style.display = "none";
		},
	);
});

test("turning a block into a grid after the first frame lays it out as one", async () => {
	await mutationMatchesFresh(
		`<div id="g" style="display:block">${letters(4)}</div>`,
		(document) => {
			const container = document.querySelector("#g") as HTMLElement;
			container.style.display = "grid";
			container.style.gridTemplateColumns = "7px 7px";
		},
	);
});

test("turning a grid back into a block after the first frame stacks it", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 7px 7px", letters(4)),
		(document) => {
			const container = document.querySelector("#g") as HTMLElement;
			container.style.display = "block";
			container.style.gridTemplateColumns = "";
		},
	);
});

test("adding an item after the first frame places it in the next cell", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 8px 8px; grid-auto-rows: 1px", letters(3)),
		(document) => {
			const item = document.createElement("i");
			item.textContent = "d";
			document.querySelector("#g")!.appendChild(item);
		},
	);
});

test("removing an item after the first frame repacks the grid", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 8px 8px; grid-auto-rows: 1px", letters(5)),
		(document) => {
			const items = document.querySelectorAll("i");
			items[0].remove();
		},
	);
});

test("rewriting the area map after the first frame moves every item", async () => {
	await mutationMatchesFresh(
		grid(
			`grid-template-areas: "a b" "c c"; grid-template-columns: 8px 8px; grid-template-rows: 1px 1px`,
			`<i style="grid-area:a">a</i><i style="grid-area:b">b</i><i style="grid-area:c">c</i>`,
		),
		(document) => {
			const container = document.querySelector("#g") as HTMLElement;
			container.style.gridTemplateAreas = `"a a" "b c"`;
		},
	);
});

test("changing the gap after the first frame respaces the tracks", async () => {
	await mutationMatchesFresh(
		grid("grid-template-columns: 1fr 1fr; grid-auto-rows: 1px", letters(4)),
		(document) => {
			(document.querySelector("#g") as HTMLElement).style.gap = "1px 3px";
		},
	);
});

test("changing an item's text after the first frame resizes its auto track", async () => {
	await mutationMatchesFresh(
		grid(
			"grid-template-columns: auto auto; justify-content: start",
			letters(2),
		),
		(document) => {
			document.querySelectorAll("i")[0].textContent = "muchlonger";
		},
	);
});

test("changing grid-auto-flow after the first frame re-places every item", async () => {
	await mutationMatchesFresh(
		grid("grid-template-rows: 1px 1px; grid-auto-columns: 6px", letters(4)),
		(document) => {
			(document.querySelector("#g") as HTMLElement).style.gridAutoFlow =
				"column";
		},
	);
});

test("changing an item's alignment after the first frame moves it in its area", async () => {
	await mutationMatchesFresh(
		grid(
			"grid-template-columns: 10px 10px; grid-template-rows: 3px",
			`<i>ab</i><i>cd</i>`,
		),
		(document) => {
			const item = document.querySelectorAll("i")[1] as HTMLElement;
			item.style.justifySelf = "end";
			item.style.alignSelf = "end";
		},
	);
});

test("a resize relays the flexible tracks out", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = grid(
		"grid-template-columns: repeat(3, 1fr)",
		boxes(3),
	);
	await nextFrame(dom);

	terminal.resize(60, 8);
	(terminal as unknown as {emit(event: string): void}).emit("SIGWINCH");

	const widths = (): number[] =>
		Array.from(dom.document.querySelectorAll("i")).map(
			(element) => boxOf(element).width,
		);
	// The relayout arrives after the resize debounce and a cursor round trip.
	for (let attempt = 0; attempt < 40; attempt++) {
		if (widths()[0] === 20) break;
		await nextFrame(dom);
	}
	expect(widths()).toEqual([20, 20, 20]);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("an area-map dashboard paints where its picture says", async () => {
	const {rows} = await render(
		grid(
			`grid-template-areas: "head head" "side main" "foot foot";` +
				`grid-template-columns: 8px 1fr; grid-template-rows: 1px 2px 1px`,
			`<i style="grid-area:head">HEAD</i>` +
				`<i style="grid-area:side">SIDE</i>` +
				`<i style="grid-area:main">MAIN</i>` +
				`<i style="grid-area:foot">FOOT</i>`,
		),
		24,
		6,
	);
	expect(rows().slice(0, 4)).toEqual(["HEAD", "SIDE    MAIN", "", "FOOT"]);
});

test("a grid of bordered cells paints its whole frame", async () => {
	const {painted} = await render(
		grid(
			"grid-template-columns: repeat(2, 1fr); grid-auto-rows: 3px",
			`<i style="border:1px solid">a</i><i style="border:1px solid">b</i>` +
				`<i style="border:1px solid">c</i><i style="border:1px solid">d</i>`,
		),
		20,
		8,
	);
	expect(painted()).toMatchSnapshot();
});
