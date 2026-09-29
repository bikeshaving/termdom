import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess} from "./test-utils.js";

function makeApp(html = ""): TermDOM {
	const proc = new MockProcess();
	return new TermDOM({transport: proc.transport, html});
}

function matches(termdom: TermDOM, query: string): boolean {
	return termdom.window.matchMedia(query).matches;
}

test("a light and a dark color scheme block do not both apply", () => {
	const termdom = makeApp(
		"<style>" +
			"@media (prefers-color-scheme: light) { p { color: blue } }" +
			"@media (prefers-color-scheme: dark) { p { color: red } }" +
			"</style><p>x</p>",
	);
	const p = termdom.document.querySelector("p")!;
	expect(termdom.window.getComputedStyle(p).color).toBe("rgb(0, 0, 255)");
	expect(matches(termdom, "(prefers-color-scheme: light)")).toBe(true);
	expect(matches(termdom, "(prefers-color-scheme: dark)")).toBe(false);
	termdom.dispose();
});

test("a feature the engine does not know matches nothing, negated or not", () => {
	const termdom = makeApp();
	expect(matches(termdom, "(unknown-feature)")).toBe(false);
	expect(matches(termdom, "not (unknown-feature)")).toBe(false);
	expect(matches(termdom, "not all and (unknown-feature)")).toBe(false);
	expect(matches(termdom, "(unknown-feature) or (min-width: 0)")).toBe(true);
	expect(matches(termdom, "(unknown-feature) and (min-width: 0)")).toBe(false);
	expect(matches(termdom, "(prefers-color-scheme: blue)")).toBe(false);
	expect(matches(termdom, "not (prefers-color-scheme: blue)")).toBe(false);
	termdom.dispose();
});

test("a query that does not parse is not all, and its list goes on", () => {
	const termdom = makeApp();
	expect(matches(termdom, "(min-width: )")).toBe(false);
	expect(matches(termdom, "(min-width: ), all")).toBe(true);
	termdom.dispose();
});

test("preferences a person has not given are no-preference", () => {
	const termdom = makeApp();
	expect(matches(termdom, "(prefers-reduced-motion)")).toBe(false);
	expect(matches(termdom, "(prefers-reduced-motion: no-preference)")).toBe(
		true,
	);
	expect(matches(termdom, "(prefers-contrast)")).toBe(false);
	expect(matches(termdom, "(forced-colors)")).toBe(false);
	expect(matches(termdom, "(forced-colors: none)")).toBe(true);
	termdom.dispose();
});

test("em, ic and calc() in a query are measured from the initial font", () => {
	const termdom = makeApp();
	const width = termdom.window.innerWidth;
	expect(matches(termdom, `(width: ${width}em)`)).toBe(true);
	expect(matches(termdom, `(width: ${width / 2}ic)`)).toBe(true);
	expect(matches(termdom, `(width: calc(${width}px - 0px))`)).toBe(true);
	expect(matches(termdom, `(max-width: ${width - 1}em)`)).toBe(false);
	expect(matches(termdom, "(min-width: 10)")).toBe(false);
	termdom.dispose();
});

test("the terminal's shape answers orientation and aspect-ratio", () => {
	const termdom = makeApp();
	const {innerWidth, innerHeight} = termdom.window;
	const landscape = innerWidth > innerHeight;
	expect(matches(termdom, "(orientation: landscape)")).toBe(landscape);
	expect(matches(termdom, "(orientation: portrait)")).toBe(!landscape);
	expect(
		matches(termdom, `(aspect-ratio: ${innerWidth} / ${innerHeight})`),
	).toBe(true);
	expect(matches(termdom, "(min-aspect-ratio: 0/0)")).toBe(false);
	termdom.dispose();
});
