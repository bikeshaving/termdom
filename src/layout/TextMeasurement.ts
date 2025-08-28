/**
 * Text Measurement - Yoga measurement functions for inline text elements
 *
 * Implements text wrapping and measurement for elements with display: 'inline'
 * using Yoga's measurement API for proper text flow.
 */

import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";

export interface TextMeasureResult {
	width: number;
	height: number;
}

/**
 * Text measurement utilities for Yoga measurement functions
 */
export class TextMeasurement {
	/**
	 * Measure text content for a given width constraint
	 * This is the core measurement function called by Yoga
	 */
	static measureText(
		element: Element,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		height: number,
		heightMode: YogaTypes.MeasureMode,
	): TextMeasureResult {
		// Get all text content including inline children
		const content = this.getFullTextContent(element);
		if (!content) {
			return {width: 0, height: 0};
		}

		const wordWrap = (element as any).style?.wordWrap || "normal";
		const whiteSpace = (element as any).style?.whiteSpace || "normal";

		// Handle no-wrap cases
		if (
			wordWrap === "nowrap" ||
			whiteSpace === "nowrap" ||
			whiteSpace === "pre"
		) {
			const textWidth = this.getTextWidth(content);
			if (widthMode === 1) {
				// EXACTLY mode
				return {width: width, height: 1}; // Use exact width given by Yoga
			}
			return {width: textWidth, height: 1};
		}

		// Calculate natural text size
		const lines = content.split("\n");
		const naturalWidth = Math.max(
			...lines.map((line: string) => this.getTextWidth(line)),
		);

		if (widthMode === 0) {
			// UNDEFINED mode - return max-content size
			return {width: naturalWidth, height: lines.length};
		} else if (widthMode === 1) {
			// EXACTLY mode - must use exact width
			// Yoga is allocating exactly this width - use it all
			const wrappedLines = this.wrapText(content, width, {
				wordWrap,
				whiteSpace,
			});
			return {
				width: width, // Use the exact width Yoga allocated
				height: wrappedLines.length,
			};
		} else {
			// AT_MOST mode - fit-content sizing
			if (naturalWidth <= width) {
				// Natural size fits within constraint
				return {width: naturalWidth, height: lines.length};
			} else {
				// Need to wrap text within constraint
				const wrappedLines = this.wrapText(content, width, {
					wordWrap,
					whiteSpace,
				});
				return {
					width: width, // Use full constraint width when wrapping
					height: wrappedLines.length,
				};
			}
		}
	}

	/**
	 * Get full text content including inline children
	 */
	private static getFullTextContent(element: Element): string {
		// Check if this is a flex column - if so, measure children separately
		const computedStyle =
			element.ownerDocument!.defaultView!.getComputedStyle(element);
		const flexDirection = computedStyle.getPropertyValue("flex-direction");
		const isColumn =
			flexDirection === "column" || flexDirection === "column-reverse";

		// Collect text from direct text nodes and inline children
		const textParts: string[] = [];

		for (const node of element.childNodes) {
			if (node.nodeType === node.TEXT_NODE) {
				const text = node.textContent || "";
				if (text.trim()) {
					textParts.push(text);
				}
			} else if (node.nodeType === node.ELEMENT_NODE) {
				const child = node as Element;
				const childStyle =
					child.ownerDocument!.defaultView!.getComputedStyle(child);
				const display = childStyle.display;

				// Include inline and inline-block children
				if (
					display === "inline" ||
					display === "inline-block" ||
					display === ""
				) {
					const childText = child.textContent || "";
					if (childText.trim()) {
						textParts.push(childText);
					}
				}
			}
		}

		// For column layouts, join with newlines to force separate lines
		// For row layouts, join with spaces
		return isColumn ? textParts.join("\n") : textParts.join(" ");
	}

	/**
	 * Wrap text to fit within maxWidth
	 */
	private static wrapText(
		content: string,
		maxWidth: number,
		style: any,
	): string[] {
		if (maxWidth <= 0) return [""];

		const lines = content.split("\n");
		const wrappedLines: string[] = [];

		for (const line of lines) {
			if (this.getTextWidth(line) <= maxWidth) {
				wrappedLines.push(line);
			} else {
				wrappedLines.push(...this.wrapLine(line, maxWidth, style));
			}
		}

		return wrappedLines.length > 0 ? wrappedLines : [""];
	}

	/**
	 * Wrap a single line to fit within maxWidth
	 */
	private static wrapLine(
		line: string,
		maxWidth: number,
		style: any,
	): string[] {
		const wordWrap = style.wordWrap || "normal";

		if (wordWrap === "break-word") {
			return this.wrapLineBreakWord(line, maxWidth);
		}

		// Default word wrapping (break at word boundaries)
		return this.wrapLineNormal(line, maxWidth);
	}

	/**
	 * Normal word wrapping - break at word boundaries
	 */
	private static wrapLineNormal(line: string, maxWidth: number): string[] {
		const words = line.split(" ");
		const wrappedLines: string[] = [];
		let currentLine = "";

		for (const word of words) {
			const testLine = currentLine + (currentLine ? " " : "") + word;

			if (this.getTextWidth(testLine) <= maxWidth) {
				currentLine = testLine;
			} else {
				if (currentLine) {
					wrappedLines.push(currentLine);
					currentLine = word;
				} else {
					// Word is longer than maxWidth, break it
					wrappedLines.push(...this.breakLongWord(word, maxWidth));
				}
			}
		}

		if (currentLine) {
			wrappedLines.push(currentLine);
		}

		return wrappedLines.length > 0 ? wrappedLines : [""];
	}

	/**
	 * Break-word wrapping - break anywhere if needed
	 */
	private static wrapLineBreakWord(line: string, maxWidth: number): string[] {
		const chars = [...line]; // Handle Unicode properly
		const wrappedLines: string[] = [];
		let currentLine = "";

		for (const char of chars) {
			if (this.getTextWidth(currentLine + char) <= maxWidth) {
				currentLine += char;
			} else {
				if (currentLine) wrappedLines.push(currentLine);
				currentLine = char;
			}
		}

		if (currentLine) wrappedLines.push(currentLine);
		return wrappedLines.length > 0 ? wrappedLines : [""];
	}

	/**
	 * Break a word that's longer than maxWidth
	 */
	private static breakLongWord(word: string, maxWidth: number): string[] {
		const chars = [...word]; // Handle Unicode properly
		const lines: string[] = [];
		let currentLine = "";

		for (const char of chars) {
			if (this.getTextWidth(currentLine + char) <= maxWidth) {
				currentLine += char;
			} else {
				if (currentLine) lines.push(currentLine);
				currentLine = char;
			}
		}

		if (currentLine) lines.push(currentLine);
		return lines.length > 0 ? lines : [""];
	}

	/**
	 * Get visual width of text using Bun's stringWidth
	 */
	private static getTextWidth(text: string): number {
		return Bun.stringWidth(text);
	}

	/**
	 * Create a Yoga measurement function for an element
	 */
	static createMeasureFunction(element: Element): YogaTypes.MeasureFunction {
		return (
			width: number,
			widthMode: YogaTypes.MeasureMode,
			height: number,
			heightMode: YogaTypes.MeasureMode,
		): {width: number; height: number} => {
			return this.measureText(element, width, widthMode, height, heightMode);
		};
	}
}
