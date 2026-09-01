/**
 * Inline/stylesheet parity: the same declaration must compute the same way
 * through element.style and through a stylesheet. The two reach the cascade
 * by different routes -- an attribute the inline CSSOM parses, a rule the
 * stylesheet parser does -- and every disagreement is a silent wrong render.
 * This sweep turns parity into an invariant: add a declaration here when a
 * new one is supported.
 */
import {expect, test} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM} from "../src/internal/termdom.js";

const DECLARATIONS = [
	"border: none",
	"border: hidden",
	"border: 1px solid red",
	"border: 2px dashed #5fafff",
	"border: solid",
	"border-top: none",
	"border-top: 1px solid",
	"border-style: none",
	"border-style: dotted",
	"border-top-style: none",
	"border-width: 2px",
	"border-color: red",
	"background: red",
	"background: none",
	"background-color: transparent",
	"margin: 1px 2px",
	"margin: 1px 2px 3px 4px",
	"margin: auto",
	"margin-left: auto",
	"margin-top: -1px",
	"padding: 1px 2px",
	"padding: 0",
	"display: none",
	"display: inline-block",
	"display: flex",
	"display: table",
	"flex: 1",
	"flex: none",
	"flex: 0 1 auto",
	"flex: 2 0 10ch",
	"flex-grow: 2",
	"flex-direction: column",
	"flex-wrap: wrap",
	"align-items: center",
	"align-self: flex-end",
	"justify-content: space-between",
	"order: 2",
	"gap: 1px",
	"gap: 1px 2px",
	"overflow: hidden",
	"overflow: auto",
	"overflow-x: hidden",
	"text-decoration: underline",
	"text-decoration: none",
	"text-decoration: underline line-through",
	"text-align: center",
	"text-transform: uppercase",
	"font-weight: bold",
	"font-style: italic",
	"white-space: pre-wrap",
	"white-space: nowrap",
	"word-break: break-all",
	"overflow-wrap: break-word",
	"width: 50%",
	"width: 10ch",
	"height: 3px",
	"max-width: 10ch",
	"min-width: 5ch",
	"min-height: 3px",
	"color: #5fafff",
	"color: rgb(95, 175, 255)",
	"outline: 1px solid #5fafff",
	"outline: none",
	"outline-offset: 1px",
	"list-style: none",
	"list-style: square inside",
	"list-style-type: circle",
	"list-style-position: inside",
	"visibility: hidden",
	"position: absolute",
	"position: relative",
	"top: 1px",
	"inset: 1px 2px",
	"z-index: 3",
	"opacity: 0.5",
	"vertical-align: top",
];

const PROBE_PROPS = [
	"border-top-width",
	"border-top-style",
	"border-top-color",
	"border-left-width",
	"border-left-style",
	"background-color",
	"margin-top",
	"margin-left",
	"margin-bottom",
	"padding-top",
	"padding-left",
	"display",
	"flex-grow",
	"flex-shrink",
	"flex-basis",
	"flex-direction",
	"flex-wrap",
	"align-items",
	"align-self",
	"justify-content",
	"order",
	"row-gap",
	"column-gap",
	"overflow",
	"overflow-x",
	"overflow-y",
	"text-decoration-line",
	"text-align",
	"text-transform",
	"font-weight",
	"font-style",
	"white-space",
	"word-break",
	"overflow-wrap",
	"width",
	"height",
	"max-width",
	"min-width",
	"min-height",
	"color",
	"outline-style",
	"outline-width",
	"outline-offset",
	"list-style-type",
	"list-style-position",
	"visibility",
	"position",
	"top",
	"left",
	"z-index",
	"opacity",
	"vertical-align",
];

/**
 * The USED border width is 0 whenever the side's style is none/hidden; the
 * DECLARED serialization legitimately differs (`medium` vs `0px`). Compare
 * used values for widths.
 */
function normalize(
	prop: string,
	value: string,
	styles: CSSStyleDeclaration,
): string {
	const match = prop.match(/^border-(top|right|bottom|left)-width$/);
	if (match) {
		const style = styles.getPropertyValue(`border-${match[1]}-style`);
		if (!style || style === "none" || style === "hidden") {
			return "0";
		}
		if (value === "0px") {
			return "0";
		}
	}
	return value;
}

test("inline styles and stylesheets compute identically", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document, window} = dom;

	/** Properties whose resolved value is the used one, and so the box's place. */
	const POSITION_DEPENDENT = new Set([
		"margin-top",
		"margin-right",
		"margin-bottom",
		"margin-left",
	]);
	const failures: string[] = [];
	for (const declaration of DECLARATIONS) {
		document.head.innerHTML = `<style>.probe { ${declaration}; }</style>`;
		document.body.innerHTML =
			"<div class=\"probe\" id=\"sheet\">x</div>" +
			`<div id="inline" style="${declaration}">x</div>`;
		await nextFrame(dom);
		const sheet = window.getComputedStyle(document.getElementById("sheet")!);
		const inline = window.getComputedStyle(document.getElementById("inline")!);
		for (const prop of PROBE_PROPS) {
			// The two probes sit at different places in the document, so a
			// resolved-value property (the used length, not the declared one)
			// legitimately differs between them. This test is about the
			// declaration's spelling, not the box's position.
			if (POSITION_DEPENDENT.has(prop)) {
				continue;
			}
			const a = normalize(prop, sheet.getPropertyValue(prop), sheet);
			const b = normalize(prop, inline.getPropertyValue(prop), inline);
			if (a !== b) {
				failures.push(
					`${declaration} -> ${prop}: sheet=${JSON.stringify(a)} inline=${JSON.stringify(b)}`,
				);
			}
		}
	}
	expect(failures).toEqual([]);
	dom.dispose();
});
