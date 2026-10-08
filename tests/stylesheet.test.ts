import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {
	getPseudoHost,
	getPseudoName,
	pseudoElement,
} from "../src/internal/dom.ts";
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
	const getColor = (className: string, id: string): string => {
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

	expect(getColor("", "")).toBe("rgb(255, 0, 0)"); // div (000-000-001)
	expect(getColor("class", "")).toBe("rgb(255, 255, 0)"); // div.class (000-001-001) beats .class
	expect(getColor("class other", "")).toBe("rgb(0, 0, 255)"); // .class.other (000-002-000)
	expect(getColor("", "id")).toBe("rgb(128, 0, 128)"); // #id (001-000-000)
	expect(getColor("class", "id")).toBe("rgb(255, 165, 0)"); // #id.class (001-001-000)

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

	const getColor = (el: Element): string =>
		termdom.window.getComputedStyle(el).getPropertyValue("color");
	expect(getColor(circle)).toBe("rgb(255, 0, 0)");
	expect(getColor(rect)).toBe("rgb(0, 128, 0)");

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
	).not.toBe("rgb(255, 0, 0)");

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

	const getColor = (selector: string): string => termdom.window
		.getComputedStyle(document.querySelector(selector)!)
		.getPropertyValue("color");

	// :is() carries its #nothing branch: 001-001-000 beats 000-003-000.
	expect(getColor(".is-target")).toBe("rgb(255, 0, 0)");
	// :where() carries nothing: 000-001-000 loses to 000-002-000.
	expect(getColor(".where-target")).toBe("rgb(0, 0, 255)");
	// :not(#nothing) is an id's worth of weight.
	expect(getColor(".not-target")).toBe("rgb(255, 0, 0)");
	// So is the id inside :has().
	expect(getColor(".has-target")).toBe("rgb(255, 0, 0)");

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

// Filling in a sheet's rules is the sheet being built, not changed. Told
// per rule, a shadow root's sheets each re-ran the root's restyle, which
// parsed the others, and a newsletter's eleven <style> blocks took
// several times what they take in the document.
test("a shadow root's style blocks cost about what the document's do", () => {
	const rules = Array.from(
		{length: 150},
		(_, i) =>
			`.c${i} a { color: #${(i * 4567 % 0xffffff).toString(16).padStart(6, "0")}; }`,
	);
	const blocks = Array.from({length: 15}, (_, block) =>
		`<style>${rules.filter((_, i) => i % 15 === block).join("\n")}</style>`);
	const body = Array.from({length: 150}, (_, i) =>
		`<p class="c${i}"><a href="#">l</a> <span style="color: red">s</span></p>`);
	const time = (shadow: boolean): number => {
		const dom = new TermDOM({
			transport: new MockProcess({cols: 100, rows: 20}).transport,
		});
		dom.document.body.innerHTML = "<div id=\"host\"></div>";
		const host = dom.document.getElementById("host")!;
		const root = shadow ? host.attachShadow({mode: "open"}) : host;
		const mail = new dom.window.DOMParser().parseFromString(
			`<head>${blocks.join("")}</head><body>${body.join("")}</body>`,
			"text/html",
		);
		const start = performance.now();
		root.append(
			...[...mail.head.querySelectorAll("style"), ...mail.body.childNodes]
				.map((node) => dom.document.adoptNode(node)),
		);
		host.getBoundingClientRect();
		const elapsed = performance.now() - start;
		dom.dispose();
		return elapsed;
	};
	time(false);
	time(true);
	expect(time(true)).toBeLessThan(3 * time(false));
});

test("a shadow root's sibling selectors restyle nothing outside it, attached or removed", () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 100, rows: 20}).transport,
	});
	const {document} = dom;
	document.body.innerHTML = Array.from(
		{length: 2000},
		(_, i) => `<div class="row"><span>${i}</span><span>${i}</span></div>`,
	).join("");
	const rows = document.querySelectorAll(".row");
	let at = 0;
	const moves = (): number => {
		const times: number[] = [];
		for (let i = 0; i < 15; i++) {
			rows[at].classList.remove("selected");
			rows[++at].classList.add("selected");
			const start = performance.now();
			rows[at].getBoundingClientRect();
			times.push(performance.now() - start);
		}
		return times.sort((a, b) => a - b)[7];
	};
	moves();
	const before = moves();
	const host = document.createElement("div");
	document.body.append(host);
	host.attachShadow({mode: "open"}).innerHTML =
		"<style>* + * { color: red; } div + div { color: blue; }</style><p>a</p><p>b</p>";
	host.getBoundingClientRect();
	const attached = moves();
	host.remove();
	host.getBoundingClientRect();
	const removed = moves();
	// A shadow root's sibling selectors must not slow the document's rows.
	// The margin leaves room for a loaded machine.
	expect(attached).toBeLessThan(10 * Math.max(before, 0.05));
	expect(removed).toBeLessThan(10 * Math.max(before, 0.05));
	dom.dispose();
});

test("a class change no sibling selector names costs the same in a long list", () => {
	const median = (count: number): number => {
		const dom = new TermDOM({
			transport: new MockProcess({cols: 100, rows: 20}).transport,
		});
		const {document} = dom;
		document.body.innerHTML = Array.from(
			{length: count},
			(_, i) => `<div class="row"><span>${i}</span></div>`,
		).join("");
		const rows = document.querySelectorAll(".row");
		const times: number[] = [];
		for (let i = 0; i < 41; i++) {
			rows[i].classList.remove("selected");
			rows[i + 1].classList.add("selected");
			const start = performance.now();
			rows[i + 1].getBoundingClientRect();
			times.push(performance.now() - start);
		}
		dom.dispose();
		return times.sort((a, b) => a - b)[20];
	};
	median(100);
	const short = median(100);
	const long = median(3000);
	// A change must not walk every later row, so a 3000-row list costs
	// about what a 100-row one does.
	expect(long).toBeLessThan(4 * Math.max(short, 0.05));
});

test("a class a sibling selector names restyles the siblings after it", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = dom;
	document.body.innerHTML =
		"<style>.on ~ .light { color: rgb(0, 0, 255); }</style>" +
		"<p id=switch>s</p><p>x</p><p id=light class=light>l</p>";
	const light = document.getElementById("light")!;
	expect(window.getComputedStyle(light).color).not.toBe("rgb(0, 0, 255)");
	document.getElementById("switch")!.classList.add("unrelated");
	expect(window.getComputedStyle(light).color).not.toBe("rgb(0, 0, 255)");
	document.getElementById("switch")!.classList.add("on");
	expect(window.getComputedStyle(light).color).toBe("rgb(0, 0, 255)");
	document.getElementById("switch")!.classList.remove("on");
	expect(window.getComputedStyle(light).color).not.toBe("rgb(0, 0, 255)");
	document.body.innerHTML =
		"<style>[data-on] ~ .light { color: rgb(0, 128, 0); }" +
		"#on ~ .light { background-color: rgb(1, 2, 3); }</style>" +
		"<p id=switch>s</p><p id=light class=light>l</p>";
	const next = document.getElementById("light")!;
	const toggle = document.getElementById("switch")!;
	toggle.setAttribute("data-on", "");
	expect(window.getComputedStyle(next).color).toBe("rgb(0, 128, 0)");
	toggle.id = "on";
	expect(window.getComputedStyle(next).backgroundColor).toBe("rgb(1, 2, 3)");
	toggle.id = "off";
	expect(window.getComputedStyle(next).backgroundColor)
		.not.toBe("rgb(1, 2, 3)");
	dom.dispose();
});

test("a shadow root's sheets added a rule at a time cost about what one sheet does", () => {
	const time = (pieces: boolean): number => {
		const dom = new TermDOM({
			transport: new MockProcess({cols: 100, rows: 20}).transport,
		});
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const root = host.attachShadow({mode: "open"});
		root.innerHTML = Array.from(
			{length: 600},
			(_, i) => `<p class="c${i % 50}">${i}</p>`,
		).join("");
		host.getBoundingClientRect();
		const rules = Array.from(
			{length: 100},
			(_, i) =>
				`.c${i % 50} { color: #${(i * 4567 % 0xffffff).toString(16).padStart(6, "0")}; }`,
		);
		const start = performance.now();
		for (const text of pieces ? rules : [rules.join("\n")]) {
			const style = dom.document.createElement("style");
			style.textContent = text;
			root.prepend(style);
		}
		host.getBoundingClientRect();
		const elapsed = performance.now() - start;
		dom.dispose();
		return elapsed;
	};
	time(true);
	time(false);
	// Each sheet must not restyle the whole tree.
	expect(time(true)).toBeLessThan(5 * Math.max(time(false), 1));
});

test("sibling selectors restyle within their own tree", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = dom;
	document.body.innerHTML =
		"<style>.a + .b { color: rgb(0, 128, 0); }</style>" +
		"<p id=first>x</p><p id=second class=b>y</p><div id=host></div>";
	const host = document.getElementById("host")!;
	const shadow = host.attachShadow({mode: "open"});
	shadow.innerHTML =
		"<style>.on + p { color: rgb(255, 0, 0); }</style><p id=one>1</p><p id=two>2</p>";
	const two = shadow.getElementById("two")!;
	expect(window.getComputedStyle(two).color).not.toBe("rgb(255, 0, 0)");
	shadow.getElementById("one")!.classList.add("on");
	expect(window.getComputedStyle(two).color).toBe("rgb(255, 0, 0)");
	const second = document.getElementById("second")!;
	expect(window.getComputedStyle(second).color).not.toBe("rgb(0, 128, 0)");
	document.getElementById("first")!.classList.add("a");
	expect(window.getComputedStyle(second).color).toBe("rgb(0, 128, 0)");
	dom.dispose();
});

test("the UA sheet's sibling selectors restyle inside a shadow root", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = dom;
	document.body.innerHTML = "<div id=plain></div><div id=styled></div>";
	for (const [id, sheet] of [
		["plain", ""],
		["styled", "<style>.on + p { color: red; }</style>"],
	]) {
		const shadow = document.getElementById(id)!.attachShadow({mode: "open"});
		shadow.innerHTML = `${sheet}<details><summary id=old>a</summary></details>`;
		const old = shadow.getElementById("old")!;
		expect(window.getComputedStyle(old).display).toBe("list-item");
		old.before(document.createElement("summary"));
		expect([id, window.getComputedStyle(old).display]).toEqual([id, "block"]);
	}
	dom.dispose();
});

test(":has() restyles its anchor, its siblings and what it styles below when a change reaches it", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;
	const style = document.createElement("style");
	style.textContent = `
		figure:has(a) { color: rgb(255, 0, 0); }
		figure:has(a) p { color: rgb(0, 0, 255); }
		li:has(+ li.on) { color: rgb(0, 128, 0); }
		.card:has(img.big) .title { color: rgb(1, 2, 3); }
	`;
	document.head.appendChild(style);
	document.body.innerHTML =
		"<figure><p>caption</p></figure>" +
		"<ul><li id=\"first\">a</li><li id=\"second\">b</li></ul>" +
		"<div class=\"card\"><div class=\"title\">t</div><img></div>";
	await nextFrame(termdom);
	const color = (selector: string): string => termdom.window
		.getComputedStyle(document.querySelector(selector)!)
		.getPropertyValue("color");
	const plain = color("figure");

	const link = document.createElement("a");
	document.querySelector("figure")!.appendChild(link);
	await nextFrame(termdom);
	expect(color("figure")).toBe("rgb(255, 0, 0)");
	expect(color("figure p")).toBe("rgb(0, 0, 255)");

	link.remove();
	await nextFrame(termdom);
	expect(color("figure")).toBe(plain);
	expect(color("figure p")).toBe(plain);

	document.getElementById("second")!.className = "on";
	await nextFrame(termdom);
	expect(color("#first")).toBe("rgb(0, 128, 0)");

	document.querySelector("img")!.className = "big";
	await nextFrame(termdom);
	expect(color(".title")).toBe("rgb(1, 2, 3)");
	termdom.dispose();
});
