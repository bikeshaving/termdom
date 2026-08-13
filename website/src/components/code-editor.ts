import {Copy, jsx} from "@b9g/crank/standalone";
import type {Context, Element as CrankElement} from "@b9g/crank";
import {css} from "@emotion/css";
import Prism from "prismjs";
import type {Token} from "prismjs";

// Prism language components are CJS side-effect modules that reference a global
// `Prism`. In bundled ESM, the core import above only creates a local binding,
// so we need to expose it globally for language components to find.
(globalThis as unknown as {Prism: typeof Prism}).Prism = Prism;
Prism.manual = true;

import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";

import {Edit} from "@b9g/revise/edit.js";
import {Keyer} from "@b9g/revise/keyer.js";
import {EditHistory} from "@b9g/revise/history.js";
import type {
	ContentAreaElement,
	SelectionDirection,
} from "@b9g/revise/contentarea.js";

import {ContentArea} from "./contentarea.js";

const IS_CLIENT = typeof document !== "undefined";

const TAB = "  ";
// The gutter and the code share these so a line number sits on its line. The
// row height is a whole number of pixels rather than a ratio: a fractional
// line box rounds independently in each column, and the halves of a pixel per
// row add up to a number sitting above the line it belongs to.
const FONT_SIZE = "14px";
const LINE_HEIGHT = "22px";
// One padding for both, so row 1 starts at the same y in both columns.
const VERTICAL_PADDING = "1rem";

/**
 * The height of an editor showing `lines` whole lines. Sized here because the
 * row height is the editor's own: a box that ends mid-row shows a line sliced
 * through the middle, with a gutter number beside the half of it.
 *
 * One padding, not two: the box scrolls, so at the top of the document the
 * padding above line one is inside the window and the padding below the last
 * line is not.
 */
export function editorHeight(lines: number): string {
	return `calc(${lines} * ${LINE_HEIGHT} + ${VERTICAL_PADDING})`;
}

/*** Prism ***/

function wrapContent(
	content: Array<Token | string> | Token | string,
): Array<Token | string> {
	return Array.isArray(content) ? content : [content];
}

function unwrapContent(
	content: Array<Token | string>,
): Array<Token | string> | string {
	if (content.length === 0) {
		return "";
	} else if (content.length === 1 && typeof content[0] === "string") {
		return content[0];
	}

	return content;
}

/**
 * Prism tokenizes a whole document at once, but the editor renders a keyed
 * element per line, so tokens which straddle a newline -- a block comment, a
 * template literal -- are split into one token per line, each carrying its own
 * length so the keyer can map an index to a line.
 */
function splitLines(
	tokens: Array<Token | string>,
): Array<Array<Token | string>> {
	const lines = splitLinesRec(tokens);
	if (lines.length && !lines[lines.length - 1].length) {
		lines.pop();
	}

	return lines;
}

function splitLinesRec(
	tokens: Array<Token | string>,
): Array<Array<Token | string>> {
	let currentLine: Array<Token | string> = [];
	const lines: Array<Array<Token | string>> = [currentLine];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (typeof token === "string") {
			const split = token.split(/\r\n|\r|\n/);
			for (let j = 0; j < split.length; j++) {
				if (j > 0) {
					lines.push((currentLine = []));
				}

				const token1 = split[j];
				if (token1) {
					currentLine.push(token1);
				}
			}
		} else {
			const split = splitLinesRec(wrapContent(token.content));
			if (split.length > 1) {
				for (let j = 0; j < split.length; j++) {
					if (j > 0) {
						lines.push((currentLine = []));
					}

					const line = split[j];
					if (line.length) {
						const token1 = new Prism.Token(
							token.type,
							unwrapContent(line),
							token.alias,
						);
						token1.length = line.reduce((l, t) => l + t.length, 0);
						currentLine.push(token1);
					}
				}
			} else {
				currentLine.push(token);
			}
		}
	}

	return lines;
}

function tokenize(
	code: string,
	language: string,
): Array<Array<Token | string>> {
	const grammar = Prism.languages[language] || Prism.languages.javascript;
	return splitLines(Prism.tokenize(code, grammar));
}

function printTokens(
	tokens: Array<Token | string>,
): Array<CrankElement | string> {
	const result: Array<CrankElement | string> = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (typeof token === "string") {
			result.push(token);
		} else {
			const children = Array.isArray(token.content)
				? printTokens(token.content)
				: token.content;
			let className = "token " + token.type;
			if (Array.isArray(token.alias)) {
				className += " " + token.alias.join(" ");
			} else if (typeof token.alias === "string") {
				className += " " + token.alias;
			}

			result.push(jsx`<span class=${className}>${children}</span>`);
		}
	}

	return result;
}

/*** Components ***/

/**
 * Line numbers, rendered beside the code rather than inside it: the
 * content-area reads its value from the DOM, so anything in the editable
 * subtree would become part of the program.
 */
function* Gutter(this: Context<typeof Gutter>, {length}: {length: number}) {
	let initial = true;
	let newLength: number;
	const lines = Array.from({length}, (_, i) => i + 1);
	for ({length: newLength} of this) {
		if (length === newLength) {
			if (!initial) {
				yield jsx`<${Copy} />`;
				continue;
			}
		} else if (length < newLength) {
			lines.push(
				...Array.from({length: newLength - length}, (_, i) => i + length + 1),
			);
		} else {
			lines.splice(newLength);
		}

		yield jsx`
			<div
				class=${css`
					display: none;
					@media (min-width: 600px) {
						display: flex;
					}
					flex-direction: column;
					flex: none;
					margin: 0;
					padding: ${VERTICAL_PADDING} 0.6rem ${VERTICAL_PADDING} 0.9rem;
					font-size: ${FONT_SIZE};
					line-height: ${LINE_HEIGHT};
					text-align: right;
					color: var(--muted-color);
					border-right: 1px solid var(--border-color);
					user-select: none;
					position: sticky;
					left: 0;
					background-color: var(--surface-color);
				`}
			>
				${lines.map(
					(line) =>
						jsx`<div class=${css`
							height: ${LINE_HEIGHT};
						`}>${line}</div>`,
				)}
			</div>
		`;
		initial = false;
		length = newLength;
	}
}

function Line({line}: {line: Array<Token | string>}) {
	return jsx`
		<div class="prism-line">
			${line.length ? jsx`<code>${printTokens(line)}</code>` : null}
			<br />
		</div>
	`;
}

const editor = css`
	position: relative;
	display: flex;
	width: 100%;
	height: 100%;
	overflow: auto;
	background-color: var(--surface-color);
`;

/* The site styles `pre` and `code` as document furniture; inside the editor
   they are the text surface itself, so the box comes back off them. The
   theme reaches the element through `pre[class*="language-"]`, which outranks
   a class, so the class is doubled where it has to win.

   A long line runs off the side and the editor scrolls to it rather than
   wrapping: a wrapped line occupies two rows, and the gutter beside it has
   only one number to give. The scrolling is the editor box's, not the
   `pre`'s, so the gutter travels with the lines it numbers -- which is what
   the site's own `pre { overflow-x: auto }` has to give up here. */
const code = css`
	&& {
		flex: 1 1 auto;
		margin: 0;
		padding: ${VERTICAL_PADDING} 1rem;
		background: none;
		border: none;
		border-radius: 0;
		font-size: ${FONT_SIZE};
		line-height: ${LINE_HEIGHT};
		tab-size: 2;
		white-space: pre;
		overflow: visible;
		outline: none;
	}

	& code {
		background: none;
		border: none;
		border-radius: 0;
		padding: 0;
		font-size: inherit;
	}

	/* A line is exactly one row tall whatever it holds: a token span with a
	   font-size of its own would otherwise grow the line box under it and
	   walk the code out of step with the gutter. */
	& .prism-line,
	& .prism-line * {
		line-height: ${LINE_HEIGHT};
		font-size: ${FONT_SIZE};
	}

	& .prism-line {
		height: ${LINE_HEIGHT};
	}
`;

interface SelectionRange {
	selectionStart: number;
	selectionEnd: number;
	selectionDirection: SelectionDirection;
}

/**
 * A syntax-highlighted editor over revise's content-area.
 *
 * There is no hidden textarea and no mirrored copy of the text: the
 * highlighted elements *are* the editable document, and the element reports
 * what the browser did to them as an `Edit`. Every keystroke therefore takes
 * the same path -- the DOM changes, `contentchange` reports it, the component
 * re-renders the tokens, and `Keyer` keeps a stable key per line so the
 * lines the edit did not touch are left alone and the caret survives.
 */
export function* CodeEditor(
	this: Context,
	{
		value,
		language,
		editable,
		showGutter,
	}: {
		value: string;
		language: string;
		editable?: boolean;
		showGutter?: boolean;
	},
) {
	const keyer = new Keyer();
	let selectionRange: SelectionRange | undefined;
	let renderSource: string | undefined;
	let area!: ContentAreaElement;
	let scroller!: HTMLDivElement;

	{
		// Keys track the text through an edit, except for the edits this
		// component made itself, which transformed the keyer as they were made.
		let initial = true;
		this.addEventListener("contentchange", (ev: any) => {
			if (initial) {
				initial = false;
				return;
			}

			const {edit, source} = ev.detail;
			if (source !== "newline" && source !== "history") {
				keyer.transform(edit);
			}
		});
	}

	this.addEventListener("contentchange", (ev: any) => {
		if (ev.detail.source != null) {
			return;
		}

		ev.preventDefault();
		this.refresh(() => {
			value = ev.target.value;
			renderSource = "refresh";
		});
	});

	const editHistory = new EditHistory();
	{
		const undo = () => {
			const edit = editHistory.undo();
			if (edit) {
				this.refresh(() => {
					value = edit.apply(value);
					selectionRange = selectionRangeFromEdit(edit);
					keyer.transform(edit);
					renderSource = "history";
				});
				return true;
			}

			return false;
		};

		const redo = () => {
			const edit = editHistory.redo();
			if (edit) {
				this.refresh(() => {
					value = edit.apply(value);
					selectionRange = selectionRangeFromEdit(edit);
					keyer.transform(edit);
					renderSource = "history";
				});
				return true;
			}

			return false;
		};

		this.addEventListener("beforeinput", (ev: InputEvent) => {
			switch (ev.inputType) {
				case "historyUndo": {
					if (undo()) {
						ev.preventDefault();
					}

					break;
				}
				case "historyRedo": {
					if (redo()) {
						ev.preventDefault();
					}

					break;
				}
			}
		});

		// Browsers which do not report undo as a beforeinput reach it by key.
		this.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (
				ev.keyCode === 0x5a /* Z */ &&
				!ev.altKey &&
				((ev.metaKey && !ev.ctrlKey) || (!ev.metaKey && ev.ctrlKey))
			) {
				if (ev.shiftKey) {
					redo();
				} else {
					undo();
				}

				ev.preventDefault();
			} else if (
				ev.keyCode === 0x59 /* Y */ &&
				ev.ctrlKey &&
				!ev.altKey &&
				!ev.metaKey
			) {
				redo();
				ev.preventDefault();
			}
		});

		if (IS_CLIENT) {
			checkpointEditHistory(this, editHistory);
		}

		this.addEventListener("contentchange", (ev: any) => {
			const {edit, source} = ev.detail;
			if (source !== "history" && source !== null) {
				editHistory.append(edit.normalize());
			}
		});
	}

	{
		// Enter carries the previous line's indentation, and one level more
		// when that line left a bracket open.
		this.addEventListener("keydown", (ev: KeyboardEvent) => {
			const {selectionStart, selectionEnd} = area;
			if (
				ev.key !== "Enter" ||
				ev.metaKey ||
				ev.ctrlKey ||
				selectionStart !== selectionEnd
			) {
				return;
			}

			const prevLine = getPreviousLine(value, selectionStart);
			const [, spaceBefore, bracket] = prevLine.match(
				/(\s*).*?(\(|\[|{)?(?:\s*)$/,
			)!;
			let insert = "\n" + (spaceBefore || "");
			if (bracket) {
				insert += TAB;
			}

			const edit = Edit.builder(value)
				.retain(selectionStart)
				.insert(insert)
				.build();
			ev.preventDefault();
			this.refresh(() => {
				keyer.transform(edit);
				renderSource = "newline";
				value = edit.apply(value);
				selectionRange = {
					selectionStart: selectionStart + insert.length,
					selectionEnd: selectionStart + insert.length,
					selectionDirection: "none",
				};
			});
		});
	}

	let value1: string;
	for ({value: value1, language, editable = true, showGutter} of this) {
		this.schedule(() => {
			selectionRange = undefined;
			renderSource = undefined;
		});

		// A render the editor did not cause is the value being set from outside.
		if (renderSource == null) {
			value = value1;
			renderSource = "update";
		}

		// The document always ends in a newline, so the last line is a line.
		value = value.match(/(?:\r|\n|\r\n)$/) ? value : value + "\n";

		// A document handed in from outside is a document nobody has read yet,
		// so it opens at its first line rather than wherever the last one was
		// left.
		if (renderSource === "update") {
			this.after(() => {
				scroller.scrollTop = 0;
				scroller.scrollLeft = 0;
			});
		}

		const lineTokens = tokenize(value, language || "javascript");
		let index = 0;
		yield jsx`
			<div
				class=${editor}
				ref=${(el: HTMLDivElement) => (scroller = el)}
			>
				${showGutter && jsx`<${Gutter} length=${lineTokens.length} />`}
				<${ContentArea}
					ref=${(el: ContentAreaElement) => (area = el)}
					value=${value}
					renderSource=${renderSource}
					selectionRange=${selectionRange}
					class=${css`
						display: contents;
					`}
				>
					<pre
						hydrate="!contenteditable"
						autocomplete="off"
						autocorrect="off"
						autocapitalize="none"
						contenteditable=${IS_CLIENT && editable}
						spellcheck="false"
						class="language-${language} ${code}"
					>
						${lineTokens.map((line) => {
							const length =
								line.reduce((length, t) => length + t.length, 0) + "\n".length;
							try {
								return jsx`
									<${Line} key=${keyer.keyAt(index) + "line"} line=${line} />
								`;
							} finally {
								index += length;
							}
						})}
					</pre>
				<//ContentArea>
			</div>
		`;
	}
}

function getPreviousLine(text: string, index: number) {
	index = Math.max(0, index);
	for (let i = index - 1; i >= 0; i--) {
		if (text[i] === "\n" || text[i] === "\r") {
			return text.slice(i + 1, index);
		}
	}

	return text.slice(0, index);
}

/**
 * Undo granularity: a run of typing is one history entry, and the entry ends
 * where the caret moves on its own or the editor loses focus.
 */
async function checkpointEditHistory(ctx: Context, editHistory: EditHistory) {
	const contentArea = (
		(await new Promise((resolve) => ctx.schedule(resolve))) as any
	).querySelector("content-area");
	let oldSelectionRange: SelectionRange | undefined;
	ctx.addEventListener("contentchange", () => {
		oldSelectionRange = {
			selectionStart: contentArea.selectionStart,
			selectionEnd: contentArea.selectionEnd,
			selectionDirection: contentArea.selectionDirection,
		};
	});

	const onselectionchange = () => {
		const newSelectionRange = {
			selectionStart: contentArea.selectionStart,
			selectionEnd: contentArea.selectionEnd,
			selectionDirection: contentArea.selectionDirection,
		};
		if (
			oldSelectionRange &&
			(oldSelectionRange.selectionStart !== newSelectionRange.selectionStart ||
				oldSelectionRange.selectionEnd !== newSelectionRange.selectionEnd ||
				oldSelectionRange.selectionDirection !==
					newSelectionRange.selectionDirection)
		) {
			editHistory.checkpoint();
		}

		oldSelectionRange = newSelectionRange;
	};

	const onblur = () => {
		editHistory.checkpoint();
	};

	document.addEventListener("selectionchange", onselectionchange);
	contentArea.addEventListener("blur", onblur);
	ctx.cleanup(() => {
		document.removeEventListener("selectionchange", onselectionchange);
		contentArea.removeEventListener("blur", onblur);
	});
}

/** Where an undone or redone edit leaves the caret. */
function selectionRangeFromEdit(edit: Edit): SelectionRange | undefined {
	let index = 0;
	let start: number | undefined;
	let end: number | undefined;
	for (const op of edit.operations()) {
		switch (op.type) {
			case "delete": {
				if (start === undefined) {
					start = index;
				}

				break;
			}

			case "insert": {
				if (start === undefined) {
					start = index;
				}

				index += op.value.length;
				end = index;
				break;
			}

			case "retain": {
				index += op.end - op.start;
				break;
			}
		}
	}

	if (start !== undefined && end !== undefined) {
		return {
			selectionStart: start,
			selectionEnd: end,
			selectionDirection: "forward",
		};
	} else if (start !== undefined) {
		return {
			selectionStart: start,
			selectionEnd: start,
			selectionDirection: "none",
		};
	}

	return undefined;
}
