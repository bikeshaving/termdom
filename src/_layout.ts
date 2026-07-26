import type {DOMWindow} from "jsdom";
import Flex from "./_flex.js";
import type * as FlexTypes from "./_flex.js";
import LineBreaker from "linebreak";
import {getBoxModel, type BoxModel} from "./_styles.js";
import {getPropertyValue, parseUnitValue} from "./_styles.js";
import {createExpandedTreeWalker, getPseudoMetadata} from "./_composition.js";
import {stringWidth as runtimeStringWidth} from "./_runtime.js";

function getAbsolutePosition(flexNode: FlexTypes.Node): {
	x: number;
	y: number;
} {
	let x = 0;
	let y = 0;
	let current: FlexTypes.Node | null = flexNode;

	for (; current; current = current.getParent()) {
		x += current.getComputedLeft();
		y += current.getComputedTop();
	}

	return {x, y};
}

interface EnumMap {
	align: FlexTypes.Align;
	justify: FlexTypes.Justify;
	wrap: FlexTypes.Wrap;
}

function getFlexConstant<TEnumName extends keyof EnumMap>(
	enumName: TEnumName,
	propertyName: string,
): EnumMap[TEnumName] | null {
	const name =
		enumName.toUpperCase() + "_" + propertyName.replace("-", "_").toUpperCase();
	return (Flex as any)[name] || null;
}

/** A colspan/rowspan attribute, defaulting to 1 when absent or nonsense. */
function parseSpanAttribute(element: Element, name: string): number {
	const raw = element.getAttribute(name);
	if (!raw) return 1;
	const span = parseInt(raw, 10);
	return Number.isFinite(span) && span > 0 ? span : 1;
}

function styleFlexNode(element: Element, flexNode: FlexTypes.Node): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}
	const computedStyle = window.getComputedStyle(element);

	// Skip box model properties for inline elements (not inline-block)
	const display = computedStyle.getPropertyValue("display");
	// Handle width/height based on display type
	if (display === "inline") {
		// For pure inline elements, unset dimensions since they handle dimensions in their measure function
		flexNode.setWidthAuto();
		flexNode.setHeightAuto();
		// Also unset min/max constraints for pure inline elements
		flexNode.setMinWidth(undefined);
		flexNode.setMinHeight(undefined);
		flexNode.setMaxWidth(undefined);
		flexNode.setMaxHeight(undefined);
	} else if (display === "inline-block") {
		// For inline-block elements, unset width/height but preserve min/max constraints
		// This allows the measure function to work while still respecting CSS constraints
		flexNode.setWidthAuto();
		flexNode.setHeightAuto();

		// Apply min/max constraints for inline-block elements (like block elements)
		const minWidth = parseUnitValue(
			computedStyle.getPropertyValue("min-width"),
		);
		if (typeof minWidth === "number") {
			flexNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			flexNode.setMinWidthPercent(minWidth.percentage);
		} else {
			// Leave it unset rather than forcing 0. min-width defaults to `auto`,
			// which on a flex item means its content-based minimum -- pinning it to
			// 0 lets the item shrink to nothing while its text stays as wide as its
			// longest word, and paint straight over whatever is next to it.
			flexNode.setMinWidth(undefined);
		}

		const minHeight = parseUnitValue(
			computedStyle.getPropertyValue("min-height"),
		);
		if (typeof minHeight === "number") {
			flexNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			flexNode.setMinHeightPercent(minHeight.percentage);
		} else {
			flexNode.setMinHeight(undefined);
		}

		const maxWidth = parseUnitValue(
			computedStyle.getPropertyValue("max-width"),
		);
		if (typeof maxWidth === "number") {
			flexNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			flexNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			flexNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.getPropertyValue("max-height"),
		);
		if (typeof maxHeight === "number") {
			flexNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			flexNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			flexNode.setMaxHeight(undefined);
		}
	} else {
		// For block elements, apply explicit dimensions normally
		const width = parseUnitValue(computedStyle.getPropertyValue("width"));
		if (typeof width === "number") {
			flexNode.setWidth(width);
		} else if (width && "percentage" in width) {
			flexNode.setWidthPercent(width.percentage);
		} else {
			flexNode.setWidthAuto();
		}

		const height = parseUnitValue(computedStyle.getPropertyValue("height"));
		if (typeof height === "number") {
			flexNode.setHeight(height);
		} else if (height && "percentage" in height) {
			flexNode.setHeightPercent(height.percentage);
		} else {
			flexNode.setHeightAuto();
		}

		// Apply min/max constraints for block elements
		const minWidth = parseUnitValue(
			computedStyle.getPropertyValue("min-width"),
		);
		if (typeof minWidth === "number") {
			flexNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			flexNode.setMinWidthPercent(minWidth.percentage);
		} else {
			// Leave it unset rather than forcing 0. min-width defaults to `auto`,
			// which on a flex item means its content-based minimum -- pinning it to
			// 0 lets the item shrink to nothing while its text stays as wide as its
			// longest word, and paint straight over whatever is next to it.
			flexNode.setMinWidth(undefined);
		}

		const minHeight = parseUnitValue(
			computedStyle.getPropertyValue("min-height"),
		);
		if (typeof minHeight === "number") {
			flexNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			flexNode.setMinHeightPercent(minHeight.percentage);
		} else {
			flexNode.setMinHeight(undefined);
		}

		const maxWidth = parseUnitValue(
			computedStyle.getPropertyValue("max-width"),
		);
		if (typeof maxWidth === "number") {
			flexNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			flexNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			flexNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.getPropertyValue("max-height"),
		);
		if (typeof maxHeight === "number") {
			flexNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			flexNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			flexNode.setMaxHeight(undefined);
		}
	}

	// Box model properties: clear for inline elements, apply for block/inline-block
	if (display === "inline") {
		// Clear all box model properties for inline elements
		flexNode.setMargin(Flex.EDGE_TOP, 0);
		flexNode.setMargin(Flex.EDGE_RIGHT, 0);
		flexNode.setMargin(Flex.EDGE_BOTTOM, 0);
		flexNode.setMargin(Flex.EDGE_LEFT, 0);

		flexNode.setPadding(Flex.EDGE_TOP, 0);
		flexNode.setPadding(Flex.EDGE_RIGHT, 0);
		flexNode.setPadding(Flex.EDGE_BOTTOM, 0);
		flexNode.setPadding(Flex.EDGE_LEFT, 0);

		flexNode.setBorder(Flex.EDGE_TOP, 0);
		flexNode.setBorder(Flex.EDGE_RIGHT, 0);
		flexNode.setBorder(Flex.EDGE_BOTTOM, 0);
		flexNode.setBorder(Flex.EDGE_LEFT, 0);
	} else {
		// Apply normal box model properties for block/inline-block elements

		// Margins
		const marginTop = parseUnitValue(
			computedStyle.getPropertyValue("margin-top"),
		);
		if (typeof marginTop === "number") {
			flexNode.setMargin(Flex.EDGE_TOP, marginTop);
		} else if (marginTop && "percentage" in marginTop) {
			flexNode.setMarginPercent(Flex.EDGE_TOP, marginTop.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-top");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_TOP);
			} else {
				flexNode.setMargin(Flex.EDGE_TOP, undefined);
			}
		}

		const marginRight = parseUnitValue(
			computedStyle.getPropertyValue("margin-right"),
		);
		if (typeof marginRight === "number") {
			flexNode.setMargin(Flex.EDGE_RIGHT, marginRight);
		} else if (marginRight && "percentage" in marginRight) {
			flexNode.setMarginPercent(Flex.EDGE_RIGHT, marginRight.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-right");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_RIGHT);
			} else {
				flexNode.setMargin(Flex.EDGE_RIGHT, undefined);
			}
		}

		const marginBottom = parseUnitValue(
			computedStyle.getPropertyValue("margin-bottom"),
		);
		if (typeof marginBottom === "number") {
			flexNode.setMargin(Flex.EDGE_BOTTOM, marginBottom);
		} else if (marginBottom && "percentage" in marginBottom) {
			flexNode.setMarginPercent(Flex.EDGE_BOTTOM, marginBottom.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-bottom");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_BOTTOM);
			} else {
				flexNode.setMargin(Flex.EDGE_BOTTOM, undefined);
			}
		}

		const marginLeft = parseUnitValue(
			computedStyle.getPropertyValue("margin-left"),
		);
		if (typeof marginLeft === "number") {
			flexNode.setMargin(Flex.EDGE_LEFT, marginLeft);
		} else if (marginLeft && "percentage" in marginLeft) {
			flexNode.setMarginPercent(Flex.EDGE_LEFT, marginLeft.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-left");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_LEFT);
			} else {
				flexNode.setMargin(Flex.EDGE_LEFT, undefined);
			}
		}

		// Paddings
		const paddingTop = parseUnitValue(
			computedStyle.getPropertyValue("padding-top"),
		);
		if (typeof paddingTop === "number") {
			flexNode.setPadding(Flex.EDGE_TOP, paddingTop);
		} else if (paddingTop && "percentage" in paddingTop) {
			flexNode.setPaddingPercent(Flex.EDGE_TOP, paddingTop.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_TOP, undefined);
		}

		const paddingRight = parseUnitValue(
			computedStyle.getPropertyValue("padding-right"),
		);
		if (typeof paddingRight === "number") {
			flexNode.setPadding(Flex.EDGE_RIGHT, paddingRight);
		} else if (paddingRight && "percentage" in paddingRight) {
			flexNode.setPaddingPercent(Flex.EDGE_RIGHT, paddingRight.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_RIGHT, undefined);
		}

		const paddingBottom = parseUnitValue(
			computedStyle.getPropertyValue("padding-bottom"),
		);
		if (typeof paddingBottom === "number") {
			flexNode.setPadding(Flex.EDGE_BOTTOM, paddingBottom);
		} else if (paddingBottom && "percentage" in paddingBottom) {
			flexNode.setPaddingPercent(Flex.EDGE_BOTTOM, paddingBottom.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_BOTTOM, undefined);
		}

		const paddingLeft = parseUnitValue(
			computedStyle.getPropertyValue("padding-left"),
		);
		if (typeof paddingLeft === "number") {
			flexNode.setPadding(Flex.EDGE_LEFT, paddingLeft);
		} else if (paddingLeft && "percentage" in paddingLeft) {
			flexNode.setPaddingPercent(Flex.EDGE_LEFT, paddingLeft.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_LEFT, undefined);
		}

		// Border widths
		const borderTopWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-top-width"),
		);
		if (typeof borderTopWidth === "number" && borderTopWidth > 0) {
			flexNode.setBorder(Flex.EDGE_TOP, borderTopWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_TOP, 0);
		}

		const borderRightWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-right-width"),
		);
		if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
			flexNode.setBorder(Flex.EDGE_RIGHT, borderRightWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_RIGHT, 0);
		}

		const borderBottomWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-bottom-width"),
		);
		if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
			flexNode.setBorder(Flex.EDGE_BOTTOM, borderBottomWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_BOTTOM, 0);
		}

		const borderLeftWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-left-width"),
		);
		if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
			flexNode.setBorder(Flex.EDGE_LEFT, borderLeftWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_LEFT, 0);
		}
	}

	const parentDisplay = element.parentElement
		? getPropertyValue(element.parentElement, "display")
		: null;

	if (parentDisplay === "block") {
		// We emulate display: block with flexbox, but this means we need the children
		// to not have configurable flex properties, or surprising layout behavior
		// might occur.
		flexNode.setFlexGrow(0);
		flexNode.setFlexShrink(0); // Prevent shrinking in block containers
		flexNode.setFlexBasisAuto();
		flexNode.setAlignSelf(Flex.ALIGN_AUTO);
	} else {
		const flexGrow = computedStyle.getPropertyValue("flex-grow");
		const growValue = parseFloat(flexGrow);
		if (!isNaN(growValue) && growValue >= 0) {
			flexNode.setFlexGrow(growValue);
		} else {
			flexNode.setFlexGrow(undefined);
		}

		const flexShrink = computedStyle.getPropertyValue("flex-shrink");
		const shrinkValue = parseFloat(flexShrink);
		if (!isNaN(shrinkValue) && shrinkValue >= 0) {
			flexNode.setFlexShrink(shrinkValue);
		} else {
			flexNode.setFlexShrink(undefined);
		}

		const flexBasis = parseUnitValue(
			computedStyle.getPropertyValue("flex-basis"),
		);
		if (typeof flexBasis === "number") {
			flexNode.setFlexBasis(flexBasis);
		} else if (flexBasis && "percentage" in flexBasis) {
			flexNode.setFlexBasisPercent(flexBasis.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("flex-basis");
			if (originalValue === "auto") {
				flexNode.setFlexBasisAuto();
			} else {
				flexNode.setFlexBasis(undefined);
			}
		}

		const alignSelf = computedStyle.getPropertyValue("align-self");
		if (alignSelf === "auto") {
			flexNode.setAlignSelf(Flex.ALIGN_AUTO);
		} else {
			const alignValue = getFlexConstant("align", alignSelf);
			if (alignValue !== null) {
				flexNode.setAlignSelf(alignValue);
			} else {
				flexNode.setAlignSelf(Flex.ALIGN_AUTO);
			}
		}
	}

	// gap. The `gap` shorthand is expanded in the cascade, so reading the
	// longhands here is enough and gets the precedence right.
	const rowGap = parseUnitValue(computedStyle.getPropertyValue("row-gap"));
	if (typeof rowGap === "number") {
		flexNode.setGap(Flex.GUTTER_ROW, rowGap);
	}

	const columnGap = parseUnitValue(
		computedStyle.getPropertyValue("column-gap"),
	);
	if (typeof columnGap === "number") {
		flexNode.setGap(Flex.GUTTER_COLUMN, columnGap);
	}

	if (display === "none") {
		flexNode.setDisplay(Flex.DISPLAY_NONE);
	} else if (display === "flex") {
		flexNode.setDisplay(Flex.DISPLAY_FLEX);
	} else if (display === "table") {
		// A real table layout mode, not a flex column: columns are shared across
		// rows, which a flex row per <tr> structurally cannot express.
		flexNode.setDisplay(Flex.DISPLAY_TABLE);
		flexNode.setBorderCollapse(
			computedStyle.getPropertyValue("border-collapse") === "collapse",
		);

		// A table shrink-wraps to its content instead of filling its container.
		// Block layout here is a flex column with align-items: stretch, which would
		// otherwise stretch the table to the full terminal width, so opt it out --
		// unless the author aligned it themselves.
		if (computedStyle.getPropertyValue("align-self") === "auto") {
			flexNode.setAlignSelf(Flex.ALIGN_FLEX_START);
		}
	} else if (display === "table-header-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_HEADER_GROUP);
	} else if (display === "table-footer-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_FOOTER_GROUP);
	} else if (display === "table-row-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW_GROUP);
	} else if (display === "table-caption") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CAPTION);
		// The caption's own content is laid out as a block.
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);
	} else if (display === "table-column" || display === "table-column-group") {
		// Columns carry style, not a box of their own.
		flexNode.setDisplay(Flex.DISPLAY_NONE);
	} else if (display === "table-row") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW);
	} else if (display === "table-cell") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CELL);
		flexNode.setColSpan(parseSpanAttribute(element, "colspan"));
		flexNode.setRowSpan(parseSpanAttribute(element, "rowspan"));
		// A cell establishes a block formatting context for its own content.
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);

		// Add default padding for table cells if not explicitly set
		const paddingLeft = computedStyle.getPropertyValue("padding-left");
		const paddingRight = computedStyle.getPropertyValue("padding-right");
		if (!paddingLeft || paddingLeft === "0px") {
			flexNode.setPadding(Flex.EDGE_LEFT, 1); // 1 character padding
		}
		if (!paddingRight || paddingRight === "0px") {
			flexNode.setPadding(Flex.EDGE_RIGHT, 1); // 1 character padding
		}
	}

	// Handle flex direction for flex containers (not table-row which has fixed direction)
	if (display === "flex") {
		const flexDirection = computedStyle.getPropertyValue("flex-direction");
		if (flexDirection === "row") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW);
		} else if (flexDirection === "row-reverse") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW_REVERSE);
		} else if (flexDirection === "column") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		} else if (flexDirection === "column-reverse") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN_REVERSE);
		} else {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW);
		}

		const flexWrap = computedStyle.getPropertyValue("flex-wrap");
		if (flexWrap === "nowrap") {
			flexNode.setFlexWrap(Flex.WRAP_NO_WRAP);
		} else if (flexWrap === "wrap") {
			flexNode.setFlexWrap(Flex.WRAP_WRAP);
		} else if (flexWrap === "wrap-reverse") {
			flexNode.setFlexWrap(Flex.WRAP_WRAP_REVERSE);
		} else {
			flexNode.setFlexWrap(Flex.WRAP_NO_WRAP);
		}

		const justifyContent = computedStyle.getPropertyValue("justify-content");
		const justifyValue = getFlexConstant("justify", justifyContent);
		if (justifyValue !== null) {
			flexNode.setJustifyContent(justifyValue);
		} else {
			flexNode.setJustifyContent(Flex.JUSTIFY_FLEX_START);
		}

		const alignItems = computedStyle.getPropertyValue("align-items");
		const alignValue = getFlexConstant("align", alignItems);
		if (alignValue !== null) {
			flexNode.setAlignItems(alignValue);
		} else {
			flexNode.setAlignItems(Flex.ALIGN_STRETCH);
		}

		const alignContent = computedStyle.getPropertyValue("align-content");
		const alignContentValue = getFlexConstant("align", alignContent);
		if (alignContentValue !== null) {
			flexNode.setAlignContent(alignContentValue);
		} else {
			flexNode.setAlignContent(Flex.ALIGN_FLEX_START);
		}
	} else if (!display.startsWith("table")) {
		// Default block layout. Table displays are set above and must not be
		// overwritten here -- listing them out by hand meant table-caption was
		// missed, and its display was silently reset to flex, which is why the
		// table could never find its own caption.
		flexNode.setDisplay(Flex.DISPLAY_FLEX);
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);
	}

	// Handle positioning properties
	const position = computedStyle.getPropertyValue("position");
	if (position === "absolute") {
		flexNode.setPositionType(Flex.POSITION_TYPE_ABSOLUTE);

		// Handle left positioning
		const left = parseUnitValue(computedStyle.getPropertyValue("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		} else {
			const originalLeft = computedStyle.getPropertyValue("left");
			if (originalLeft === "auto" || !originalLeft) {
				flexNode.setPositionAuto(Flex.EDGE_LEFT);
			}
		}

		// Handle top positioning
		const top = parseUnitValue(computedStyle.getPropertyValue("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		} else {
			const originalTop = computedStyle.getPropertyValue("top");
			if (originalTop === "auto" || !originalTop) {
				flexNode.setPositionAuto(Flex.EDGE_TOP);
			}
		}

		// Handle right positioning
		const right = parseUnitValue(computedStyle.getPropertyValue("right"));
		if (typeof right === "number") {
			flexNode.setPosition(Flex.EDGE_RIGHT, right);
		} else if (right && "percentage" in right) {
			flexNode.setPositionPercent(Flex.EDGE_RIGHT, right.percentage);
		} else {
			const originalRight = computedStyle.getPropertyValue("right");
			if (originalRight === "auto" || !originalRight) {
				flexNode.setPositionAuto(Flex.EDGE_RIGHT);
			}
		}

		// Handle bottom positioning
		const bottom = parseUnitValue(computedStyle.getPropertyValue("bottom"));
		if (typeof bottom === "number") {
			flexNode.setPosition(Flex.EDGE_BOTTOM, bottom);
		} else if (bottom && "percentage" in bottom) {
			flexNode.setPositionPercent(Flex.EDGE_BOTTOM, bottom.percentage);
		} else {
			const originalBottom = computedStyle.getPropertyValue("bottom");
			if (originalBottom === "auto" || !originalBottom) {
				flexNode.setPositionAuto(Flex.EDGE_BOTTOM);
			}
		}
	} else if (position === "relative") {
		flexNode.setPositionType(Flex.POSITION_TYPE_RELATIVE);
		// For relative positioning, also apply left/top/right/bottom offsets
		// (same pattern as absolute, but with relative position type)
		const left = parseUnitValue(computedStyle.getPropertyValue("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		}

		const top = parseUnitValue(computedStyle.getPropertyValue("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		}
	} else if (position === "fixed") {
		// In terminal context, fixed positioning is treated like absolute
		// positioning relative to the root element (the viewport).
		// The engine has no fixed position type, so we use absolute.
		flexNode.setPositionType(Flex.POSITION_TYPE_ABSOLUTE);

		const left = parseUnitValue(computedStyle.getPropertyValue("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		}

		const top = parseUnitValue(computedStyle.getPropertyValue("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		}

		const right = parseUnitValue(computedStyle.getPropertyValue("right"));
		if (typeof right === "number") {
			flexNode.setPosition(Flex.EDGE_RIGHT, right);
		} else if (right && "percentage" in right) {
			flexNode.setPositionPercent(Flex.EDGE_RIGHT, right.percentage);
		}

		const bottom = parseUnitValue(computedStyle.getPropertyValue("bottom"));
		if (typeof bottom === "number") {
			flexNode.setPosition(Flex.EDGE_BOTTOM, bottom);
		} else if (bottom && "percentage" in bottom) {
			flexNode.setPositionPercent(Flex.EDGE_BOTTOM, bottom.percentage);
		}
	} else if (position === "static") {
		flexNode.setPositionType(Flex.POSITION_TYPE_STATIC);
	} else {
		flexNode.setPositionType(Flex.POSITION_TYPE_STATIC);
	}
}

class DOMRectList extends Array<DOMRect> implements globalThis.DOMRectList {
	item(index: number): globalThis.DOMRect | null {
		if (index < 0 || index >= this.length) {
			return null;
		}
		return this[index];
	}
}

Object.defineProperty(DOMRectList.prototype, Symbol.toStringTag, {
	value: "DOMRectList",
	configurable: true,
});

// Inline layout types (moved from breaker.ts)
export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: BoxModel;
	contentWidth: number;
	contentHeight: number;
}

export interface TextLeaf {
	type: "text";
	node: Text;
	content: string;
}

export interface BRLeaf {
	type: "br";
	node: HTMLBRElement;
}

export type Leaf = InlineBlockLeaf | TextLeaf | BRLeaf;

export interface LineResult {
	segments: Array<{
		leaf: Leaf;
		start: number;
		end: number;
		x: number;
		width: number;
		processedText: string;
	}>;
	y: number;
	width: number;
	height: number;
}

export interface BreakResult {
	lines: LineResult[];
	maxLineWidth: number;
	totalHeight: number;
}

interface BreakOptions {
	maxWidth: number;
	whiteSpace?: string;
	wordBreak?: string;
	overflowWrap?: string;
}

interface ProcessedContent {
	items: Array<{
		leafNode: Leaf;
		start: number;
		end: number;
		processedContent?: string;
	}>;
	text: string;
}

interface BreakPoint {
	position: number;
	required: boolean;
}

export interface RectText {
	rect: DOMRect;
	text: string; // Processed text to render (replaces textLength)
}

const flexConfig = Flex.Config.create();
flexConfig.setUseWebDefaults(true);
flexConfig.setPointScaleFactor(1.0);

export class LayoutEngine {
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare window: DOMWindow;

	// TODO:
	declare terminalWidth: number;
	declare terminalHeight: number;

	// Viewport root node - represents terminal dimensions, no DOM element associated
	declare viewportRootNode: FlexTypes.Node;

	// Public Maps for debugging
	public nodeMap: Map<Node, FlexTypes.Node>;
	public breakResultMap: Map<Node, BreakResult>;

	// Track nodes that were invalidated and need re-adding during calculateLayout
	private invalidatedNodes: Set<Node>;

	// Track layout nodes that have measure functions (for resize invalidation)
	private measureNodes: Set<FlexTypes.Node>;

	constructor(window: DOMWindow) {
		this.window = window;
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new Map<Node, FlexTypes.Node>();
		this.breakResultMap = new Map<Node, BreakResult>();
		this.invalidatedNodes = new Set<Node>();
		this.measureNodes = new Set<FlexTypes.Node>();

		// Create viewport root node (no DOM element associated)
		this.viewportRootNode = Flex.Node.create();
		this.viewportRootNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		this.viewportRootNode.setAlignItems(Flex.ALIGN_STRETCH);

		// Attach HTML element to viewport root instead of null
		this.#addNode(this.rootElement, this.viewportRootNode);
	}

	resize(width: number, height: number): void {
		this.terminalWidth = width;
		this.terminalHeight = height;

		// Set dimensions on the viewport root node (terminal dimensions)
		this.viewportRootNode.setWidth(width);
		this.viewportRootNode.setHeight(height);

		// Clear all cached break results so text re-wraps at new width
		this.breakResultMap.clear();

		// Mark all leaf nodes (those with measure functions) as dirty
		// so the engine re-invokes their measure functions with the new available width
		for (const flexNode of this.measureNodes) {
			flexNode.markDirty();
		}

		// Force recalculation of all layout after size change
		this.calculateLayout();
	}

	calculateLayout() {
		// Nothing marked dirty and nothing awaiting re-add: the previous layout
		// still holds, and even the pruning sweep below -- O(nodes) isConnected
		// checks -- is not worth paying. Every mutation path dirties the tree on
		// its way in, so a clean tree cannot be hiding a disconnection.
		if (!this.viewportRootNode.dirty && this.invalidatedNodes.size === 0) {
			return;
		}

		// Drop nodes whose DOM node is gone. Callers may invoke calculateLayout()
		// synchronously after a DOM removal, before the MutationObserver microtask
		// has run, which would otherwise leave the removed node attached here and
		// get it measured -- and measuring a detached run head has no parent to
		// collect leaves from.
		this.#pruneDisconnectedNodes();

		// Re-add invalidated nodes that are still connected to DOM
		for (const node of this.invalidatedNodes) {
			if (node.isConnected) {
				// Find parent that has a layout node to attach to
				let parent = node.parentElement;
				while (parent) {
					const parentFlexNode = this.nodeMap.get(parent);
					if (parentFlexNode) {
						this.#addNode(node, parentFlexNode);
						break;
					}
					parent = parent.parentElement;
				}
			}
		}
		this.invalidatedNodes.clear();

		// Every mutation path marks the flex tree dirty on its way in -- style
		// setters, child insertion/removal, inline-run invalidation, resize. A
		// clean root therefore means the previous layout is still exact, and
		// recomputing it would be pure waste: an animation repainting one span
		// used to pay a full-tree relayout on every frame.
		if (!this.viewportRootNode.dirty) {
			return;
		}

		// Calculate layout using viewport root node (terminal dimensions)
		// The HTML element can now have auto height and reference viewport via percentages
		this.viewportRootNode.calculateLayout(
			this.terminalWidth,
			this.terminalHeight,
		);
	}

	/**
	 * A node is live if it is still in the document, or -- for pseudo-elements,
	 * which are never "connected" themselves -- if its host element is.
	 */
	#isNodeLive(node: Node): boolean {
		if (node.isConnected) return true;
		const pseudoMetadata = getPseudoMetadata(node);
		return Boolean(pseudoMetadata?.hostElement.isConnected);
	}

	#pruneDisconnectedNodes(): void {
		for (const [node, flexNode] of this.nodeMap) {
			if (node === this.rootElement || this.#isNodeLive(node)) {
				continue;
			}

			const parent = flexNode.getParent();
			if (parent) {
				parent.removeChild(flexNode);
			}

			this.measureNodes.delete(flexNode);
			flexNode.freeRecursive();
			this.nodeMap.delete(node);
			this.breakResultMap.delete(node);
			this.invalidatedNodes.delete(node);
		}
	}

	/**
	 * Clean up layout nodes and resources
	 */
	dispose(): void {
		// Clean up viewport root node (this will recursively free all child layout nodes)
		this.viewportRootNode.freeRecursive();

		// Clear the maps (now regular Maps for debugging)
		this.nodeMap = new Map();
		this.breakResultMap = new Map();
		this.invalidatedNodes = new Set();
		this.measureNodes = new Set();
	}

	/**
	 * Get the actual height of the document content after layout calculation
	 * Used for implementing standard DOM scrollHeight property
	 */
	getContentHeight(): number {
		const bodyRect = this.getRect(this.rootElement.ownerDocument?.body);
		if (bodyRect) {
			return Math.ceil(bodyRect.height);
		}
		return 0;
	}

	/**
	 * True when nothing in the element's subtree can paint inside the document
	 * rows [top, bottom) -- its cached paint extent (own box unioned with every
	 * descendant's, absolutes included) lies entirely outside the band.
	 *
	 * Conservative: an element without its own layout node is never culled, and
	 * a stale answer is impossible because extents are recomputed with layout
	 * and layout is recomputed whenever the tree is dirty.
	 */
	isSubtreeOutsideBand(element: Element, top: number, bottom: number): boolean {
		const node = this.nodeMap.get(element);
		if (!node) return false;
		return node.extentBottom <= top || node.extentTop >= bottom;
	}

	getRect(element: Element): DOMRect | null {
		const display = getPropertyValue(element, "display");

		// For inline/inline-block elements, check if they appear in breakResults
		if (display === "inline" || display === "inline-block") {
			// For inline-block elements, search through all breakResults to find this element
			if (display === "inline-block") {
				// Find the inline run head that contains this element
				const runHead = this.findInlineRunHead(element);
				if (runHead) {
					const breakResult = this.breakResultMap.get(runHead);
					if (breakResult) {
						for (const line of breakResult.lines) {
							for (const segment of line.segments) {
								if (
									segment.leaf.type === "inline-block" &&
									segment.leaf.node === element
								) {
									// Get absolute position of the inline-block element
									const flexNode = this.nodeMap.get(element);
									if (!flexNode) {
										// Fallback to relative position if no layout node
										return new this.DOMRect(
											segment.x,
											line.y,
											segment.width,
											line.height,
										);
									}
									const {x, y} = getAbsolutePosition(flexNode);
									return new this.DOMRect(x, y, segment.width, line.height);
								}
							}
						}
					}
				}
			}

			// For inline elements, use getRectTexts
			const rectTexts = this.getRectTexts(element);
			if (rectTexts.length > 0) {
				// Calculate bounding box from all rectTexts
				let minX = Infinity;
				let minY = Infinity;
				let maxX = -Infinity;
				let maxY = -Infinity;

				for (const rectText of rectTexts) {
					const rect = rectText.rect;
					minX = Math.min(minX, rect.x);
					minY = Math.min(minY, rect.y);
					maxX = Math.max(maxX, rect.x + rect.width);
					maxY = Math.max(maxY, rect.y + rect.height);
				}

				return new this.DOMRect(minX, minY, maxX - minX, maxY - minY);
			}
		}

		// Fall back to the layout node for block elements and containers
		let flexNode = this.nodeMap.get(element);

		if (!flexNode) {
			return null;
		}

		const {x, y} = getAbsolutePosition(flexNode);

		return new this.DOMRect(
			x,
			y,
			flexNode.getComputedWidth(),
			flexNode.getComputedHeight(),
		);
	}

	getRectTexts(node: Node): RectText[] {
		// This method handles two main scenarios:
		// 1. Direct calls on inline-block elements (special case below)
		// 2. Calls on elements/text inside inline-blocks (general walk-up logic)

		// Handle element nodes
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			// For block elements, return empty array (no inline text layout)
			if (display !== "inline" && display !== "inline-block") {
				return [];
			}

			// Special case: inline-block element called directly (e.g., getRectTexts(inlineBlockDiv))
			// The element's breakResult contains itself as an inline-block segment with nested content
			if (display === "inline-block" && this.isInlineRunHead(element)) {
				const breakResult = this.breakResultMap.get(element);
				if (breakResult) {
					// The breakResult contains this inline-block as a segment with nested content
					const rectTexts: RectText[] = [];
					const flexNode = this.nodeMap.get(element);
					if (!flexNode) return [];

					const {x: containerX, y: containerY} = getAbsolutePosition(flexNode);

					for (const line of breakResult.lines) {
						for (const segment of line.segments) {
							if (
								segment.leaf.type === "inline-block" &&
								segment.leaf.node === element &&
								segment.leaf.breakResult
							) {
								// Extract text from the nested breakResult
								const nestedBreakResult = segment.leaf.breakResult;
								// Get padding offsets for text positioning
								const paddingLeft = segment.leaf.boxModel.paddingLeft;
								const paddingTop = segment.leaf.boxModel.paddingTop;
								for (const nestedLine of nestedBreakResult.lines) {
									for (const nestedSegment of nestedLine.segments) {
										if (nestedSegment.leaf.type === "text") {
											rectTexts.push({
												text: nestedSegment.processedText,
												rect: new this.DOMRect(
													containerX +
														segment.x +
														paddingLeft +
														nestedSegment.x,
													containerY + line.y + paddingTop + nestedLine.y,
													nestedSegment.width,
													nestedLine.height,
												),
											});
										} else if (
											nestedSegment.leaf.type === "inline-block" &&
											nestedSegment.leaf.breakResult
										) {
											// Recursively extract text from nested inline-block
											const nestedInlineBlock = nestedSegment.leaf;
											const nestedPaddingLeft =
												nestedInlineBlock.boxModel.paddingLeft;
											const nestedPaddingTop =
												nestedInlineBlock.boxModel.paddingTop;

											for (const innerLine of nestedInlineBlock.breakResult!
												.lines) {
												for (const innerSegment of innerLine.segments) {
													if (innerSegment.leaf.type === "text") {
														rectTexts.push({
															text: innerSegment.processedText,
															rect: new this.DOMRect(
																containerX +
																	segment.x +
																	paddingLeft +
																	nestedSegment.x +
																	nestedPaddingLeft +
																	innerSegment.x,
																containerY +
																	line.y +
																	paddingTop +
																	nestedLine.y +
																	nestedPaddingTop +
																	innerLine.y,
																innerSegment.width,
																innerLine.height,
															),
														});
													}
													// Could add more nesting levels here if needed
												}
											}
										}
									}
								}
							}
						}
					}
					return rectTexts;
				}
			}
		}

		// Find the inline run head for this node
		const runHead = this.findInlineRunHead(node);
		if (!runHead) {
			return [];
		}

		// Get stored BreakResult for the run head
		let breakResult = this.breakResultMap.get(runHead);
		if (!breakResult) {
			return [];
		}

		// Get run head's absolute position by accumulating parent positions
		const flexNode = this.nodeMap.get(runHead);
		if (!flexNode) return [];

		let {x: containerX, y: containerY} = getAbsolutePosition(flexNode);

		// Walk from target node up to runHead, handling nested inline-blocks
		// This handles the case where getRectTexts is called on elements/text inside inline-blocks
		let currentBreakResult = breakResult;
		let accumulatedOffsetX = 0;
		let accumulatedOffsetY = 0;
		let currentNode = node;

		while (currentNode !== runHead && currentNode.parentElement) {
			const parent = currentNode.parentElement;

			if (getPropertyValue(parent, "display") === "inline-block") {
				// Find this inline-block in current breakResult
				let found = false;
				for (const line of currentBreakResult.lines) {
					for (const segment of line.segments) {
						if (
							segment.leaf.type === "inline-block" &&
							segment.leaf.node === parent
						) {
							// Accumulate offset including padding and switch to internal breakResult
							accumulatedOffsetX +=
								segment.x + segment.leaf.boxModel.paddingLeft;
							accumulatedOffsetY += line.y + segment.leaf.boxModel.paddingTop;
							if (segment.leaf.breakResult) {
								currentBreakResult = segment.leaf.breakResult;
							}
							found = true;
							break;
						}
					}
					if (found) break;
				}
			}
			currentNode = parent;
		}

		// Apply accumulated offsets
		containerX += accumulatedOffsetX;
		containerY += accumulatedOffsetY;
		breakResult = currentBreakResult;

		// Collect target text nodes based on node type
		let targetTextNodes: Set<Text>;

		if (node.nodeType === node.TEXT_NODE) {
			targetTextNodes = new Set([node as Text]);
		} else {
			// For element nodes, collect all descendant text nodes
			targetTextNodes = new Set<Text>();

			// Use ExpandedTreeWalker for traversal
			const walker = createExpandedTreeWalker(this.window, node);

			let textNode;
			while ((textNode = walker.nextNode())) {
				targetTextNodes.add(textNode as Text);
			}
		}

		const rectTexts: RectText[] = [];

		// Helper function to recursively find target text nodes in segments
		const findTargetTextInSegments = (
			segments: any[],
			baseX: number,
			baseY: number,
		): Array<{x: number; width: number; text: string}> => {
			const results: Array<{x: number; width: number; text: string}> = [];

			for (const segment of segments) {
				if (
					segment.leaf.type === "text" &&
					targetTextNodes.has(segment.leaf.node as Text)
				) {
					results.push({
						x: baseX + segment.x,
						width: segment.width,
						text: segment.processedText,
					});
				} else if (
					segment.leaf.type === "inline-block" &&
					segment.leaf.breakResult
				) {
					// Recursively search within nested inline-block
					const paddingLeft = segment.leaf.boxModel.paddingLeft;
					const paddingTop = segment.leaf.boxModel.paddingTop;

					for (const nestedLine of segment.leaf.breakResult.lines) {
						const nestedResults = findTargetTextInSegments(
							nestedLine.segments,
							baseX + segment.x + paddingLeft,
							baseY + paddingTop + nestedLine.y,
						);
						results.push(...nestedResults);
					}
				}
			}

			return results;
		};

		// Merge segments per line that belong to this node
		for (const line of breakResult.lines) {
			const targetTexts = findTargetTextInSegments(line.segments, 0, line.y);

			if (targetTexts.length > 0) {
				let minX = Infinity;
				let maxX = -Infinity;
				let concatenatedText = "";

				for (const targetText of targetTexts) {
					minX = Math.min(minX, targetText.x);
					maxX = Math.max(maxX, targetText.x + targetText.width);
					concatenatedText += targetText.text;
				}

				const rect = new this.DOMRect(
					containerX + minX,
					containerY + line.y,
					maxX - minX,
					line.height,
				);
				rectTexts.push({
					rect,
					text: concatenatedText,
				});
			}
		}

		return rectTexts;
	}

	getRects(node: Node): DOMRect[] {
		// For block elements, just return getBoundingClientRect in an array
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			if (display !== "inline" && display !== "inline-block") {
				// Block element - use standard getBoundingClientRect
				const rect = this.getRect(element);
				return rect ? [rect] : [];
			}
		}

		// For inline elements, use getRectTexts and extract just the rects
		return this.getRectTexts(node).map((rectText) => rectText.rect);
	}

	createDOMRectList(rects?: globalThis.DOMRect[]): globalThis.DOMRectList {
		const list = new DOMRectList();
		if (rects) {
			list.push(...rects);
		}
		return list;
	}

	createDOMRect(
		x: number = 0,
		y: number = 0,
		width: number = 0,
		height: number = 0,
	): globalThis.DOMRect {
		return new this.DOMRect(x, y, width, height);
	}

	/**
	 * A "run head" is the first node in a contiguous run of inline-level
	 * elements. This is a TermDOM implementation detail for implementing CSS
	 * inline layout with measure functions.
	 *
	 * The run head node:
	 * - Gets the layout node with a measure function
	 * - Assigns a breakResult entry
	 * - Other inline nodes in the run delegate their layout to this head
	 *
	 * Examples:
	 * - "Hello" + <span>world</span>: "Hello" text node is run head
	 * - <em>text</em> + "more": <em> element is run head
	 * - <div>text</div>: "text" is run head (block creates new context)
	 * - In flex containers: each flex item gets its own run head
	 * - Block interruption: <span>text</span><div>block</div><span>more</span>
	 *   creates separate runs with separate heads
	 *
	 * Note: Pseudo-elements (::before, ::marker, ::after) are treated as
	 * text nodes and can participate in inline runs.
	 */
	findInlineRunHead(node: Node): Node | null {
		// 1. Validate input
		if (!node.isConnected) {
			// For pseudo elements, check if the host element is connected
			const pseudoMetadata = getPseudoMetadata(node);
			if (!pseudoMetadata || !pseudoMetadata.hostElement.isConnected) {
				return null;
			}
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") {
				return null;
			}
		} else if (node.nodeType !== node.TEXT_NODE) {
			return null;
		}

		// 2. Create ExpandedTreeWalker to traverse elements, text nodes, and pseudo-elements
		const walker = createExpandedTreeWalker(
			this.window,
			node.ownerDocument || this.window.document,
		);

		// Position walker at starting node
		walker.currentNode = node;
		let current = node;

		// 3. Traverse up through inline parents
		while (walker.parentNode()) {
			const parent = walker.currentNode;
			if (parent.nodeType !== parent.ELEMENT_NODE) continue;

			const parentDisplay = getPropertyValue(parent as Element, "display");

			if (parentDisplay === "inline") {
				current = parent;
			} else if (parentDisplay === "inline-block") {
				// Only walk up through inline-block if current node is inline (not inline-block)
				if (node.nodeType === node.ELEMENT_NODE) {
					const nodeDisplay = getPropertyValue(node as Element, "display");
					if (nodeDisplay === "inline") {
						current = parent;
					} else {
						// Current node is inline-block, stop here
						break;
					}
				} else {
					// Current node is text, can walk up through inline-block
					current = parent;
				}
			} else {
				break;
			}
		}

		// 4. Reset walker to current position and check container type
		walker.currentNode = current;
		const isInFlex =
			current.parentElement &&
			getPropertyValue(current.parentElement, "display") === "flex";

		if (isInFlex) {
			// 5a. Flex container traversal
			if (current.nodeType === current.ELEMENT_NODE) {
				return current; // Elements in flex are their own run heads
			}

			while (walker.previousSibling()) {
				const prev = walker.currentNode;

				if (prev.nodeType === prev.ELEMENT_NODE) {
					break; // Stop at any element in flex
				}
				// Must be text node due to TreeWalker filter
				current = prev;
			}
		} else {
			// 5b. Normal flow traversal
			while (walker.previousSibling()) {
				const prev = walker.currentNode;

				if (prev.nodeType === prev.ELEMENT_NODE) {
					const prevElement = prev as Element;
					const prevDisplay = getPropertyValue(prevElement, "display");
					if (prevDisplay === "inline" || prevDisplay === "inline-block") {
						current = prevElement;
					} else {
						break;
					}
				} else {
					// Must be text node due to TreeWalker filter
					current = prev;
				}
			}
		}

		return current;
	}

	isInlineRunHead(node: Node): boolean {
		return this.findInlineRunHead(node) === node;
	}

	/**
	 * Invalidate a node, handling both block and inline elements appropriately
	 * For inline elements, invalidates the entire inline run
	 * For block elements, invalidates their layout by removing from nodeMap
	 */
	invalidate(node: Node): void {
		// Track this node for re-adding during calculateLayout
		this.invalidatedNodes.add(node);

		// If it's an inline-level node, invalidate the entire run
		if (this.#isInlineLevel(node)) {
			this.#invalidateInlineRun(node);
		} else if (node.nodeType === node.ELEMENT_NODE) {
			// For block-level elements, remove from nodeMap to force recreation
			// We can't call markDirty() on container nodes as the engine only allows
			// leaf nodes with measure functions to be marked dirty
			const flexNode = this.nodeMap.get(node);
			if (flexNode) {
				// Get parent before removing from map
				const parent = flexNode.getParent();
				if (parent) {
					parent.removeChild(flexNode);
				}

				// Check if node was actually removed vs just being invalidated (e.g., for pseudo-elements)
				if (!node.isConnected) {
					// Node was truly removed from DOM - free it
					this.measureNodes.delete(flexNode);
					flexNode.freeRecursive();
					this.nodeMap.delete(node);
				} else {
					// Node is still connected - just remove from parent but keep the layout
					// node for reuse. It will be reattached during layout calculation.
					//
					// Re-apply its styles, though: whatever invalidated the element may
					// have changed them. A list's padding-left is derived from its items'
					// markers, so appending a wider item changes the parent's computed
					// padding, and reusing the node as-is would keep the stale gutter.
					styleFlexNode(node as Element, flexNode);
				}
			}

			// Recursively invalidate all children (including inline runs within this block element)
			this.#invalidateNodeChildren(node as Element);
		}
	}

	/**
	 * Recursively invalidate all children of an element
	 */
	#invalidateNodeChildren(element: Element): void {
		const walker = createExpandedTreeWalker(this.window, element);
		let child = walker.firstChild();

		while (child) {
			this.invalidate(child);
			child = walker.nextSibling();
		}
	}

	#clearBreakResultCache(node: Node): void {
		// Find the run head for this node
		const runHead = this.findInlineRunHead(node);
		if (runHead) {
			this.breakResultMap.delete(runHead);
		}
	}

	/**
	 * Clear all break results for nodes that are part of the same inline run as the given node.
	 * This handles the case where run structure changes and old break results become orphaned.
	 */
	#clearAllBreakResultsInRun(node: Node): void {
		// Find the container element for this inline run
		const container = this.#findInlineRunContainer(node);
		if (!container) return;

		// Find all inline-level nodes in the container
		const inlineNodes: Node[] = [];
		const walker = createExpandedTreeWalker(this.window, container);

		let child = walker.firstChild();
		while (child) {
			if (this.#isInlineLevel(child)) {
				inlineNodes.push(child);
			}
			child = walker.nextSibling();
		}

		// Delete break results for any of these nodes that have them
		for (const inlineNode of inlineNodes) {
			if (this.breakResultMap.has(inlineNode)) {
				this.breakResultMap.delete(inlineNode);
			}
		}
	}

	/**
	 * Find the container element that holds the inline run containing the given node
	 */
	#findInlineRunContainer(node: Node): Element | null {
		let current =
			node.nodeType === node.ELEMENT_NODE
				? (node as Element)
				: node.parentElement;

		while (current) {
			const display = getPropertyValue(current, "display");
			// Stop at block-level containers that can contain inline runs
			if (display !== "inline" && display !== "inline-block") {
				return current;
			}
			current = current.parentElement;
		}

		return null;
	}

	#invalidateInlineRun(node: Node): void {
		const runHead = this.findInlineRunHead(node);
		if (runHead) {
			// Clear ALL break results for nodes in this inline run
			// This handles the case where run head changes and old break results become orphaned
			this.#clearAllBreakResultsInRun(node);

			// Also clear the current run head's break result
			this.breakResultMap.delete(runHead);

			// If this node has a layout node but is NOT the run head, clean it up
			if (runHead !== node && this.nodeMap.has(node)) {
				const flexNode = this.nodeMap.get(node);
				if (flexNode) {
					// Remove from parent
					const parent = node.parentElement;
					if (parent) {
						const parentFlexNode = this.nodeMap.get(parent);
						if (parentFlexNode) {
							parentFlexNode.removeChild(flexNode);
						}
					}
					// Free and remove from map
					const pseudoMeta = getPseudoMetadata(node);
					if (pseudoMeta) {
						// Removing pseudo element from nodeMap during invalidateInlineRun cleanup
					}
					this.measureNodes.delete(flexNode);
					flexNode.freeRecursive();
					this.nodeMap.delete(node);
				}
			}

			// Ensure the actual run head has a layout node
			if (!this.nodeMap.has(runHead)) {
				// Find the parent that should contain this run head's layout node
				let parent = runHead.parentElement;
				while (parent) {
					const parentFlexNode = this.nodeMap.get(parent);
					if (parentFlexNode) {
						// Add the run head to the layout tree
						this.#addNode(runHead, parentFlexNode);
						break;
					}
					parent = parent.parentElement;
				}
			} else {
				// Run head already has a layout node, just mark it dirty
				const flexNode = this.nodeMap.get(runHead);
				if (flexNode) {
					flexNode.markDirty();
				}
			}
		}
	}

	#isInlineLevel(node: Node): boolean {
		if (node.nodeType === node.TEXT_NODE) {
			// Regular text nodes and pseudo-element text nodes are inline-level
			return true;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");
			return display === "inline" || display === "inline-block";
		}

		return false;
	}

	/**
	 * Determines if a whitespace-only text node should be collapsed to nothing
	 * according to CSS whitespace collapsing rules in block formatting contexts
	 */
	#shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
		// Only collapse whitespace-only text nodes
		if (!textNode.textContent || !/^\s*$/.test(textNode.textContent)) {
			return false;
		}

		// Get parent element
		const parent = textNode.parentElement;
		if (!parent) {
			return false;
		}

		// Check parent's display type - only collapse in block formatting contexts
		const parentDisplay = getPropertyValue(parent, "display");
		if (parentDisplay === "inline" || parentDisplay === "inline-block") {
			// In inline contexts, preserve whitespace as spaces
			return false;
		}

		// Check if this whitespace is between block-level elements
		const prevSibling = textNode.previousSibling;
		const nextSibling = textNode.nextSibling;

		// Helper to check if a node is block-level
		const isBlockLevel = (node: Node | null): boolean => {
			if (!node || node.nodeType !== node.ELEMENT_NODE) {
				return false;
			}
			const display = getPropertyValue(node as Element, "display");
			return display !== "inline" && display !== "inline-block";
		};

		// If whitespace is between two block elements, collapse it
		if (isBlockLevel(prevSibling) && isBlockLevel(nextSibling)) {
			return true;
		}

		// If whitespace is at the start/end of a block container next to a block element, collapse it
		if (isBlockLevel(prevSibling) && !nextSibling) {
			return true; // End of container after block element
		}

		if (!prevSibling && isBlockLevel(nextSibling)) {
			return true; // Start of container before block element
		}

		// If whitespace is the only content at start/end of block container, collapse it
		if (!prevSibling && !nextSibling) {
			return true; // Only content in block container
		}

		return false;
	}

	public handleMutations(mutations: MutationRecord[]): void {
		this.#handleMutationRecords(mutations);
	}

	#handleMutationRecords(mutations: MutationRecord[]): void {
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];
			if (record.type === "attributes") {
				if (record.attributeName === "style") {
					const element = record.target as Element;
					const flexNode = this.nodeMap.get(element);
					if (flexNode) {
						styleFlexNode(element, flexNode);
						// Invalidate inline runs if style changes might affect layout
						this.#invalidateInlineRun(element);
					}
				}
				// On to the next record -- returning here would silently drop every
				// remaining mutation in the batch, so a class flip followed by a
				// sibling's text change lost the text change entirely.
				continue;
			} else if (record.type === "characterData") {
				const textNode = record.target as Text;
				// Invalidate the inline run containing this text node
				this.#invalidateInlineRun(textNode);
				continue;
			}

			// Handle added nodes
			for (let j = 0; j < record.addedNodes.length; j++) {
				const node = record.addedNodes[j];
				const parentElement = record.target as Element;
				const parentFlexNode = this.nodeMap.get(parentElement);

				// Skip adding children if parent is inline-block (it uses measure function and cannot have children)
				const parentDisplay = getPropertyValue(parentElement, "display");
				if (parentDisplay === "inline-block") {
					continue;
				}

				if (!parentFlexNode) {
					// If parent has no layout node, it might be an inline element that's part of a run
					// Instead of adding to the layout tree, just invalidate the inline run
					if (this.#isInlineLevel(node)) {
						this.#invalidateInlineRun(node);
						this.#invalidateInlineRun(parentElement); // Also invalidate parent's run
						continue; // Skip normal layout tree addition
					} else {
						// Block elements should have parents with layout nodes
						throw new Error(
							`No parent layout node found for added node ${node.nodeName} under ${parentElement.tagName}`,
						);
					}
				}

				// Add the node to Flex layout
				this.#addNode(node, parentFlexNode);

				// Invalidate inline runs that might be affected by this addition
				if (this.#isInlineLevel(node)) {
					// If adding an inline node, invalidate the run it joins
					this.#invalidateInlineRun(node);

					// Also check if this changes the run head of existing runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this.#invalidateInlineRun(nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this.#invalidateInlineRun(prevSibling);
					}
				} else {
					// Block element added - might split inline runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this.#invalidateInlineRun(nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this.#invalidateInlineRun(prevSibling);
					}
				}
			}

			// Handle removed nodes
			for (let j = 0; j < record.removedNodes.length; j++) {
				const node = record.removedNodes[j];
				const parent = record.target as Element;

				// Invalidate inline runs that might be affected by the removal
				// Use MutationRecord siblings since the removed node is disconnected
				if (
					record.previousSibling &&
					this.#isInlineLevel(record.previousSibling)
				) {
					this.#invalidateInlineRun(record.previousSibling);
				}
				if (record.nextSibling && this.#isInlineLevel(record.nextSibling)) {
					this.#invalidateInlineRun(record.nextSibling);
				}

				this.#removeNode(node, parent);
			}
		}
	}

	#addNode(node: Node, parentFlexNode: FlexTypes.Node | null = null): void {
		if (this.nodeMap.has(node)) {
			// Node already exists - this might be a moved node that needs reparenting
			const existingFlexNode = this.nodeMap.get(node);
			if (existingFlexNode && parentFlexNode) {
				// Check if it's already a child of the correct parent
				const currentParent = existingFlexNode.getParent();
				if (currentParent !== parentFlexNode) {
					// Remove from current parent first (if any)
					if (currentParent) {
						currentParent.removeChild(existingFlexNode);
					}
					// Add to new parent
					const flexIndex = this.#getFlexIndex(node as Element);
					parentFlexNode.insertChild(existingFlexNode, flexIndex);
				}
			}
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.#addElementNode(node as Element, parentFlexNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.#addTextNode(node as Text, parentFlexNode);
		}
	}

	#addElementNode(
		element: Element,
		parentFlexNode: FlexTypes.Node | null = null,
	): void {
		const flexIndex = this.#getFlexIndex(element);
		const display = getPropertyValue(element, "display");

		// For inline elements, we need to find or create the run head
		if (display === "inline" || display === "inline-block") {
			const runHead = this.findInlineRunHead(element);
			if (runHead && runHead !== element) {
				// This element is part of an existing run - the run head will handle it
				// Clear any cached results for the run head to force re-measurement
				this.#clearBreakResultCache(runHead);
				const runHeadFlexNode = this.nodeMap.get(runHead);
				if (runHeadFlexNode) {
					runHeadFlexNode.markDirty();
				}
				return;
			}
			// If runHead === element, this is the run head - proceed to create layout node
		}

		let flexNode = this.nodeMap.get(element);
		if (!flexNode) {
			flexNode = Flex.Node.createWithConfig(flexConfig);
			this.nodeMap.set(element, flexNode);
		}

		styleFlexNode(element, flexNode);

		if (display === "none") {
			flexNode.setDisplay(Flex.DISPLAY_NONE);
			if (flexNode && parentFlexNode) {
				parentFlexNode.insertChild(flexNode, flexIndex);
			}
			return;
		} else if (display === "inline" || display === "inline-block") {
			flexNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.#measureInlineRun(
					element,
					width,
					widthMode,
					height,
					heightMode,
				);
			});
			this.measureNodes.add(flexNode);

			// Note: Automatic minimum size for flex items is now handled in measureInlineRun

			if (flexNode && parentFlexNode) {
				parentFlexNode.insertChild(flexNode, flexIndex);
			}

			return;
		}

		// Block elements should NOT get measure functions - only their inline children do.
		// This prevents Flex constraint violations (nodes with measure functions cannot have children)

		// Inline-block elements cannot have children in the layout tree because they use measure functions
		if (display === "inline-block") {
			return;
		}

		// Use ExpandedTreeWalker to traverse children including pseudo-elements
		const walker = createExpandedTreeWalker(this.window, element);

		// Start with first child (skip the element itself)
		let child = walker.firstChild();
		while (child) {
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = getPropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					if (display === "flex") {
						this.#addNode(child, flexNode);
					} else {
						this.#addNode(child, flexNode);
					}
				} else {
					this.#addNode(child, flexNode);
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Text nodes need to be added to the layout tree
				this.#addNode(child, flexNode);
			}
			child = walker.nextSibling();
		}

		if (flexNode && parentFlexNode) {
			parentFlexNode.insertChild(flexNode, flexIndex);
		}
	}

	#addTextNode(text: Text, parentFlexNode: FlexTypes.Node | null = null): void {
		if (!parentFlexNode) {
			return;
		}

		// For text nodes, find the inline run head
		const runHead = this.findInlineRunHead(text);
		if (runHead && runHead !== text) {
			// This text node is part of an existing run - the run head will handle it
			// Clear any cached results for the run head to force re-measurement
			this.#clearBreakResultCache(runHead);
			const runHeadFlexNode = this.nodeMap.get(runHead);
			if (runHeadFlexNode) {
				runHeadFlexNode.markDirty();
			}
			return;
		}

		// This text node is the run head - create a layout node for it
		let flexNode = this.nodeMap.get(text);
		if (!flexNode) {
			flexNode = Flex.Node.createWithConfig(flexConfig);
			this.nodeMap.set(text, flexNode);
		}

		flexNode.setMeasureFunc(
			(
				width: number,
				widthMode: FlexTypes.MeasureMode,
				height: number,
				heightMode: FlexTypes.MeasureMode,
			) => {
				return this.#measureInlineRun(
					text,
					width,
					widthMode,
					height,
					heightMode,
				);
			},
		);
		this.measureNodes.add(flexNode);

		// Note: Automatic minimum size for flex items is now handled in measureInlineRun

		parentFlexNode.insertChild(flexNode, parentFlexNode.getChildCount());
	}

	/**
	 * Remove a node from the layout tree, handling both elements and text nodes
	 */
	#removeNode(node: Node, parent: Element): void {
		if (node.nodeType === node.ELEMENT_NODE) {
			this.#removeElement(node as Element, parent);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.#removeText(node as Text, parent);
		}
	}

	/**
	 * Remove an element node from the layout tree
	 */
	#removeElement(element: Element, parent: Element): void {
		// Invalidate inline runs before removing the element
		if (this.#isInlineLevel(element)) {
			this.#invalidateInlineRemoval(element);
		} else {
			this.#invalidateBlockRemoval(parent);
		}

		// Remove from Flex layout
		const flexNode = this.nodeMap.get(element);
		if (flexNode) {
			const parentFlexNode = this.nodeMap.get(parent);
			if (parentFlexNode) {
				parentFlexNode.removeChild(flexNode);
			}

			// Check if element was actually removed vs just moved
			if (!element.isConnected) {
				// Element was truly removed from DOM - free it
				const pseudoMeta = getPseudoMetadata(element);
				if (pseudoMeta) {
					// Removing pseudo element from nodeMap during mutation removal
				}
				this.measureNodes.delete(flexNode);
				flexNode.freeRecursive();
				this.nodeMap.delete(element);
			}
			// If element.isConnected is true, element was moved - keep layout node and nodeMap entry
			// It will be re-added to the new parent when that mutation is processed
		}

		// Clear any cached break results for this element
		this.#clearBreakResultCache(element);
	}

	/**
	 * Remove a text node from the layout tree
	 */
	#removeText(text: Text, parent: Element): void {
		// Text nodes are always inline-level
		this.#invalidateInlineRemoval(text);

		// Remove from the layout tree (if it has a layout node as run head)
		const flexNode = this.nodeMap.get(text);
		if (flexNode) {
			const parentFlexNode = this.nodeMap.get(parent);
			if (parentFlexNode) {
				parentFlexNode.removeChild(flexNode);
			}

			// Check if text was actually removed vs just moved
			if (!text.isConnected) {
				// Text was truly removed from DOM - free it
				this.measureNodes.delete(flexNode);
				flexNode.freeRecursive();
				this.nodeMap.delete(text);
			}
		}

		// Clear any cached break results for this text node
		this.#clearBreakResultCache(text);
	}

	/**
	 * Invalidate inline runs affected by removing an inline-level node
	 */
	#invalidateInlineRemoval(node: Node): void {
		// Note: Invalidation is now handled at the MutationRecord level using previousSibling/nextSibling
		// This method is kept for compatibility but the real work happens in #handleMutationRecords
		// Just clear any cached break results for the removed node itself
		this.#clearBreakResultCache(node);
	}

	/**
	 * Invalidate inline runs when a block element is removed (might merge previously separate runs)
	 */
	#invalidateBlockRemoval(parent: Element): void {
		// Use tree walker to find all inline children that need invalidation
		const walker = createExpandedTreeWalker(this.window, parent);
		let child = walker.firstChild();

		while (child) {
			if (this.#isInlineLevel(child)) {
				this.#invalidateInlineRun(child);
			}
			child = walker.nextSibling();
		}
	}

	#getFlexIndex(element: Element): number {
		if (!element.parentElement) {
			return 0;
		}

		// Use the same expanded tree walker as addElementNode to ensure consistency
		const walker = createExpandedTreeWalker(this.window, element.parentElement);

		let flexIndex = 0;
		let sibling = walker.firstChild();

		while (sibling && sibling !== element) {
			if (sibling.nodeType === sibling.ELEMENT_NODE) {
				const siblingElement = sibling as Element;
				const siblingDisplay = getPropertyValue(siblingElement, "display");

				if (
					(siblingDisplay === "inline" || siblingDisplay === "inline-block") &&
					!this.isInlineRunHead(siblingElement)
				) {
					// Skip inline elements that aren't run heads
				} else {
					const siblingFlexNode = this.nodeMap.get(siblingElement);
					if (siblingFlexNode) {
						flexIndex++;
					}
				}
			} else if (sibling.nodeType === sibling.TEXT_NODE) {
				// Count text nodes that will be added to layout tree
				const siblingFlexNode = this.nodeMap.get(sibling);
				if (siblingFlexNode) {
					flexIndex++;
				}
			}
			// Note: Pseudo-elements will also be counted if they have layout nodes

			sibling = walker.nextSibling();
		}

		return flexIndex;
	}

	#measureInlineRun(
		node: Node,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		height: number,
		heightMode: FlexTypes.MeasureMode,
	): {width: number; height: number} {
		const breakResult = this.#breakNodes(
			node,
			width,
			widthMode,
			height,
			heightMode,
		);

		// Store the BreakResult for later use by getRects()
		this.breakResultMap.set(node, breakResult);

		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};

		return result;
	}

	// Inline layout methods (moved from breaker.ts)
	// TODO: Many of these methods could be regular functions
	#collectLeafNodes(runHead: Node): Leaf[] {
		const leafNodes: Leaf[] = [];

		// For pseudo elements, use the host element as the parent
		const pseudoMetadata = getPseudoMetadata(runHead);
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: runHead.parentElement;

		// Inline run heads should always have a parent element
		if (!parentElement) {
			throw new Error("Inline run head must have a parent element");
		}

		// Determine the appropriate traversal root based on parent display type
		const parentDisplay = getPropertyValue(parentElement, "display");

		let traversalRoot: Node;
		if (parentDisplay === "flex" && runHead.nodeType === runHead.ELEMENT_NODE) {
			// For flex items that are elements, traverse only within that element
			traversalRoot = runHead;
		} else {
			// For all other cases, use the parent as the boundary
			traversalRoot = parentElement;
		}

		// Use ExpandedTreeWalker for traversal
		const walker = createExpandedTreeWalker(this.window, traversalRoot);

		walker.currentNode = runHead;
		while (walker.currentNode) {
			const node = walker.currentNode;

			if (node.nodeType === node.TEXT_NODE) {
				// Text node - add as leaf
				const textNode = node as Text;

				if (textNode.textContent) {
					// Check if this is a whitespace-only text node between block elements
					const isWhitespaceOnly = /^\s*$/.test(textNode.textContent);

					if (
						isWhitespaceOnly &&
						this.#shouldCollapseWhitespaceTextNode(textNode)
					) {
						// Skip this whitespace text node - it should be collapsed to nothing
						if (!walker.nextNode()) break;
						continue;
					}

					leafNodes.push({
						type: "text",
						node: textNode,
						content: textNode.textContent,
					});
				}
				// Continue with normal traversal
				if (!walker.nextNode()) break;
			} else if (node.nodeType === node.ELEMENT_NODE) {
				const element = node as Element;
				const display = getPropertyValue(element, "display");

				if (element.tagName === "BR") {
					leafNodes.push({
						type: "br",
						node: element as HTMLBRElement,
					});
					// Continue with normal traversal
					if (!walker.nextNode()) break;
				} else if (display === "inline-block") {
					// Parse CSS box model properties
					const boxModel = getBoxModel(element);

					// Calculate available content dimensions
					const horizontalBoxSpace =
						boxModel.paddingLeft +
						boxModel.paddingRight +
						boxModel.borderLeftWidth +
						boxModel.borderRightWidth;
					const verticalBoxSpace =
						boxModel.paddingTop +
						boxModel.paddingBottom +
						boxModel.borderTopWidth +
						boxModel.borderBottomWidth;

					// Determine content constraints
					let contentWidth = Number.MAX_SAFE_INTEGER;
					let contentHeight = Number.MAX_SAFE_INTEGER;
					let contentWidthMode = Flex.MEASURE_MODE_UNDEFINED;
					let contentHeightMode = Flex.MEASURE_MODE_UNDEFINED;

					if (boxModel.width !== undefined) {
						contentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
						contentWidthMode = Flex.MEASURE_MODE_EXACTLY;
					}

					if (boxModel.height !== undefined) {
						contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
						contentHeightMode = Flex.MEASURE_MODE_EXACTLY;
					}

					// Recursively measure inline-block content with constraints
					let inlineBlockResult: BreakResult | undefined;
					if (element.firstChild) {
						inlineBlockResult = this.#breakNodes(
							element.firstChild,
							contentWidth,
							contentWidthMode,
							contentHeight,
							contentHeightMode,
						);
					}

					// Calculate final content dimensions
					let finalContentWidth = inlineBlockResult?.maxLineWidth ?? 0;
					let finalContentHeight = inlineBlockResult?.totalHeight ?? 0;

					// Void elements (input, br, etc.) with no children get a minimum height of 1
					if (!element.firstChild && finalContentHeight === 0) {
						finalContentHeight = 1;
					}

					// If explicit dimensions were set, use those instead of measured content
					if (boxModel.width !== undefined) {
						finalContentWidth = Math.max(
							0,
							boxModel.width - horizontalBoxSpace,
						);
					}
					if (boxModel.height !== undefined) {
						finalContentHeight = Math.max(
							0,
							boxModel.height - verticalBoxSpace,
						);
					}

					leafNodes.push({
						type: "inline-block",
						node: element,
						breakResult: inlineBlockResult,
						boxModel,
						contentWidth: finalContentWidth,
						contentHeight: finalContentHeight,
					});
					// Skip children by going to next sibling
					if (!walker.nextSibling()) break;
				} else if (display === "inline") {
					// Inline element - traverse into its children
					if (!walker.nextNode()) break;
				} else {
					// Block element - stop traversal
					break;
				}
			} else {
				// Unknown node type - continue
				if (!walker.nextNode()) break;
			}
		}

		return leafNodes;
	}

	#breakNodes(
		runHead: Node,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		_height: number,
		_heightMode: FlexTypes.MeasureMode,
	): BreakResult {
		// Collect leaf nodes from the run head
		const leafNodes = this.#collectLeafNodes(runHead);

		// Handle empty case
		if (leafNodes.length === 0) {
			return {lines: [], totalHeight: 0, maxLineWidth: 0};
		}

		// Get CSS properties from the appropriate element
		// For pseudo elements, use the host element, otherwise use parent for text nodes
		const pseudoMetadata = getPseudoMetadata(runHead);
		const styleElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: runHead.nodeType === runHead.TEXT_NODE
				? runHead.parentElement!
				: (runHead as Element);

		// Get default CSS properties from the run head element
		const whiteSpace = getPropertyValue(styleElement, "white-space");
		const wordBreak = getPropertyValue(styleElement, "word-break");
		const overflowWrap = getPropertyValue(styleElement, "overflow-wrap");

		// An offered width of 0 is a real constraint, not "unlimited": it asks for
		// the narrowest the content can be, which is its min-content size -- the
		// longest word that cannot be broken. Treating it as unlimited returned
		// max-content instead, so min-content came back as zero everywhere and a
		// long word had nothing stopping it overflowing its box.
		const maxWidth =
			widthMode === Flex.MEASURE_MODE_UNDEFINED
				? Number.MAX_SAFE_INTEGER
				: width;

		// Process and break the content with dynamic per-element styling
		const processedContent = this.#processWhitespace(leafNodes);
		const breaks = this.#findBreakPoints(processedContent, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});
		const lines = this.#buildLines(processedContent, breaks, maxWidth);

		return {
			lines,
			totalHeight: lines.reduce((sum, line) => sum + line.height, 0),
			maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
		};
	}

	#collapseWhitespace(text: string, whiteSpace: string): string {
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
			// Preserve all whitespace exactly as-is
			return text;
		}

		if (whiteSpace === "pre-line") {
			// Preserve newlines, collapse other whitespace to single spaces
			return text
				.split("\n")
				.map((line) => line.replace(/[ \t\r\f]+/g, " "))
				.join("\n");
		}

		// For "normal" and "nowrap": collapse all whitespace sequences to single space
		// This includes spaces, tabs, newlines, etc.
		return text.replace(/\s+/g, " ");
	}

	#processWhitespace(leafNodes: Leaf[]): ProcessedContent {
		const items: ProcessedContent["items"] = [];
		let text = "";

		for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
			const leaf = leafNodes[leafIndex];
			const start = text.length;

			if (leaf.type === "text" && leaf.content) {
				// Get the white-space property for this specific leaf's parent element
				const leafWhiteSpace = leaf.node.parentElement
					? getPropertyValue(leaf.node.parentElement, "white-space")
					: "normal";

				// Process the text content according to its white-space property
				let processed = this.#collapseWhitespace(leaf.content, leafWhiteSpace);

				// Handle boundary whitespace between adjacent text nodes
				if (leafIndex > 0 && processed.length > 0) {
					const prevItem = items[items.length - 1];
					if (prevItem && prevItem.leafNode.type === "text") {
						// Check if we have adjacent spaces at the boundary
						const prevEndsWithSpace =
							text.length > 0 && text[text.length - 1] === " ";
						const thisStartsWithSpace = processed[0] === " ";

						if (prevEndsWithSpace && thisStartsWithSpace) {
							// Remove the leading space to avoid double spaces at boundaries
							processed = processed.substring(1);
						}
					}
				}

				text += processed;

				items.push({
					leafNode: leaf,
					start: start,
					end: text.length,
					processedContent: processed,
				});
			} else if (leaf.type === "br") {
				// BR elements always create a line break
				text += "\n";
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			} else if (leaf.type === "inline-block") {
				// Inline-block elements are treated as a single unit
				// Add a placeholder character for measurement
				text += "\uFFFC"; // Object replacement character
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			}
		}

		// Final cleanup: trim leading/trailing spaces from the entire run
		// But preserve them for pre text or isolated measurement scenarios
		if (text.length > 0) {
			// Check if any leaf has pre-style whitespace that should be preserved
			const hasPreWhitespace = leafNodes.some((leaf) => {
				if (leaf.type === "text" && leaf.node.parentElement) {
					const ws = getPropertyValue(leaf.node.parentElement, "white-space");
					return ws === "pre" || ws === "pre-wrap" || ws === "pre-line";
				}
				return false;
			});

			// Only trim if we don't have pre whitespace and we have multiple leaf nodes
			// For isolated text (single leaf), preserve trailing spaces for measurement
			const shouldTrim = !hasPreWhitespace && leafNodes.length > 1;

			if (shouldTrim) {
				const trimStart = text.match(/^\s*/)?.[0].length || 0;
				const trimEnd = text.match(/\s*$/)?.[0].length || 0;

				if (trimStart > 0 || trimEnd > 0) {
					// Adjust text
					text = text.trim();

					// Adjust item positions
					for (const item of items) {
						item.start = Math.max(0, item.start - trimStart);
						item.end = Math.max(0, item.end - trimStart);
					}
				}
			}
		}

		return {items, text};
	}

	#findBreakPoints(
		content: ProcessedContent,
		options: BreakOptions,
	): BreakPoint[] {
		const {whiteSpace = "normal"} = options;

		// Check if ANY leaf node has white-space: nowrap
		const hasNowrap = content.items.some((item) => {
			if (item.leafNode.type === "text" && item.leafNode.node.parentElement) {
				const leafWhiteSpace = getPropertyValue(
					item.leafNode.node.parentElement,
					"white-space",
				);
				return leafWhiteSpace === "nowrap";
			}
			return false;
		});

		// For nowrap, only allow breaking at the very end
		if (whiteSpace === "nowrap" || hasNowrap) {
			return [
				{
					position: content.text.length,
					required: false,
				},
			];
		}

		const breaker = new LineBreaker(content.text);
		const breaks: BreakPoint[] = [];

		let lastPos = 0;
		let bk;
		while ((bk = breaker.nextBreak())) {
			let required = bk.required || false;

			const {whiteSpace = "normal"} = options;
			if (
				whiteSpace === "pre" ||
				whiteSpace === "pre-wrap" ||
				whiteSpace === "pre-line"
			) {
				const segment = content.text.slice(lastPos, bk.position);
				if (segment.includes("\n")) {
					required = true;
				}
			}

			breaks.push({
				position: bk.position,
				required,
			});
			lastPos = bk.position;
		}

		return breaks;
	}

	#buildLines(
		content: ProcessedContent,
		breaks: BreakPoint[],
		maxWidth: number,
	): LineResult[] {
		const lines: LineResult[] = [];
		let currentY = 0;
		let lineStart = 0;

		while (lineStart < content.text.length) {
			let bestBreak = lineStart;
			let bestBreakWidth = 0;

			for (const breakPoint of breaks) {
				if (breakPoint.position <= lineStart) continue;

				const width = this.#measureText(
					content.text,
					content.items,
					lineStart,
					breakPoint.position,
				);

				// For nowrap (single break point at end), always use it regardless of width
				if (
					breaks.length === 1 &&
					breakPoint.position === content.text.length
				) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
					break;
				}

				if (width <= maxWidth) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
				} else {
					break;
				}

				if (breakPoint.required) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
					break;
				}
			}

			if (bestBreak === lineStart) {
				let pos = lineStart + 1;
				while (pos <= content.text.length) {
					// Check if we would break within an inline-block element
					let crossesInlineBlock = false;
					for (const item of content.items) {
						if (item.leafNode.type === "inline-block") {
							// If our position would split this inline-block, skip to its end
							if (pos > item.start && pos < item.end) {
								pos = item.end;
								crossesInlineBlock = true;
								break;
							}
						}
					}

					if (crossesInlineBlock) {
						continue; // Try again with the new position
					}

					const width = this.#measureText(
						content.text,
						content.items,
						lineStart,
						pos,
					);
					if (width > maxWidth && pos > lineStart + 1) {
						pos--;
						break;
					}
					pos++;
				}
				bestBreak = Math.min(pos, content.text.length);
				bestBreakWidth = this.#measureText(
					content.text,
					content.items,
					lineStart,
					bestBreak,
				);
			}

			const lineNodes = this.#getNodesInRange(
				content.items,
				lineStart,
				bestBreak,
			);

			if (lineNodes.length > 0) {
				const lineHeight = Math.max(
					...lineNodes.map((n) =>
						n.leaf.type === "inline-block"
							? n.leaf.contentHeight +
								n.leaf.boxModel.paddingTop +
								n.leaf.boxModel.paddingBottom +
								n.leaf.boxModel.borderTopWidth +
								n.leaf.boxModel.borderBottomWidth
							: 1,
					),
					1,
				);

				lines.push({
					segments: lineNodes,
					y: currentY,
					height: lineHeight,
					width: bestBreakWidth,
				});

				currentY += lineHeight;
			}

			lineStart = bestBreak;
		}

		return lines;
	}

	#measureText(
		text: string,
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): number {
		let width = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (item.leafNode.type === "text") {
				const portion = text.slice(itemStart, itemEnd);
				width += runtimeStringWidth(portion);
			} else if (item.leafNode.type === "inline-block") {
				// Only count inline-block width if we're measuring its full range
				if (itemStart === item.start && itemEnd === item.end) {
					const blockWidth =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
					width += blockWidth;
				} else {
					// Partial inline-block measurement not supported
				}
			}
		}

		return width;
	}

	#getNodesInRange(
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): LineResult["segments"] {
		const nodes: LineResult["segments"] = [];
		let x = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (itemStart < itemEnd) {
				let width = 0;
				if (item.leafNode.type === "text" && item.processedContent) {
					const relativeStart = itemStart - item.start;
					const relativeEnd = itemEnd - item.start;
					const portion = item.processedContent.slice(
						relativeStart,
						relativeEnd,
					);
					width = runtimeStringWidth(portion);

					nodes.push({
						leaf: item.leafNode,
						start: relativeStart,
						end: relativeEnd,
						x,
						width,
						processedText: portion,
					});
				} else if (item.leafNode.type === "inline-block") {
					width =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
					// Extract text content from the inline-block's breakResult
					let processedText = "";
					if (item.leafNode.breakResult) {
						for (const line of item.leafNode.breakResult.lines) {
							for (const segment of line.segments) {
								processedText += segment.processedText;
							}
						}
					}
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width,
						processedText,
					});
				} else if (item.leafNode.type === "br") {
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width: 0,
						processedText: "",
					});
				}

				x += width;
			}
		}

		return nodes;
	}
}

export function computeBoundingRect(
	DOMRect: typeof globalThis.DOMRect,
	rects: DOMRect[] | DOMRectList,
): DOMRect {
	const rectArray: DOMRect[] = Array.from(rects);
	if (rectArray.length === 0) {
		return new DOMRect(0, 0, 0, 0);
	}

	if (rectArray.length === 1) {
		return rectArray[0];
	}

	let minLeft = Infinity;
	let minTop = Infinity;
	let maxRight = -Infinity;
	let maxBottom = -Infinity;

	for (const rect of rectArray) {
		minLeft = Math.min(minLeft, rect.left);
		minTop = Math.min(minTop, rect.top);
		maxRight = Math.max(maxRight, rect.right);
		maxBottom = Math.max(maxBottom, rect.bottom);
	}

	return new DOMRect(minLeft, minTop, maxRight - minLeft, maxBottom - minTop);
}

export function isPointInRects(
	x: number,
	y: number,
	...rects: Array<DOMRect | DOMRect[] | DOMRectList>
): boolean {
	const allRects = rects.flat();
	return allRects.some((rect) => {
		if (Array.isArray(rect) || rect instanceof DOMRectList) {
			// Handle nested arrays/lists
			return isPointInRects(x, y, ...rect);
		}
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	});
}
