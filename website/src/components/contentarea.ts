import {jsx} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank";
import type {
	ContentAreaElement,
	ContentEvent,
	SelectionDirection,
} from "@b9g/revise/contentarea.js";

interface SelectionRange {
	selectionStart: number;
	selectionEnd: number;
	selectionDirection: SelectionDirection;
}

/**
 * A Crank wrapper around revise's `content-area` custom element.
 *
 * The element observes its own subtree and reports edits as `contentchange`;
 * this component's job is the other direction -- after a render it tells the
 * element what caused the change and puts the selection back where the edit
 * left it. Both have to happen synchronously after the DOM is patched, hence
 * `this.after`.
 */
export function* ContentArea(
	this: Context,
	{
		ref,
		value,
		children,
		selectionRange,
		renderSource,
		...rest
	}: {
		ref?: (el: ContentAreaElement) => void;
		children: unknown;
		selectionRange?: SelectionRange | undefined;
		value?: string | undefined;
		renderSource?: string | undefined;
	} & Record<string, any>,
) {
	let initial = true;
	let contentArea!: ContentAreaElement;
	for ({ref, value, children, selectionRange, renderSource, ...rest} of this) {
		// A render that does not carry a selection keeps the one on screen.
		selectionRange =
			selectionRange ||
			(contentArea && {
				selectionStart: contentArea.selectionStart,
				selectionEnd: contentArea.selectionEnd,
				selectionDirection: contentArea.selectionDirection,
			});

		if (!initial) {
			this.after(() => {
				if (typeof renderSource === "string") {
					contentArea.source(renderSource);
				}

				if (typeof value === "string" && value !== contentArea.value) {
					console.error(
						`Expected value ${JSON.stringify(
							value,
						)} but received ${JSON.stringify(contentArea.value)} from the DOM`,
					);
				}

				if (contentArea.contains(document.activeElement) && selectionRange) {
					contentArea.setSelectionRange(
						Math.min(
							contentArea.value.length - 1,
							selectionRange.selectionStart,
						),
						Math.min(contentArea.value.length - 1, selectionRange.selectionEnd),
						selectionRange.selectionDirection,
					);
				}

				// Typing near an edge should follow the caret, but a re-tokenize
				// that did not move the caret should leave the scroll alone.
				const selection = document.getSelection();
				if (
					selection &&
					renderSource !== "refresh" &&
					contentArea.contains(document.activeElement) &&
					contentArea.contains(selection.focusNode)
				) {
					let focusNode = selection.focusNode! as Element;
					if (focusNode && focusNode.nodeType === Node.TEXT_NODE) {
						focusNode = focusNode.parentNode as Element;
					}

					const rect = focusNode.getBoundingClientRect();
					if (rect.top < 0 || rect.bottom > window.innerHeight) {
						focusNode.scrollIntoView({block: "nearest"});
					}
				}
			});
		}

		yield jsx`
			<content-area
				ref=${(el: ContentAreaElement) => {
					contentArea = el;
					ref?.(el);
				}}
				...${rest}
			>${children}</content-area>
		`;

		initial = false;
	}
}

declare global {
	module Crank {
		interface EventMap {
			contentchange: ContentEvent;
		}
	}
}
