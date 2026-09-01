import {describe, expect, test} from "@b9g/libuild/test";

import {LayoutNode} from "../src/internal/layout.js";

/**
 * Spec tests for the layout engine, driven directly rather than through the
 * DOM.
 *
 * The ANSI snapshots only prove the engine reproduces what termdom's own
 * documents happen to exercise. They say nothing about flexbox itself, and a
 * bug in a corner they never reach would sail through every one of them.
 *
 * Every expected value below is computed by hand from css-flexbox-1 and written
 * as a literal, with the derivation in a comment. None of them were read off
 * the implementation -- an expectation generated from the code under test only
 * proves the code agrees with itself, and would enshrine its bugs as the
 * contract.
 */

// termdom drives the engine with web defaults, which are also the CSS initial
// values: flex-direction row, flex-shrink 1, align-content stretch.
function node(): LayoutNode {
	return new LayoutNode();
}

function box(parent: LayoutNode, index = parent.children.length): LayoutNode {
	const child = node();
	parent.insertChild(child, index);
	return child;
}

function rect(n: LayoutNode): {
	left: number;
	top: number;
	width: number;
	height: number;
} {
	return {
		left: n.layout.left,
		top: n.layout.top,
		width: n.getComputedWidth(),
		height: n.getComputedHeight(),
	};
}

describe("flex-basis auto vs content sizing (css-flexbox-1 §7.2.3)", () => {
	test("flex-basis auto falls back to the main size property", () => {
		// Row container, item with width 30 and flex-basis auto.
		// flex-basis: auto -> use the main size property -> width -> 30.
		// No grow, no shrink, so the used main size is the flex base size.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setWidth(30);
		item.setHeight(10);
		item.setFlexBasis("auto");
		item.setFlexGrow(0);
		item.setFlexShrink(0);

		root.calculateLayout(100, 20);

		expect(rect(item).width).toBe(30);
	});

	test("a definite flex-basis wins over the width property", () => {
		// flex base size comes from flex-basis (50), not width (30).
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setWidth(30);
		item.setHeight(10);
		item.setFlexBasis(50);
		item.setFlexGrow(0);
		item.setFlexShrink(0);

		root.calculateLayout(100, 20);

		expect(rect(item).width).toBe(50);
	});

	test("flex-basis auto with width auto sizes to max-content", () => {
		// Both flex-basis and width are auto, so the flex base size is the
		// item's max-content size. The item is itself a row container holding a
		// 25-wide child, so its max-content main size is 25.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setFlexBasis("auto");
		item.setWidth("auto");
		item.setFlexGrow(0);
		item.setFlexShrink(0);

		const content = box(item);
		content.setWidth(25);
		content.setHeight(10);

		root.calculateLayout(100, 20);

		expect(rect(item).width).toBe(25);
	});
});

describe("min/max clamping against grow and shrink (css-flexbox-1 §9.7)", () => {
	test("max-width freezes a growing item and its surplus goes to the others", () => {
		// Container 100. A and B both flex: 1 1 0, A has max-width 30.
		//
		// Free space 100, sum of grow factors 2 -> each targets 50.
		// A violates its max (50 -> 30): a max violation, total violation < 0,
		// so A freezes at 30. B then re-runs against the space A left behind:
		// remaining free = 100 - 30 = 70, so B = 70.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const a = box(root);
		a.setFlexGrow(1);
		a.setFlexShrink(1);
		a.setFlexBasis(0);
		a.setMaxWidth(30);
		a.setHeight(10);

		const b = box(root);
		b.setFlexGrow(1);
		b.setFlexShrink(1);
		b.setFlexBasis(0);
		b.setHeight(10);

		root.calculateLayout(100, 20);

		expect(rect(a).width).toBe(30);
		expect(rect(b).width).toBe(70);
		expect(rect(a).left).toBe(0);
		expect(rect(b).left).toBe(30);
	});

	test("min-width freezes a growing item and the rest share what is left", () => {
		// Container 100. A and B both flex: 1 1 0, A has min-width 80.
		//
		// Each targets 50. A violates its min (50 -> 80): a min violation,
		// total violation > 0, so A freezes at 80. B re-runs: remaining free =
		// 100 - 80 = 20, so B = 20.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const a = box(root);
		a.setFlexGrow(1);
		a.setFlexBasis(0);
		a.setMinWidth(80);
		a.setHeight(10);

		const b = box(root);
		b.setFlexGrow(1);
		b.setFlexBasis(0);
		b.setHeight(10);

		root.calculateLayout(100, 20);

		expect(rect(a).width).toBe(80);
		expect(rect(b).width).toBe(20);
	});

	test("min-width freezes a shrinking item and the rest absorb the overflow", () => {
		// Container 100. A and B both flex-basis 80, flex-shrink 1. A has
		// min-width 60. Total base 160, overflow 60.
		//
		// Shrinking is weighted by the scaled flex shrink factor
		// (shrink x base size): A = 80, B = 80, sum 160. A's share of the
		// overflow is 60 * 80/160 = 30, giving 80 - 30 = 50 -- below its min, a
		// min violation, so A freezes at 60.
		//
		// B re-runs: remaining free = 100 - (60 + 80) = -40, and B is the only
		// unfrozen item, so it absorbs all of it: 80 - 40 = 40.
		// The line then fills the container exactly: 60 + 40 = 100.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const a = box(root);
		a.setFlexBasis(80);
		a.setFlexShrink(1);
		a.setMinWidth(60);
		a.setHeight(10);

		const b = box(root);
		b.setFlexBasis(80);
		b.setFlexShrink(1);
		b.setHeight(10);

		root.calculateLayout(100, 20);

		expect(rect(a).width).toBe(60);
		expect(rect(b).width).toBe(40);
		expect(rect(a).left).toBe(0);
		expect(rect(b).left).toBe(60);
	});
});

describe("flex-wrap with align-content (css-flexbox-1 §9.6)", () => {
	// Three 40-wide items in a 100-wide wrapping container.
	//
	// Line collection uses the hypothetical main size: 40 + 40 = 80 fits, and
	// adding the third would make 120 > 100, so it starts a new line.
	//   line 1: items 1 and 2   line 2: item 3
	//
	// Each line's cross size is 10, so the lines total 20 in a 40-tall
	// container: 20 of free cross space to distribute.
	function wrapped(
		alignContent: "flex-start" |
			"flex-end" |
			"center" |
			"space-between" |
			"space-around" |
			"stretch",
	): LayoutNode[] {
		const root = node();
		root.setWidth(100);
		root.setHeight(40);
		root.setFlexWrap("wrap");
		root.setAlignContent(alignContent);
		root.setAlignItems("flex-start");

		const items = [box(root), box(root), box(root)];
		for (const item of items) {
			item.setWidth(40);
			item.setHeight(10);
			item.setFlexShrink(0);
		}

		root.calculateLayout(100, 40);
		return items;
	}

	test("items wrap onto a second line when the first is full", () => {
		const [one, two, three] = wrapped("flex-start");
		expect(rect(one).left).toBe(0);
		expect(rect(two).left).toBe(40);
		// Wrapped to the next line, so back to the main-start edge.
		expect(rect(three).left).toBe(0);
	});

	test("align-content: flex-start packs lines at the cross-start edge", () => {
		// Lines at 0 and 10; the 20 of free space is left at the end.
		const [one, two, three] = wrapped("flex-start");
		expect(rect(one).top).toBe(0);
		expect(rect(two).top).toBe(0);
		expect(rect(three).top).toBe(10);
	});

	test("align-content: flex-end packs lines at the cross-end edge", () => {
		// All 20 of free space goes in front: lines at 20 and 30.
		const [one, , three] = wrapped("flex-end");
		expect(rect(one).top).toBe(20);
		expect(rect(three).top).toBe(30);
	});

	test("align-content: center packs lines around the cross midpoint", () => {
		// Half the free space in front: 20/2 = 10, so lines at 10 and 20.
		const [one, , three] = wrapped("center");
		expect(rect(one).top).toBe(10);
		expect(rect(three).top).toBe(20);
	});

	test("align-content: space-between puts all free space between the lines", () => {
		// First line flush at 0, last flush at the end; the gap is the whole
		// 20 of free space: 0, then 10 + 20 = 30.
		const [one, , three] = wrapped("space-between");
		expect(rect(one).top).toBe(0);
		expect(rect(three).top).toBe(30);
	});

	test("align-content: space-around gives each line equal space on both sides", () => {
		// 20 free / 2 lines = 10 per line, half of it (5) leading each.
		// Line 1 at 5; line 2 at 5 + 10 + 10 = 25.
		const [one, , three] = wrapped("space-around");
		expect(rect(one).top).toBe(5);
		expect(rect(three).top).toBe(25);
	});

	test("align-content: space-evenly puts equal gaps everywhere", () => {
		// A taller container, to keep the thirds whole: 50 - 20 = 30 free across
		// 2 lines, which space-evenly splits into 3 equal gaps of 10 -- one
		// before each line and one after the last.
		// Line 1 at 10; line 2 at 10 + 10 + 10 = 30.
		const root = node();
		root.setWidth(100);
		root.setHeight(50);
		root.setFlexWrap("wrap");
		root.setAlignContent("space-evenly");
		root.setAlignItems("flex-start");

		const items = [box(root), box(root), box(root)];
		for (const item of items) {
			item.setWidth(40);
			item.setHeight(10);
			item.setFlexShrink(0);
		}

		root.calculateLayout(100, 50);

		expect(rect(items[0]).top).toBe(10);
		expect(rect(items[2]).top).toBe(30);
	});

	test("align-content: stretch grows the lines to fill the cross axis", () => {
		// 20 free / 2 lines = each line grows from 10 to 20.
		// Lines start at 0 and 20. The items keep their definite height of 10.
		const [one, , three] = wrapped("stretch");
		expect(rect(one).top).toBe(0);
		expect(rect(three).top).toBe(20);
		expect(rect(one).height).toBe(10);
	});
});

describe("percentage margins and padding resolve against the containing block width", () => {
	// CSS resolves percentage padding and margin against the *inline* size of
	// the containing block -- its width -- on every edge, including top and
	// bottom. Resolving a vertical percentage against the height is the classic
	// mistake, so these containers are deliberately not square: 200 wide, 100
	// tall, with 10% margins and padding. Against the width they are 20;
	// against the height they would be 10.

	test("percentage padding resolves against width on every edge", () => {
		const root = node();
		root.setWidth(200);
		root.setHeight(100);
		root.setFlexDirection("column");

		const child = box(root);
		child.setPadding("all", "10%");

		const grandchild = box(child);
		grandchild.setWidth(10);
		grandchild.setHeight(5);

		root.calculateLayout(200, 100);

		// Padding is 10% of 200 = 20 on every edge, so the content box of the
		// child starts at (20, 20) within it.
		expect(rect(grandchild).left).toBe(20);
		expect(rect(grandchild).top).toBe(20);
		// Child height = padding-top 20 + content 5 + padding-bottom 20 = 45.
		expect(rect(child).height).toBe(45);
	});

	test("percentage margin resolves against width, not height", () => {
		const root = node();
		root.setWidth(200);
		root.setHeight(100);
		root.setFlexDirection("column");

		const child = box(root);
		child.setHeight(10);
		child.setMargin("top", "10%");
		child.setMargin("left", "10%");

		root.calculateLayout(200, 100);

		// Both margins are 10% of the containing block's width (200) = 20.
		// A margin-top of 10 would mean it had been resolved against the height.
		expect(rect(child).top).toBe(20);
		expect(rect(child).left).toBe(20);
		// Stretched into what the left margin leaves: 200 - 20 = 180.
		expect(rect(child).width).toBe(180);
	});
});

describe("auto margins (css-flexbox-1 §9.5)", () => {
	test("auto margins on both sides center an item on the main axis", () => {
		// Free space 100 - 20 = 80, split evenly between the two auto margins.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setWidth(20);
		item.setHeight(10);
		item.setFlexShrink(0);
		item.setMargin("left", "auto");
		item.setMargin("right", "auto");

		root.calculateLayout(100, 20);

		expect(rect(item).left).toBe(40);
	});

	test("a single auto margin absorbs all the free space", () => {
		// margin-left: auto takes all 80, pushing the item to the main-end edge.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setWidth(20);
		item.setHeight(10);
		item.setFlexShrink(0);
		item.setMargin("left", "auto");

		root.calculateLayout(100, 20);

		expect(rect(item).left).toBe(80);
	});

	test("auto margins center an item on the cross axis", () => {
		// Cross free space 20 - 10 = 10, split evenly -> top 5.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);

		const item = box(root);
		item.setWidth(20);
		item.setHeight(10);
		item.setMargin("top", "auto");
		item.setMargin("bottom", "auto");

		root.calculateLayout(100, 20);

		expect(rect(item).top).toBe(5);
	});

	test("auto margins take priority over justify-content", () => {
		// Auto margins absorb the free space before justify-content is applied,
		// so there is none left for it to distribute: margin-right: auto pins
		// the item to main-start even though justify-content is flex-end.
		const root = node();
		root.setWidth(100);
		root.setHeight(20);
		root.setJustifyContent("flex-end");

		const item = box(root);
		item.setWidth(20);
		item.setHeight(10);
		item.setFlexShrink(0);
		item.setMargin("right", "auto");

		root.calculateLayout(100, 20);

		expect(rect(item).left).toBe(0);
	});
});

describe("align-items: baseline (css-flexbox-1 §8.5)", () => {
	// Two items in a row. A has 2 rows of padding above its text, B has none.
	//
	// A's first row therefore sits 2 below its own top edge, B's sits at 0.
	// Baseline alignment aligns the *rows*, so A (the larger offset) goes flush
	// against the line and B is pushed down by 2 - 0 = 2 to meet it. Both text
	// rows then land on row 2.
	//
	// This is exactly where baseline and flex-start part company: under
	// flex-start both boxes would sit at 0 and the text rows would be on
	// different lines.
	function baselineRow(alignItems: "baseline" | "flex-start"): {
		a: LayoutNode;
		b: LayoutNode;
		aText: LayoutNode;
		bText: LayoutNode;
	} {
		const root = node();
		root.setWidth(100);
		root.setHeight(20);
		root.setAlignItems(alignItems);

		const a = box(root);
		a.setPadding("top", 2);
		const aText = box(a);
		aText.setWidth(10);
		aText.setHeight(1);

		const b = box(root);
		const bText = box(b);
		bText.setWidth(10);
		bText.setHeight(1);

		root.calculateLayout(100, 20);
		return {a, b, aText, bText};
	}

	test("aligns the first rows of items with different leading padding", () => {
		const {a, b, aText, bText} = baselineRow("baseline");

		// A is flush; B is pushed down to meet it.
		expect(rect(a).top).toBe(0);
		expect(rect(b).top).toBe(2);

		// Which is the whole point: both text rows end up on the same row.
		const aTextRow = rect(a).top + rect(aText).top;
		const bTextRow = rect(b).top + rect(bText).top;
		expect(aTextRow).toBe(2);
		expect(bTextRow).toBe(2);
		expect(aTextRow).toBe(bTextRow);
	});

	test("is not the same as flex-start", () => {
		// Under flex-start both boxes sit at 0, so the text rows are on
		// different lines (2 and 0). If baseline were quietly treated as
		// flex-start, this is the assertion that would catch it.
		const {a, b, aText, bText} = baselineRow("flex-start");

		expect(rect(a).top).toBe(0);
		expect(rect(b).top).toBe(0);

		const aTextRow = rect(a).top + rect(aText).top;
		const bTextRow = rect(b).top + rect(bText).top;
		expect(aTextRow).toBe(2);
		expect(bTextRow).toBe(0);
		expect(aTextRow).not.toBe(bTextRow);
	});
});

describe("gap (css-align-3)", () => {
	test("column-gap separates items on the main axis", () => {
		// Three 6-wide items with a 3-cell column gap: 0, 6+3=9, 9+6+3=18.
		const root = node();
		root.setWidth(40);
		root.setHeight(3);
		root.setGap("column", 3);

		const items = [box(root), box(root), box(root)];
		for (const item of items) {
			item.setWidth(6);
			item.setHeight(1);
			item.setFlexShrink(0);
		}

		root.calculateLayout(40, 3);

		expect(rect(items[0]).left).toBe(0);
		expect(rect(items[1]).left).toBe(9);
		expect(rect(items[2]).left).toBe(18);
	});

	test("gaps are taken off the top before flexible lengths are resolved", () => {
		// A 32-wide row, three flex: 1 items, 2-cell gaps. The gaps are not space
		// the items may grow into: 32 - 2 gaps of 2 = 28 to share three ways.
		// 28/3 is not whole, so edge rounding gives 9, 10, 9 -- summing to 28, with
		// the items at 0, 9+2=11, and 11+10+2=23.
		const root = node();
		root.setWidth(32);
		root.setHeight(3);
		root.setGap("column", 2);

		const items = [box(root), box(root), box(root)];
		for (const item of items) {
			item.setFlexGrow(1);
			item.setFlexBasis(0);
			item.setHeight(1);
		}

		root.calculateLayout(32, 3);

		const widths = items.map((item) => rect(item).width);
		expect(widths.reduce((sum, w) => sum + w, 0)).toBe(28);
		expect(rect(items[0]).left).toBe(0);
		expect(rect(items[1]).left).toBe(11);
		expect(rect(items[2]).left).toBe(23);
	});

	test("a gap counts against the line when deciding where to wrap", () => {
		// 8 + 2 + 8 = 18 fits in 20, but adding the third would need 28.
		// The row gap then separates the two lines: line 2 at 1 + 1 = 2.
		const root = node();
		root.setWidth(20);
		root.setHeight(10);
		root.setFlexWrap("wrap");
		root.setAlignContent("flex-start");
		root.setAlignItems("flex-start");
		root.setGap("column", 2);
		root.setGap("row", 1);

		const items = [box(root), box(root), box(root)];
		for (const item of items) {
			item.setWidth(8);
			item.setHeight(1);
			item.setFlexShrink(0);
		}

		root.calculateLayout(20, 10);

		expect(rect(items[1]).left).toBe(10);
		expect(rect(items[1]).top).toBe(0);
		// Wrapped, and pushed down by its own height plus the row gap.
		expect(rect(items[2]).left).toBe(0);
		expect(rect(items[2]).top).toBe(2);
	});

	test("a gap set on 'all' sets both axes", () => {
		const root = node();
		root.setGap("all", 4);
		expect(root.style.gap).toEqual({column: 4, row: 4});
	});
});

describe("automatic minimum size (css-flexbox-1 §4.5)", () => {
	// A flex item's min-width/min-height default to `auto`, which floors it at its
	// min-content size. Without that floor an item shrinks toward nothing while
	// its text stays as wide as its longest word, and paints straight over
	// whatever is beside it.
	//
	// These use a measure function so the engine can be driven directly: it
	// reports the longest word when offered no room, and the full string when
	// offered enough -- which is what a real text run does.
	function textItem(
		parent: LayoutNode,
		longest: number,
		full: number,
	): LayoutNode {
		const item = box(parent);
		item.setMeasureFunc((width, widthMode) => {
			if (widthMode === "unconstrained") {
				return {width: full, height: 1};
			}
			// Wrap into the offered width, but never below the longest single word.
			const fitted = Math.max(longest, Math.min(full, width));
			return {width: fitted, height: Math.ceil(full / Math.max(fitted, 1))};
		});
		return item;
	}

	test("an item does not shrink below its min-content size", () => {
		// 15 + 4 of content in a 12-wide row. Both items are floored at the longest
		// word they contain, so they overflow the container rather than overlap.
		const root = node();
		root.setWidth(12);
		root.setHeight(3);

		const wide = textItem(root, 15, 15); // one unbreakable 15-cell word
		const narrow = textItem(root, 4, 4);

		root.calculateLayout(12, 3);

		expect(rect(wide).width).toBe(15);
		expect(rect(narrow).width).toBe(4);
		// The second item begins where the first ends: no overlap.
		expect(rect(narrow).left).toBe(15);
	});

	test("an item still shrinks down to its min-content size", () => {
		// The floor is the longest word, not the whole string: text that can wrap
		// still gives ground.
		const root = node();
		root.setWidth(12);
		root.setHeight(3);

		const wrappable = textItem(root, 5, 16); // longest word 5, full string 16
		const fixed = textItem(root, 4, 4);

		root.calculateLayout(12, 3);

		expect(rect(wrappable).width).toBeLessThan(16);
		expect(rect(wrappable).width).toBeGreaterThanOrEqual(5);
		expect(rect(wrappable).width + rect(fixed).width).toBeLessThanOrEqual(12);
	});

	test("an explicit min-width overrides the automatic minimum", () => {
		// min-width: 0 is the standard opt-out, and it has to keep working.
		const root = node();
		root.setWidth(12);
		root.setHeight(3);

		const wide = textItem(root, 15, 15);
		wide.setMinWidth(0);
		textItem(root, 4, 4);

		root.calculateLayout(12, 3);

		expect(rect(wide).width).toBeLessThan(15);
	});

	test("an item that cannot shrink is unaffected", () => {
		const root = node();
		root.setWidth(12);
		root.setHeight(3);

		const wide = textItem(root, 15, 15);
		wide.setFlexShrink(0);

		root.calculateLayout(12, 3);

		expect(rect(wide).width).toBe(15);
	});
});

describe("what a measurement produced, not only how big it was", () => {
	// A measure function reports more than a size: a text measurement also
	// decides where the lines break, and those lines are what gets painted. They
	// belong to the size they produced, so the measurement that PLACES the box
	// is told it is that one, and the sizing probes around it are not.
	const WORDS = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];

	/** Greedy line breaking, the rule a terminal text run follows. */
	function breakWords(limit: number): string[] {
		const lines: string[] = [];
		let current = "";
		for (const word of WORDS) {
			const candidate = current ? `${current} ${word}` : word;
			if (candidate.length > limit && current) {
				lines.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		if (current) {
			lines.push(current);
		}
		return lines;
	}

	/** An item whose placing measurements leave their lines in `placed`. */
	function textItem(
		parent: LayoutNode,
		placed: {lines: string[] | null},
	): LayoutNode {
		const item = box(parent);
		item.setMeasureFunc((width, widthMode, _height, _heightMode, placing) => {
			const limit =
				widthMode === "unconstrained"
					? Number.MAX_SAFE_INTEGER
					: width;
			const lines = breakWords(limit);
			if (placing) {
				placed.lines = lines;
			}
			return {
				width: Math.max(...lines.map((line) => line.length)),
				height: lines.length,
			};
		});
		return item;
	}

	test("an item that shrank holds the lines its own width was broken to", () => {
		// Two text items in a 24-cell row, then the same row at 17. The first item
		// shrinks to its automatic minimum -- its longest word, 4 -- in both, and
		// nothing about the item itself changes between the passes, so its layout
		// is answered from cache the second time. The sizing probes the second
		// pass makes of it are answered at other widths (the row's whole 17 among
		// them) and are no part of the box it ends up with.
		const root = node();
		root.setFlexDirection("row");
		root.setWidth(24);

		const placed: {lines: string[] | null} = {lines: null};
		const shrinking = textItem(root, placed);
		shrinking.setFlexGrow(1);
		const fixed = textItem(root, {lines: null});
		fixed.setFlexShrink(0);

		root.calculateLayout(NaN, NaN);
		expect(rect(shrinking).width).toBe(4);
		expect(placed.lines).toEqual(breakWords(4));

		root.setWidth(17);
		root.calculateLayout(NaN, NaN);

		// Four cells wide: one word per line, and that is what it holds.
		expect(rect(shrinking).width).toBe(4);
		expect(placed.lines).toEqual(breakWords(4));
	});
});
