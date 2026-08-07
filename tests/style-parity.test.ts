/**
 * Inline/stylesheet parity: the same declaration must compute the same way
 * through element.style (cssstyle, jsdom's inline CSSOM) and through a
 * stylesheet (the engine's own parser and cascade). The two are different
 * code paths with a history of disagreeing in BOTH directions -- cssstyle
 * erased `border: none` (shimmed in styles.ts), the engine ignored the
 * stylesheet `flex` shorthand -- and every disagreement is a silent wrong
 * render. This sweep turns parity into an invariant: add a declaration here
 * when a new one is supported.
 */
import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM} from "../src/internal/termdom.js";

const DECLARATIONS = [
	"border: none",
	"border: hidden",
	"border: 1px solid red",
	"border-top: none",
	"border-style: none",
	"border-top-style: none",
	"background: red",
	"background: none",
	"background-color: transparent",
	"margin: 1px 2px",
	"margin: auto",
	"padding: 1px 2px",
	"display: none",
	"display: inline-block",
	"flex: 1",
	"flex: none",
	"flex: 0 1 auto",
	"flex-grow: 2",
	"gap: 1px",
	"overflow: hidden",
	"text-decoration: underline",
	"text-decoration: none",
	"font-weight: bold",
	"white-space: pre-wrap",
	"width: 50%",
	"min-height: 3px",
	"color: #5fafff",
	"outline: 1px solid #5fafff",
	"outline: none",
	"list-style: none",
	"visibility: hidden",
	"position: absolute",
	"z-index: 3",
];

const PROBE_PROPS = [
	"border-top-width",
	"border-top-style",
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
	"row-gap",
	"overflow",
	"text-decoration-line",
	"font-weight",
	"white-space",
	"width",
	"min-height",
	"color",
	"outline-style",
	"outline-width",
	"list-style-type",
	"visibility",
	"position",
	"z-index",
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
		if (!style || style === "none" || style === "hidden") return "0";
		if (value === "0px") return "0";
	}
	return value;
}

test("inline styles and stylesheets compute identically", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({process: terminal});
	const {document, window} = dom;

	const failures: string[] = [];
	for (const declaration of DECLARATIONS) {
		document.head.innerHTML = `<style>.probe { ${declaration}; }</style>`;
		document.body.innerHTML =
			`<div class="probe" id="sheet">x</div>` +
			`<div id="inline" style="${declaration}">x</div>`;
		await nextFrame(dom);
		const sheet = window.getComputedStyle(document.getElementById("sheet")!);
		const inline = window.getComputedStyle(document.getElementById("inline")!);
		for (const prop of PROBE_PROPS) {
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
