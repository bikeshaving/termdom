import {expect, test} from "@b9g/libuild/test";

import {
	getPseudoHost,
	getPseudoName,
	pseudoElement,
} from "../src/internal/dom.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("CSS specificity calculation", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Add CSS with different specificities
	const style = document.createElement("style");
	style.textContent = `
    div { color: red; }                    /* 000-000-001 */
    .class { color: green; }               /* 000-001-000 */
    .class.other { color: blue; }          /* 000-002-000 */
    #id { color: purple; }                 /* 001-000-000 */
    #id.class { color: orange; }           /* 001-001-000 */
    div.class { color: yellow; }           /* 000-001-001 */
  `;
	document.head.appendChild(style);

	await nextFrame(termdom);

	// Specificity is verified through the cascade -- the most specific matching
	// rule wins in getComputedStyle -- rather than by reading the parser's table.
	const colorOf = (className: string, id: string): string => {
		const el = document.createElement("div");
		if (className) {
			el.className = className;
		}
		if (id) {
			el.id = id;
		}
		document.body.appendChild(el);
		return termdom.window.getComputedStyle(el).getPropertyValue("color");
	};

	expect(colorOf("", "")).toBe("rgb(255, 0, 0)"); // div (000-000-001)
	expect(colorOf("class", "")).toBe("rgb(255, 255, 0)"); // div.class (000-001-001) beats .class
	expect(colorOf("class other", "")).toBe("rgb(0, 0, 255)"); // .class.other (000-002-000)
	expect(colorOf("", "id")).toBe("rgb(128, 0, 128)"); // #id (001-000-000)
	expect(colorOf("class", "id")).toBe("rgb(255, 165, 0)"); // #id.class (001-001-000)

	termdom.dispose();
});

test("@namespace qualifies the type selectors a sheet writes", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;
	const SVG = "http://www.w3.org/2000/svg";

	const style = document.createElement("style");
	style.textContent = `
    @namespace svg url(${SVG});
    svg|circle { color: red; }
    |circle { color: blue; }
    *|rect { color: green; }
    nope|rect { color: purple; }
  `;
	document.head.appendChild(style);
	const circle = document.createElementNS(SVG, "circle");
	const rect = document.createElementNS(SVG, "rect");
	document.body.append(circle, rect);
	await nextFrame(termdom);

	const colorOf = (el: Element): string =>
		termdom.window.getComputedStyle(el).getPropertyValue("color");
	expect(colorOf(circle)).toBe("rgb(255, 0, 0)");
	expect(colorOf(rect)).toBe("rgb(0, 128, 0)");

	termdom.dispose();
});

test("a default @namespace keeps a typeless compound off other namespaces", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    @namespace url(http://www.w3.org/2000/svg);
    .x { color: red; }
  `;
	document.head.appendChild(style);
	const div = document.createElement("div");
	div.className = "x";
	document.body.appendChild(div);
	await nextFrame(termdom);

	expect(
		termdom.window.getComputedStyle(div).getPropertyValue("color"),
	).not.toBe(
		"rgb(255, 0, 0)",
	);

	termdom.dispose();
});

test("selector-list pseudo-classes weigh their most specific argument", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	// Each pair states the argument-weighted rule FIRST, so source order can
	// only produce the second colour: the first wins on weight or not at all.
	style.textContent = `
		.is-target:is(#nothing, .other) { color: red; }
		.is-target.a.b { color: blue; }

		.where-target:where(#nothing) { color: red; }
		.where-target.a { color: blue; }

		.not-target:not(#nothing) { color: red; }
		.not-target.a.b { color: blue; }

		.has-target:has(#child) { color: red; }
		.has-target.a.b { color: blue; }
	`;
	document.head.appendChild(style);
	await nextFrame(termdom);

	const host = document.createElement("div");
	host.innerHTML =
		"<div class=\"is-target other a b\"></div>" +
		"<div class=\"where-target a\"></div>" +
		"<div class=\"not-target a b\"></div>" +
		"<div class=\"has-target a b\"><span id=\"child\"></span></div>";
	document.body.appendChild(host);

	const colorOf = (selector: string): string =>
		termdom.window
			.getComputedStyle(document.querySelector(selector)!)
			.getPropertyValue("color");

	// :is() carries its #nothing branch: 001-001-000 beats 000-003-000.
	expect(colorOf(".is-target")).toBe("rgb(255, 0, 0)");
	// :where() carries nothing: 000-001-000 loses to 000-002-000.
	expect(colorOf(".where-target")).toBe("rgb(0, 0, 255)");
	// :not(#nothing) is an id's worth of weight.
	expect(colorOf(".not-target")).toBe("rgb(255, 0, 0)");
	// So is the id inside :has().
	expect(colorOf(".has-target")).toBe("rgb(255, 0, 0)");

	termdom.dispose();
});

test("the CSS 2 pseudo-element spelling weighs as an element", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		div:before { content: "x"; color: red; }
		.legacy::before { content: "x"; color: blue; }
	`;
	document.head.appendChild(style);
	await nextFrame(termdom);

	const element = document.createElement("div");
	element.className = "legacy";
	document.body.appendChild(element);

	// `div:before` is 000-000-002 and `.legacy::before` 000-001-001.
	expect(
		termdom.window
			.getComputedStyle(element, "::before")
			.getPropertyValue("color"),
	).toBe("rgb(0, 0, 255)");

	termdom.dispose();
});

test("attribute values do not affect selector specificity", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		[data-reference="#root .marker :focus div::before"] { color: red; }
		.target { color: blue; }
	`;
	document.head.appendChild(style);

	await nextFrame(termdom);

	const element = document.createElement("div");
	element.className = "target";
	element.setAttribute("data-reference", "#root .marker :focus div::before");
	document.body.appendChild(element);

	const computedStyle = termdom.window.getComputedStyle(element);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	termdom.dispose();
});

test("CSS cascade resolution", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Test cascade: inline > CSS rules by specificity > defaults
	const style = document.createElement("style");
	style.textContent = `
    div { color: red; }
    .high-specificity { color: green; }
    #very-high { color: blue; }
  `;
	document.head.appendChild(style);

	await nextFrame(termdom);

	// Test element with multiple applicable rules
	const div = document.createElement("div");
	div.className = "high-specificity";
	div.id = "very-high";
	document.body.appendChild(div);

	// Should resolve to blue (highest specificity: ID)
	let computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	// Inline style should override everything
	div.style.color = "yellow";
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(255, 255, 0)");
});

test("Pseudo-element CSS support", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    .test::before {
      content: "Before: ";
      color: blue;
    }
    .test::after {
      content: " :After";
      color: green;
    }
    li::marker {
      color: purple;
    }
  `;
	document.head.appendChild(style);

	await nextFrame(termdom);

	const div = document.createElement("div");
	div.className = "test";
	document.body.appendChild(div);

	// Test pseudo-element computed styles
	const beforeStyle = termdom.window.getComputedStyle(div, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"Before: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	const afterStyle = termdom.window.getComputedStyle(div, "::after");
	expect(afterStyle.getPropertyValue("content")).toBe('" :After"');
	expect(afterStyle.getPropertyValue("color")).toBe("rgb(0, 128, 0)");

	// Test list marker
	const li = document.createElement("li");
	document.body.appendChild(li);

	const markerStyle = termdom.window.getComputedStyle(li, "::marker");
	expect(markerStyle.getPropertyValue("color")).toBe("rgb(128, 0, 128)");
});

test("Pseudo-element specificity", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    div::before { content: "div"; color: red; }        /* 000-000-002 */
    .class::before { content: "class"; color: green; } /* 000-001-001 */
    #id::before { content: "id"; color: blue; }        /* 001-000-001 */
  `;
	document.head.appendChild(style);

	await nextFrame(termdom);

	const div = document.createElement("div");
	div.className = "class";
	div.id = "id";
	document.body.appendChild(div);

	// Should resolve to blue (ID has highest specificity)
	const beforeStyle = termdom.window.getComputedStyle(div, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"id"');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	termdom.dispose();
});

test("Cascade auto-refresh on DOM changes", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const div = document.createElement("div");
	div.className = "test";
	document.body.appendChild(div);

	// Initially no styles
	let computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 0)"); // default

	// Add stylesheet dynamically
	const style = document.createElement("style");
	style.textContent = ".test { color: red; }";
	document.head.appendChild(style);

	await nextFrame(termdom);

	// Should automatically pick up new styles
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(255, 0, 0)");

	// Modify stylesheet content
	style.textContent = ".test { color: blue; }";

	await nextFrame(termdom);

	// Should pick up modified styles
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
});

test("pseudo-element nodes follow the rules that reach their hosts", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;
	const style = document.createElement("style");
	style.textContent = `
    .test::before { content: "Hello World"; }
    .empty::before { content: none; }
    .normal::before { content: normal; }
  `;
	document.head.appendChild(style);
	document.body.innerHTML =
		"<div class=\"test\"></div><div class=\"empty\"></div>" +
		"<div class=\"normal\"></div>";
	await nextFrame(termdom);

	const [testDiv, emptyDiv, normalDiv] = Array.from(document.body.children);
	const pseudoNode = pseudoElement<Element>(testDiv, "::before");
	expect(pseudoNode).not.toBeNull();
	expect(pseudoNode!.textContent).toBe("Hello World");
	expect(getPseudoName(pseudoNode!)).toBe("::before");
	expect(getPseudoHost(pseudoNode!)).toBe(testDiv);
	expect(pseudoElement(emptyDiv, "::before")).toBeNull();
	expect(pseudoElement(normalDiv, "::before")).toBeNull();
	termdom.dispose();
});
