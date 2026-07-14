import {beforeEach, describe, expect, test} from "bun:test";
import Flex, {Config, Node} from "../src/flex.js";

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
let config: Config;

beforeEach(() => {
	config = Config.create();
	config.setUseWebDefaults(true);
	config.setPointScaleFactor(1);
});

function node(): Node {
	return Node.createWithConfig(config);
}

function box(parent: Node, index = parent.getChildCount()): Node {
	const child = node();
	parent.insertChild(child, index);
	return child;
}

function rect(n: Node) {
	return {
		left: n.getComputedLeft(),
		top: n.getComputedTop(),
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
		item.setFlexBasisAuto();
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
		item.setFlexBasisAuto();
		item.setWidthAuto();
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
	function wrapped(alignContent: number) {
		const root = node();
		root.setWidth(100);
		root.setHeight(40);
		root.setFlexWrap(Flex.WRAP_WRAP);
		root.setAlignContent(alignContent);
		root.setAlignItems(Flex.ALIGN_FLEX_START);

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
		const [one, two, three] = wrapped(Flex.ALIGN_FLEX_START);
		expect(rect(one).left).toBe(0);
		expect(rect(two).left).toBe(40);
		// Wrapped to the next line, so back to the main-start edge.
		expect(rect(three).left).toBe(0);
	});

	test("align-content: flex-start packs lines at the cross-start edge", () => {
		// Lines at 0 and 10; the 20 of free space is left at the end.
		const [one, two, three] = wrapped(Flex.ALIGN_FLEX_START);
		expect(rect(one).top).toBe(0);
		expect(rect(two).top).toBe(0);
		expect(rect(three).top).toBe(10);
	});

	test("align-content: flex-end packs lines at the cross-end edge", () => {
		// All 20 of free space goes in front: lines at 20 and 30.
		const [one, , three] = wrapped(Flex.ALIGN_FLEX_END);
		expect(rect(one).top).toBe(20);
		expect(rect(three).top).toBe(30);
	});

	test("align-content: center packs lines around the cross midpoint", () => {
		// Half the free space in front: 20/2 = 10, so lines at 10 and 20.
		const [one, , three] = wrapped(Flex.ALIGN_CENTER);
		expect(rect(one).top).toBe(10);
		expect(rect(three).top).toBe(20);
	});

	test("align-content: space-between puts all free space between the lines", () => {
		// First line flush at 0, last flush at the end; the gap is the whole
		// 20 of free space: 0, then 10 + 20 = 30.
		const [one, , three] = wrapped(Flex.ALIGN_SPACE_BETWEEN);
		expect(rect(one).top).toBe(0);
		expect(rect(three).top).toBe(30);
	});

	test("align-content: space-around gives each line equal space on both sides", () => {
		// 20 free / 2 lines = 10 per line, half of it (5) leading each.
		// Line 1 at 5; line 2 at 5 + 10 + 10 = 25.
		const [one, , three] = wrapped(Flex.ALIGN_SPACE_AROUND);
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
		root.setFlexWrap(Flex.WRAP_WRAP);
		root.setAlignContent(Flex.ALIGN_SPACE_EVENLY);
		root.setAlignItems(Flex.ALIGN_FLEX_START);

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
		const [one, , three] = wrapped(Flex.ALIGN_STRETCH);
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
		root.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);

		const child = box(root);
		child.setPaddingPercent(Flex.EDGE_ALL, 10);

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
		root.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);

		const child = box(root);
		child.setHeight(10);
		child.setMarginPercent(Flex.EDGE_TOP, 10);
		child.setMarginPercent(Flex.EDGE_LEFT, 10);

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
		item.setMarginAuto(Flex.EDGE_LEFT);
		item.setMarginAuto(Flex.EDGE_RIGHT);

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
		item.setMarginAuto(Flex.EDGE_LEFT);

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
		item.setMarginAuto(Flex.EDGE_TOP);
		item.setMarginAuto(Flex.EDGE_BOTTOM);

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
		root.setJustifyContent(Flex.JUSTIFY_FLEX_END);

		const item = box(root);
		item.setWidth(20);
		item.setHeight(10);
		item.setFlexShrink(0);
		item.setMarginAuto(Flex.EDGE_RIGHT);

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
	function baselineRow(alignItems: number) {
		const root = node();
		root.setWidth(100);
		root.setHeight(20);
		root.setAlignItems(alignItems);

		const a = box(root);
		a.setPadding(Flex.EDGE_TOP, 2);
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
		const {a, b, aText, bText} = baselineRow(Flex.ALIGN_BASELINE);

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
		const {a, b, aText, bText} = baselineRow(Flex.ALIGN_FLEX_START);

		expect(rect(a).top).toBe(0);
		expect(rect(b).top).toBe(0);

		const aTextRow = rect(a).top + rect(aText).top;
		const bTextRow = rect(b).top + rect(bText).top;
		expect(aTextRow).toBe(2);
		expect(bTextRow).toBe(0);
		expect(aTextRow).not.toBe(bTextRow);
	});
});
