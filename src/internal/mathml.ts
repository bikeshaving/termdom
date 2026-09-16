/**
 * Presentation MathML layout. Every element lays out to a MathBox, a
 * grid of styled cells with a baseline row, built from three
 * combinators: beside, stack and pad. The <math> element's box is what
 * the block and inline engines place, and what the painter blits.
 */

import {getComputedValue} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {MATHML_NAMESPACE} from "./dom.ts";
import {type GlyphSet, parseGlyphSet, toPlainGlyphs} from "./mathglyphs.ts";
import {
	lookupOperator,
	type OperatorEntry,
	type OperatorForm,
} from "./mathoperators.ts";
import type {CellStyle} from "./screen.ts";
import {getStringWidth, graphemeSegmenter} from "./text.ts";

export interface MathCell {
	text: string;
	width: number;
	style: CellStyle | null;
}

export interface MathBox {
	width: number;
	height: number;
	baseline: number;
	cells: MathCell[][];
}

export type Alignment = "left" | "center" | "right";

interface MathContext {
	display: boolean;
	glyphs: GlyphSet;
	variantGlyphs: boolean;
}

interface Operator {
	text: string;
	entry: OperatorEntry;
	gapBefore: boolean;
	gapAfter: boolean;
}

const BLANK: MathCell = {text: " ", width: 1, style: null};

// Function application, invisible times, separator and plus, and the
// zero-width space: operators with no glyph and no cell.
const INVISIBLE_OPERATORS = new RegExp("[\\u2061-\\u2064\\u200b]", "g");

export function isMathRoot(node: Node): boolean {
	return (
		node.nodeType === node.ELEMENT_NODE &&
		(node as Element).namespaceURI === MATHML_NAMESPACE &&
		(node as Element).localName === "math"
	);
}

function isMathElement(node: Node): boolean {
	return (
		node.nodeType === node.ELEMENT_NODE &&
		(node as Element).namespaceURI === MATHML_NAMESPACE
	);
}

/**
 * The box a <math> element renders as. Display mode may use any number
 * of rows; inline mode linearizes everything onto one.
 */
export function layoutMath(element: Element, display: boolean): MathBox {
	const context: MathContext = {
		display,
		glyphs: parseGlyphSet(getComputedValue(element, "--math-glyphs")),
		variantGlyphs:
			getComputedValue(element, "--math-variant-glyphs").trim() === "unicode",
	};
	return layoutRow(getLayoutChildren(element), element, context);
}

export function createEmptyBox(
	width: number,
	height = 1,
	baseline = 0,
): MathBox {
	const cells: MathCell[][] = [];
	for (let row = 0; row < height; row++) {
		cells.push(blankRow(width));
	}
	return {width, height, baseline, cells};
}

function blankRow(width: number): MathCell[] {
	const row: MathCell[] = [];
	for (let i = 0; i < width; i++) {
		row.push(BLANK);
	}
	return row;
}

export function createTextBox(text: string, style: CellStyle | null): MathBox {
	const cells: MathCell[] = [];
	let width = 0;
	for (const {segment} of graphemeSegmenter.segment(text)) {
		const cellWidth = getStringWidth(segment);
		if (cellWidth <= 0) {
			if (cells.length > 0) {
				const last = cells[cells.length - 1];
				cells[cells.length - 1] = {...last, text: last.text + segment};
			}
			continue;
		}
		cells.push({text: segment, width: cellWidth, style});
		width += cellWidth;
	}
	return {width, height: 1, baseline: 0, cells: [cells]};
}

export function getDescent(box: MathBox): number {
	return box.height - box.baseline - 1;
}

/** Horizontal concatenation on a shared baseline. */
export function beside(a: MathBox, b: MathBox, gap = 0): MathBox {
	const baseline = Math.max(a.baseline, b.baseline);
	const descent = Math.max(getDescent(a), getDescent(b));
	const height = baseline + descent + 1;
	const left = alignToBaseline(a, baseline, height);
	const right = alignToBaseline(b, baseline, height);
	const cells: MathCell[][] = [];
	for (let row = 0; row < height; row++) {
		cells.push([...left.cells[row], ...blankRow(gap), ...right.cells[row]]);
	}
	return {width: a.width + gap + b.width, height, baseline, cells};
}

function alignToBaseline(
	box: MathBox,
	baseline: number,
	height: number,
): MathBox {
	const top = baseline - box.baseline;
	const bottom = height - box.height - top;
	return top === 0 && bottom === 0 ? box : pad(box, top, 0, bottom, 0);
}

/** Vertical concatenation. The caller says which row is the baseline. */
export function stack(
	top: MathBox,
	bottom: MathBox,
	align: Alignment,
	baseline: number,
): MathBox {
	const width = Math.max(top.width, bottom.width);
	const cells = [
		...widenRows(top, width, align),
		...widenRows(bottom, width, align),
	];
	return {width, height: cells.length, baseline, cells};
}

function widenRows(
	box: MathBox,
	width: number,
	align: Alignment,
): MathCell[][] {
	const extra = width - box.width;
	if (extra <= 0) {
		return box.cells;
	}
	const left = align === "left" ? 0 : align === "right" ? extra : extra >> 1;
	const right = extra - left;
	return box.cells.map((row) => [
		...blankRow(left),
		...row,
		...blankRow(right),
	]);
}

export function pad(
	box: MathBox,
	top: number,
	right: number,
	bottom: number,
	left: number,
): MathBox {
	const width = box.width + left + right;
	const cells: MathCell[][] = [];
	for (let row = 0; row < top; row++) {
		cells.push(blankRow(width));
	}
	for (const row of box.cells) {
		cells.push([...blankRow(left), ...row, ...blankRow(right)]);
	}
	for (let row = 0; row < bottom; row++) {
		cells.push(blankRow(width));
	}
	return {width, height: cells.length, baseline: box.baseline + top, cells};
}

export function getBoxText(box: MathBox): string[] {
	return box.cells.map((row) => row.map((cell) => cell.text).join(""));
}

// The children an element lays out: its elements, plus any text that is
// not just white space, which renders as if it were an mtext.
function getLayoutChildren(element: Element): Node[] {
	const children: Node[] = [];
	for (const child of element.childNodes) {
		if (child.nodeType === child.ELEMENT_NODE) {
			if (getComputedValue(child as Element, "display") !== "none") {
				children.push(child);
			}
		} else if (
			child.nodeType === child.TEXT_NODE && (child as Text).data.trim() !== ""
		) {
			children.push(child);
		}
	}
	return children;
}

function layoutNode(node: Node, context: MathContext): MathBox {
	if (node.nodeType === node.TEXT_NODE) {
		const parent = node.parentElement;
		return createTextBox(
			collapseTokenText((node as Text).data),
			parent ? getTokenStyle(parent, context, false) : null,
		);
	}
	const element = node as Element;
	if (!isMathElement(element)) {
		return layoutTextToken(element, element.textContent ?? "", context);
	}
	const local = getComputedValue(element, "math-style") === "compact"
		? {...context, display: false}
		: context;
	switch (element.localName) {
		case "mi":
		case "mn":
		case "mo":
		case "mtext":
			return layoutTextToken(element, element.textContent ?? "", local);
		case "ms":
			return layoutTextToken(
				element,
				(element.getAttribute("lquote") ?? "\"") +
				collapseTokenText(element.textContent ?? "") +
				(element.getAttribute("rquote") ?? "\""),
				local,
			);
		case "mspace": {
			const width = parseMathLength(element.getAttribute("width")) ?? 0;
			return createEmptyBox(width > 0 ? Math.max(1, Math.round(width)) : 0);
		}
		case "maction":
		case "semantics": {
			const first = getLayoutChildren(element)[0];
			return first ? layoutNode(first, local) : createEmptyBox(1);
		}
		case "annotation":
		case "annotation-xml":
		case "mprescripts":
		case "none":
			return createEmptyBox(0);
		default:
			return layoutRow(getLayoutChildren(element), element, local);
	}
}

function collapseTokenText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function layoutTextToken(
	element: Element,
	text: string,
	context: MathContext,
): MathBox {
	const collapsed = collapseTokenText(text).replace(INVISIBLE_OPERATORS, "");
	const single = isSingleGrapheme(collapsed);
	const style = getTokenStyle(element, context, single);
	return createTextBox(toPlainGlyphs(collapsed, context.glyphs), style);
}

function isSingleGrapheme(text: string): boolean {
	let count = 0;
	for (const _ of graphemeSegmenter.segment(text)) {
		if (++count > 1) {
			return false;
		}
	}
	return count === 1;
}

function getMathVariant(element: Element): string | null {
	for (
		let current: Element | null = element;
		current !== null && isMathElement(current);
		current = current.parentElement
	) {
		const variant = current.getAttribute("mathvariant");
		if (variant !== null) {
			return variant.trim().toLowerCase();
		}
	}
	return null;
}

function getTokenStyle(
	element: Element,
	_context: MathContext,
	singleIdentifier: boolean,
): CellStyle | null {
	const color = getComputedValue(element, "color");
	const background = getComputedValue(element, "background-color");
	const weight = getComputedValue(element, "font-weight");
	const fontStyle = getComputedValue(element, "font-style");
	const variant = getMathVariant(element);
	let bold =
		weight === "bold" ||
		weight === "bolder" ||
		(Number.isFinite(Number(weight)) && Number(weight) >= 600);
	let italic = fontStyle === "italic" || fontStyle === "oblique";
	if (variant !== null) {
		bold = variant.includes("bold");
		italic = variant.includes("italic");
	} else if (element.localName === "mi" && singleIdentifier) {
		italic = true;
	}
	const style: CellStyle = {};
	let any = false;
	if (color && color !== "initial" && !CSSValues.isHighlightColor(color)) {
		style.fg = CSSValues.cssColorToNumber(color);
		any = true;
	}
	if (
		background &&
		background !== "initial" &&
		!CSSValues.isTransparentColor(background) &&
		!CSSValues.isCanvasColor(background) &&
		!CSSValues.isHighlightColor(background)
	) {
		style.bg = CSSValues.cssColorToNumber(background);
		any = true;
	}
	if (bold) {
		style.bold = true;
		any = true;
	}
	if (italic) {
		style.italic = true;
		any = true;
	}
	return any ? style : null;
}

/**
 * A length attribute in cells, unrounded. em, ch and px are one column;
 * ex and lh one row; a bare number counts cells. A percentage or an
 * unknown unit is null.
 */
export function parseMathLength(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const match = /^\s*([+-]?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(value);
	if (!match) {
		return null;
	}
	switch (match[2].toLowerCase()) {
		case "":
		case "em":
		case "ch":
		case "px":
		case "ex":
		case "lh":
		case "rem":
			return Number(match[1]);
		default:
			return null;
	}
}

/** An operator's form: the attribute, else its position in the row. */
function getOperatorForm(
	element: Element,
	index: number,
	count: number,
): OperatorForm {
	const attribute = element.getAttribute("form")?.trim().toLowerCase();
	if (
		attribute === "prefix" || attribute === "infix" || attribute === "postfix"
	) {
		return attribute;
	}
	if (count > 1 && index === 0) {
		return "prefix";
	}
	if (count > 1 && index === count - 1) {
		return "postfix";
	}
	return "infix";
}

function readSpace(element: Element, name: string, fallback: number): number {
	const value = element.getAttribute(name);
	if (value === null) {
		return fallback / 18;
	}
	const match = /^\s*([+-]?\d*\.?\d+)\s*(em|px|ch|ex)?\s*$/i.exec(value);
	return match ? Number(match[1]) : fallback / 18;
}

function readFlag(element: Element, name: string, fallback: boolean): boolean {
	const value = element.getAttribute(name)?.trim().toLowerCase();
	return value === "true" ? true : value === "false" ? false : fallback;
}

function getOperator(element: Element, index: number, count: number): Operator {
	const text = collapseTokenText(element.textContent ?? "");
	const form = getOperatorForm(element, index, count);
	const found = lookupOperator(text, form);
	const entry: OperatorEntry = {
		...found,
		stretchy: readFlag(element, "stretchy", found.stretchy),
		symmetric: readFlag(element, "symmetric", found.symmetric),
		largeop: readFlag(element, "largeop", found.largeop),
		accent: readFlag(element, "accent", found.accent),
	};
	const infix = form === "infix";
	return {
		text,
		entry,
		gapBefore: infix && readSpace(element, "lspace", found.lspace) >= 0.2,
		gapAfter: infix && readSpace(element, "rspace", found.rspace) >= 0.2,
	};
}

function isOperatorElement(node: Node): boolean {
	return isMathElement(node) && (node as Element).localName === "mo";
}

/**
 * An mrow's children side by side. An infix operator with enough
 * spacing in the dictionary gets one cell of air on that side; prefix
 * and postfix operators sit tight against their operands.
 */
function layoutRow(
	children: Node[],
	_parent: Element,
	context: MathContext,
): MathBox {
	if (children.length === 0) {
		return createEmptyBox(1);
	}
	let result: MathBox | null = null;
	let gapAfter = false;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		const operator = isOperatorElement(child)
			? getOperator(child as Element, index, children.length)
			: null;
		const box = layoutNode(child, context);
		if (result === null) {
			result = box;
		} else {
			const gap = (gapAfter || operator?.gapBefore) && box.width > 0 ? 1 : 0;
			result = beside(result, box, gap);
		}
		gapAfter = operator?.gapAfter ?? false;
	}
	return result!;
}

/**
 * The one-line text of a <math> element, for innerText and clipboard
 * copies. A TeX annotation is preferred when the markup carries one.
 */
export function linearizeMath(element: Element): string {
	const annotation = findTeXAnnotation(element);
	if (annotation !== null) {
		return annotation;
	}
	const box = layoutMath(element, false);
	return getBoxText(box).join("\n").trim();
}

function findTeXAnnotation(element: Element): string | null {
	for (const child of element.querySelectorAll("annotation")) {
		const encoding = child.getAttribute("encoding")?.toLowerCase() ?? "";
		if (encoding === "application/x-tex" || encoding === "text/x-tex") {
			return (child.textContent ?? "").trim();
		}
	}
	return null;
}
