/**
 * The selector matcher on its own: a tree with no engine over it, a resolver
 * that answers for the states a tree cannot, and one selector at a time.
 *
 * Everything here is asked of `src/internal/selectors.ts` directly rather than
 * through `querySelectorAll`, so a failure names the matcher and not the DOM
 * around it.
 */

import {test, expect} from "@b9g/libuild/test";
import {parseHTMLDocument} from "../src/internal/dom.js";
import {
	INERT_RESOLVER,
	type MatchNode,
	type SelectorResolver,
	SelectorError,
	closestSelector,
	matchesSelector,
	parseSelectorList,
	selectAll,
	selectFirst,
} from "../src/internal/selectors.js";

function tree(html: string, url = "about:blank"): MatchNode {
	return parseHTMLDocument(html, url) as unknown as MatchNode;
}

function ids(
	html: string,
	selector: string,
	resolver: SelectorResolver = INERT_RESOLVER,
): string[] {
	const document = tree(html);
	return selectAll(document, selector, {resolver}).map(
		(element) => element.getAttribute("id") ?? "",
	);
}

function find(root: MatchNode, id: string): MatchNode {
	const found = selectFirst(root, `#${id}`);
	if (found === null) {
		throw new Error(`no #${id} in the fixture`);
	}
	return found;
}

/* ------------------------------------------------------------------ grammar */

test("a selector this engine cannot read is a SyntaxError, not a miss", () => {
	const document = tree("<p></p>");
	for (const selector of [
		"",
		"[",
		"#",
		"div,",
		".5cm",
		"..test",
		"div ++ p",
		"[*=test]",
		"[class= space unquoted ]",
		"div:example",
		"::example",
		":: before",
		"ns|div",
		":not(ns|div)",
		"^|div",
		">*",
	]) {
		expect(() => selectAll(document, selector)).toThrow(SelectorError);
	}
});

test("CSS closes what an author left open at the end of the input", () => {
	expect(ids('<p id=a title="x">', '[title="x"')).toEqual(["a"]);
	expect(ids("<p id=a>", "::slotted(foo")).toEqual([]);
	// An escape with nothing left to escape spells U+FFFD, so the selector
	// is a selector and selects the id nothing here carries.
	expect(ids('<p id="eof\\">', "#eof\\")).toEqual([]);
	expect(ids('<p id="eof\uFFFD">', "#eof\\")).toEqual(["eof\uFFFD"]);
});

test("a null and a lone surrogate both stand for U+FFFD", () => {
	expect(ids('<p id="a\uFFFDb">', "#a\u0000b")).toEqual(["a\uFFFDb"]);
	expect(ids('<p id="\uFFFD">', "#\uD800")).toEqual(["\uFFFD"]);
});

test("an escaped class or id names the character it spells", () => {
	// The census's first reproduced defect: a Tailwind-shaped class name.
	expect(ids('<p id=a class="b:hover">', ".b\\:hover")).toEqual(["a"]);
	expect(ids('<p id="a:b">', "#a\\:b")).toEqual(["a:b"]);
	expect(ids('<p id=a class="台北Táiběi">', ".台北Táiběi")).toEqual(["a"]);
});

test("a pseudo-class spelled inside an attribute value is a value", () => {
	// The second reproduced defect: the string is data, not a selector.
	expect(ids('<p id=a data-k=":hover">', '[data-k=":hover"]')).toEqual(["a"]);
});

test(":is drops the branches it cannot read and keeps the rest", () => {
	// The third: a forgiving list is forgiving, and silently so.
	expect(ids("<p id=a></p><b id=b></b>", ":is(p, :garbage)")).toEqual(["a"]);
	expect(ids("<p id=a></p>", ":is(:garbage)")).toEqual([]);
	expect(ids("<p id=a></p><b id=b></b>", ":where(p, :nope)")).toEqual(["a"]);
});

test(":not is not forgiving", () => {
	const document = tree("<p></p>");
	expect(() => selectAll(document, ":not(p, :garbage)")).toThrow(SelectorError);
});

test("a selector is compiled once and answers the same twice", () => {
	expect(ids("<p id=a>", "p")).toEqual(["a"]);
	expect(ids("<p id=b>", "p")).toEqual(["b"]);
});

/* ------------------------------------------------------------------- basics */

test("a type selector folds case for HTML and keeps it for everything else", () => {
	expect(ids("<p id=a>", "P")).toEqual(["a"]);
	const document = tree("<div id=host></div>");
	const svg = (
		document as unknown as {
			createElementNS(ns: string, name: string): MatchNode;
		}
	).createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
	(find(document, "host") as unknown as {appendChild(n: MatchNode): void})
		.appendChild(svg);
	expect(matchesSelector(svg, "feGaussianBlur")).toBe(true);
	expect(matchesSelector(svg, "fegaussianblur")).toBe(false);
});

test("a namespace prefix is only as good as its declaration", () => {
	const namespaces = {
		default: null,
		prefixes: new Map([["svg", "http://www.w3.org/2000/svg"]]),
	};
	const document = tree("<div id=a></div>");
	const svg = (
		document as unknown as {
			createElementNS(ns: string, name: string): MatchNode;
		}
	).createElementNS("http://www.w3.org/2000/svg", "circle");
	(find(document, "a") as unknown as {appendChild(n: MatchNode): void})
		.appendChild(svg);
	expect(matchesSelector(svg, "svg|circle", {namespaces})).toBe(true);
	expect(matchesSelector(svg, "*|circle", {namespaces})).toBe(true);
	expect(matchesSelector(svg, "|circle", {namespaces})).toBe(false);
	expect(() => matchesSelector(svg, "nope|circle", {namespaces})).toThrow(
		SelectorError,
	);
});

test("a default namespace qualifies a compound that names no type", () => {
	const namespaces = {
		default: "http://www.w3.org/2000/svg",
		prefixes: new Map(),
	};
	const document = tree("<div id=a class=x></div>");
	expect(matchesSelector(find(document, "a"), ".x", {namespaces})).toBe(false);
	expect(matchesSelector(find(document, "a"), ".x")).toBe(true);
});

test("class and id fold case only in quirks mode", () => {
	const quirks: SelectorResolver = {...INERT_RESOLVER, quirks: () => true};
	expect(ids("<p id=A class=B>", "#a")).toEqual([]);
	expect(ids("<p id=A class=B>", "#a", quirks)).toEqual(["A"]);
	expect(ids("<p id=A class=B>", ".b", quirks)).toEqual(["A"]);
});

/* ---------------------------------------------------------------- attributes */

const ATTRIBUTES = `
	<a id=a1 href="http://www.example.org/" rel="next bookmark" lang="en-GB"></a>
	<a id=a2 href="http://example.com/x.org" rel="bookmark" lang="fr"></a>
	<div id=d1 class="apple banana orange" align="CENTER"></div>
`;

test("every attribute operator", () => {
	expect(ids(ATTRIBUTES, "[href]")).toEqual(["a1", "a2"]);
	expect(ids(ATTRIBUTES, '[rel="bookmark"]')).toEqual(["a2"]);
	expect(ids(ATTRIBUTES, '[rel~="bookmark"]')).toEqual(["a1", "a2"]);
	expect(ids(ATTRIBUTES, '[lang|="en"]')).toEqual(["a1"]);
	expect(ids(ATTRIBUTES, '[href^="http://www"]')).toEqual(["a1"]);
	expect(ids(ATTRIBUTES, '[href$=".org/"]')).toEqual(["a1"]);
	expect(ids(ATTRIBUTES, '[href*="example"]')).toEqual(["a1", "a2"]);
});

test("an empty or spaced value is in no whitespace-separated list", () => {
	expect(ids(ATTRIBUTES, '[rel~=""]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[rel~="next bookmark"]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[class^=""]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[class$=""]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[class*=""]')).toEqual([]);
});

test("the flags say what case sensitivity the value is compared with", () => {
	expect(ids(ATTRIBUTES, '[class="APPLE banana orange"]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[class="APPLE banana orange" i]')).toEqual(["d1"]);
	// `align` is on HTML's own case-insensitive list.
	expect(ids(ATTRIBUTES, '[align="center"]')).toEqual(["d1"]);
	expect(ids(ATTRIBUTES, '[align="center" s]')).toEqual([]);
	expect(ids(ATTRIBUTES, '[align="CENTER" s]')).toEqual(["d1"]);
});

test("an attribute flag this engine does not know is a SyntaxError", () => {
	expect(() => selectAll(tree("<p>"), "[title=x q]")).toThrow(SelectorError);
});

/* --------------------------------------------------------------- combinators */

const TREE = `
	<div id=outer>
		<p id=p1>one</p>
		<p id=p2><b id=b1>two</b></p>
		<span id=s1></span>
		<p id=p3></p>
	</div>
`;

test("the four combinators, read right to left", () => {
	expect(ids(TREE, "#outer b")).toEqual(["b1"]);
	expect(ids(TREE, "#outer > b")).toEqual([]);
	expect(ids(TREE, "#outer > p")).toEqual(["p1", "p2", "p3"]);
	expect(ids(TREE, "#p2 + span")).toEqual(["s1"]);
	expect(ids(TREE, "#p1 ~ p")).toEqual(["p2", "p3"]);
});

test("a deep tree costs no stack", () => {
	const document = tree("<div id=top></div>");
	const top = find(document, "top") as unknown as {
		appendChild(child: unknown): void;
		ownerDocument: {createElement(name: string): unknown};
	};
	let node = top;
	for (let depth = 0; depth < 20000; depth++) {
		const child = top.ownerDocument.createElement("div") as typeof top & {
			setAttribute(name: string, value: string): void;
		};
		if (depth === 19999) {
			child.setAttribute("class", "deep");
		}
		node.appendChild(child);
		node = child;
	}
	expect(selectAll(document, ".deep").length).toBe(1);
	expect(selectAll(document, "#top:has(.deep)").length).toBe(1);
});

test("results come back in tree order, once each", () => {
	expect(ids(TREE, "p, #p2, div p")).toEqual(["p1", "p2", "p3"]);
});

/* ---------------------------------------------------------------- structure */

const NTH = `
	<ul id=list>
		<li id=l1 class=x></li>
		<li id=l2></li>
		<li id=l3 class=x></li>
		<li id=l4></li>
		<li id=l5 class=x></li>
	</ul>
`;

test("An+B, from either end", () => {
	expect(ids(NTH, "li:nth-child(2n)")).toEqual(["l2", "l4"]);
	expect(ids(NTH, "li:nth-child(odd)")).toEqual(["l1", "l3", "l5"]);
	expect(ids(NTH, "li:nth-child(-n+2)")).toEqual(["l1", "l2"]);
	expect(ids(NTH, "li:nth-last-child(2)")).toEqual(["l4"]);
	expect(ids(NTH, "li:nth-child(3)")).toEqual(["l3"]);
});

test("An+B counts only what its `of` selector keeps", () => {
	expect(ids(NTH, "li:nth-child(2 of .x)")).toEqual(["l3"]);
	expect(ids(NTH, "li:nth-last-child(1 of .x)")).toEqual(["l5"]);
});

test("the of-type family counts siblings of one element type", () => {
	const html = "<div id=d><p id=p1></p><b id=b1></b><p id=p2></p></div>";
	expect(ids(html, "p:first-of-type")).toEqual(["p1"]);
	expect(ids(html, "p:last-of-type")).toEqual(["p2"]);
	expect(ids(html, "b:only-of-type")).toEqual(["b1"]);
	expect(ids(html, ":nth-of-type(2)")).toEqual(["p2"]);
});

test(":empty counts text but not comments", () => {
	const html = "<p id=a></p><p id=b><!--c--></p><p id=c> </p><p id=d><b></b></p>";
	expect(ids(html, "p:empty")).toEqual(["a", "b"]);
});

test(":root is the element the document hangs from", () => {
	expect(ids("<p id=a>", ":root")).toEqual([""]);
	expect(matchesSelector(find(tree("<p id=a>"), "a"), ":root")).toBe(false);
});

/* -------------------------------------------------------------------- :has */

const HAS = `
	<ul id=list>
		<li id=l1></li>
		<li id=l2 class=x></li>
		<li id=l3><b id=deep></b></li>
	</ul>
`;

test(":has reaches down, across and no further than it should", () => {
	expect(ids(HAS, "li:has(b)")).toEqual(["l3"]);
	expect(ids(HAS, "li:has(> b)")).toEqual(["l3"]);
	expect(ids(HAS, "li:has(+ li.x)")).toEqual(["l1"]);
	// The census's fourth defect: a sibling scan starts past the anchor, so
	// the `li.x` being asked about is never the `li.x` it finds.
	expect(ids(HAS, "li:has(~ li.x)")).toEqual(["l1"]);
	expect(ids(HAS, "ul:has(li li)")).toEqual([]);
	expect(ids(HAS, "ul:has(li b)")).toEqual(["list"]);
});

test(":has nests, and :scope inside it still names the query's root", () => {
	const document = tree(HAS);
	expect(ids(HAS, "ul:has(li:has(b))")).toEqual(["list"]);
	expect(
		matchesSelector(find(document, "list"), "ul:has(> :scope)", {
			scope: find(document, "l2"),
		}),
	).toBe(true);
	expect(
		matchesSelector(find(document, "list"), "ul:has(> :scope)", {
			scope: find(document, "deep"),
		}),
	).toBe(false);
});

test(":has takes no unreadable branch", () => {
	expect(() => selectAll(tree(HAS), "li:has(:garbage)")).toThrow(SelectorError);
});

/* ------------------------------------------------------------------- :scope */

test(":scope names what each entry point scopes to", () => {
	const document = tree(NTH);
	const list = find(document, "list");
	// The census's fifth defect: an element matches `:scope` against itself.
	expect(matchesSelector(list, ":scope", {scope: list})).toBe(true);
	expect(matchesSelector(list, ":scope li", {scope: list})).toBe(false);
	expect(
		matchesSelector(find(document, "l1"), ":scope > li", {scope: list}),
	).toBe(true);
	expect(
		closestSelector(find(document, "l1"), "ul > :scope", {
			scope: find(document, "l1"),
		}),
	).toBe(find(document, "l1"));
});

test("a relative selector hangs from the root it is scoped to", () => {
	const document = tree(NTH);
	const list = find(document, "list");
	expect(
		selectAll(document, "> li", {scope: list, relative: true}).map(
			(element) => element.getAttribute("id"),
		),
	).toEqual(["l1", "l2", "l3", "l4", "l5"]);
	expect(
		selectAll(document, "> li", {
			scope: find(document, "l1"),
			relative: true,
		}),
	).toEqual([]);
	expect(() => selectAll(document, "> li")).toThrow(SelectorError);
});

/* ---------------------------------------------------------------- languages */

test(":lang filters by RFC 4647 extended matching", () => {
	const html = `
		<div id=d1 lang="en"><i id=i1></i></div>
		<div id=d2 lang="en-GB-oxendict"></div>
		<div id=d3 lang="fr"></div>
	`;
	expect(ids(html, ":lang(en)")).toEqual(["d1", "i1", "d2"]);
	expect(ids(html, ":lang(en-GB)")).toEqual(["d2"]);
	expect(ids(html, ":lang(fr)")).toEqual(["d3"]);
	expect(ids(html, ':lang("*-GB")')).toEqual(["d2"]);
	expect(ids(html, ":lang(en, fr)")).toEqual(["d1", "i1", "d2", "d3"]);
});

/* ----------------------------------------------------------- directionality */

test(":dir reads the direction HTML computes, not the text it can see", () => {
	const html = `
		<div id=ltr dir=ltr>שלום</div>
		<div id=rtl dir=rtl>hello</div>
		<div id=auto1 dir=auto>   שלום עולם</div>
		<div id=auto2 dir=auto>   hello שלום</div>
		<div id=auto3 dir=auto>123 456</div>
		<div id=outer dir=rtl><span id=inner>inherits</span></div>
	`;
	expect(
		ids(html, "[id]:dir(rtl)"),
	).toEqual(["rtl", "auto1", "outer", "inner"]);
	expect(ids(html, "[id]:dir(ltr)")).toEqual(["ltr", "auto2", "auto3"]);
});

test("a bdi reads its own text, and keeps it out of the scan above it", () => {
	const html = `
		<div id=holder><bdi id=b>שלום</bdi></div>
		<div id=auto dir=auto><bdi>שלום</bdi>hello</div>
	`;
	expect(ids(html, "[id]:dir(rtl)")).toEqual(["b"]);
	expect(ids(html, "#auto:dir(ltr)")).toEqual(["auto"]);
});

/* ------------------------------------------------------------ form controls */

const FORM = `
	<form id=f>
		<fieldset id=fs disabled>
			<legend id=lg><input id=in-legend></legend>
			<input id=in-body>
		</fieldset>
		<input id=plain required>
		<input id=ro readonly>
		<input id=hidden type=hidden>
		<select id=sel><option id=o1>a</option><option id=o2 selected>b</option></select>
		<textarea id=ta></textarea>
	</form>
`;

test(":disabled follows the fieldset chain and lets the first legend out", () => {
	expect(ids(FORM, ":disabled")).toEqual(["fs", "in-body"]);
	expect(ids(FORM, "input:enabled").includes("in-legend")).toBe(true);
	expect(ids(FORM, "input:enabled").includes("in-body")).toBe(false);
});

test(":required and :optional only speak of controls that can be required", () => {
	expect(ids(FORM, ":required")).toEqual(["plain"]);
	expect(ids(FORM, "input:optional")).toEqual([
		"in-legend",
		"in-body",
		"ro",
	]);
});

test(":read-only and :read-write split on what the user may type into", () => {
	expect(ids(FORM, "input:read-write")).toEqual([
		"in-legend",
		"plain",
	]);
	expect(ids(FORM, "#ro:read-only")).toEqual(["ro"]);
	expect(ids(FORM, "#hidden:read-only")).toEqual(["hidden"]);
	expect(ids("<div id=a contenteditable><b id=b></b></div>", ":read-write"))
		.toEqual(["a", "b"]);
});

test("the constraint validation pseudos are deliberately absent", () => {
	for (const selector of [":valid", ":invalid", ":in-range", ":out-of-range"]) {
		expect(ids(FORM, selector)).toEqual([]);
	}
	expect(ids("<input id=a autocomplete=name>", ":autofill")).toEqual([]);
});

test("the states an engine holds are the resolver's to answer", () => {
	const html = "<div id=a></div><div id=b></div>";
	const document = tree(html);
	const a = find(document, "a");
	const only = (element: MatchNode): boolean => element === a;
	const resolver: SelectorResolver = {
		...INERT_RESOLVER,
		hovered: only,
		focused: only,
		focusVisible: () => false,
		focusWithin: only,
		active: only,
		target: only,
		modal: only,
		popoverOpen: only,
		fullscreen: only,
		checked: only,
		indeterminate: only,
		placeholderShown: only,
		defaulted: only,
		open: only,
		state: (element, name) => element === a && name === "loud",
	};
	for (const selector of [
		":hover",
		":focus",
		":focus-within",
		":active",
		":target",
		":modal",
		":popover-open",
		":fullscreen",
		":checked",
		":indeterminate",
		":placeholder-shown",
		":default",
		":state(loud)",
	]) {
		expect(selectAll(document, selector, {resolver}).map(
			(element) => element.getAttribute("id"),
		)).toEqual(["a"]);
	}
	// :focus-visible is its own pseudo, and says no where :focus says yes.
	expect(selectAll(document, ":focus-visible", {resolver})).toEqual([]);
});

test(":open and :closed only speak of what can be open", () => {
	const html = "<details id=d></details><div id=v></div>";
	const document = tree(html);
	const details = find(document, "d");
	const resolver: SelectorResolver = {
		...INERT_RESOLVER,
		open: (element) => element === details,
	};
	expect(
		selectAll(document, ":open", {resolver}).map((e) => e.getAttribute("id")),
	).toEqual(["d"]);
	expect(
		selectAll(document, ":closed", {resolver}).map((e) => e.getAttribute("id")),
	).toEqual([]);
	expect(
		selectAll(document, ":closed", {resolver: INERT_RESOLVER}).map((e) =>
			e.getAttribute("id"),
		),
	).toEqual(["d"]);
});

test(":link is a hyperlink, and :visited is nothing at all", () => {
	const html =
		'<a id=a href="#"></a><a id=b></a><link id=c href="#">' +
		'<area id=d href="#">';
	expect(ids(html, ":link")).toEqual(["a", "d"]);
	expect(ids(html, ":any-link")).toEqual(["a", "d"]);
	expect(ids(html, ":visited")).toEqual([]);
});

/* ---------------------------------------------------------------- tree scope */

test(":host names the host of the tree the selector was written in", () => {
	const document = tree("<div id=host></div><div id=other></div>");
	const host = find(document, "host");
	const shadow = {
		nodeType: 11,
		localName: "",
		namespaceURI: null,
		nodeValue: null,
		parentNode: null,
		childNodes: [],
		attributes: [],
		getAttribute: () => null,
	} as unknown as MatchNode;
	const resolver: SelectorResolver = {
		...INERT_RESOLVER,
		shadowHost: (root) => (root === shadow ? host : null),
	};
	const options = {resolver, shadow};
	expect(matchesSelector(host, ":host", options)).toBe(true);
	expect(matchesSelector(find(document, "other"), ":host", options)).toBe(
		false,
	);
	expect(matchesSelector(host, ":host", {resolver})).toBe(false);
	expect(matchesSelector(host, ":host(div)", options)).toBe(true);
	expect(matchesSelector(host, ":host(span)", options)).toBe(false);
	expect(matchesSelector(host, ":host-context(body)", options)).toBe(true);
	expect(matchesSelector(host, ":host-context(table)", options)).toBe(false);
});

test("::part and ::slotted select through the boundary, and only for the cascade", () => {
	const document = tree("<div id=host><span id=light></span></div>");
	const host = find(document, "host");
	const light = find(document, "light");
	const slot = tree("<slot></slot>");
	const resolver: SelectorResolver = {
		...INERT_RESOLVER,
		parts: (element) => (element === light ? ["knob"] : []),
		assignedSlot: (element) => (element === light ? slot : null),
		root: (element) => (element === light ? slot : host),
		shadowHost: (root) => (root === slot ? host : null),
	};
	const options = {resolver, pseudoElements: true};
	expect(matchesSelector(light, "#host::part(knob)", options)).toBe(true);
	expect(matchesSelector(light, "#host::part(other)", options)).toBe(false);
	expect(matchesSelector(light, "::slotted(span)", options)).toBe(true);
	expect(matchesSelector(light, "::slotted(b)", options)).toBe(false);
	// A query over the tree never selects a pseudo-element.
	expect(matchesSelector(light, "::slotted(span)", {resolver})).toBe(false);
	expect(matchesSelector(light, "span::before", {resolver})).toBe(false);
});

/* ------------------------------------------------------------- shared parsing */

test("parseSelectorList reads shape and leaves prefixes to their sheet", () => {
	expect(parseSelectorList("svg|circle")).not.toBe(null);
	expect(parseSelectorList("div:gibberish")).toBe(null);
	expect(parseSelectorList("")).toBe(null);
	expect(parseSelectorList("a, b")).not.toBe(null);
});
