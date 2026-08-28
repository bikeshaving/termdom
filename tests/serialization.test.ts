/**
 * The HTML fragment serialization algorithm.
 *
 * The load-bearing property is a fixpoint: parsing a fragment and serializing
 * it must produce markup that parses to the same tree, so `innerHTML` can be
 * read out of one element and written into another without losing anything.
 * A serializer that forgets a case the parser has -- the newline pre eats,
 * the escapes an attribute needs, the end tag a void element must not have --
 * shows up here as a corpus entry that drifts on the second pass.
 */
import {test, expect} from "@b9g/libuild/test";
import {type Document, parseHTMLDocument} from "../src/internal/dom.js";

// The door a test document comes through. The parser is the one that hands
// a document the realm's custom element registry, as it does the engine's.
function createHTMLDocument(title?: string): Document {
	return parseHTMLDocument(
		title === undefined ?
			"<!doctype html>" :
			`<!doctype html><title>${title}</title>`,
	);
}

/**
 * Markup covering each branch the serialization algorithm has, paired with
 * what serializing it has to give back: the elements whose parser eats an
 * opening newline, the escapes text and attributes take, the raw-text parents
 * that take none, void elements, and the node types that are not elements.
 *
 * The two halves differ only where the parser changed the tree. Everywhere
 * else they are the same string, and the pair says so rather than leaving it
 * to be inferred.
 */
const CORPUS: Array<[string, string]> = [
	// The newline a pre, textarea or listing swallows. Serializing puts one
	// back only when the text still starts with one, so that reparsing lands
	// on the same tree rather than eating a second newline.
	["<pre>\nkept</pre>", "<pre>kept</pre>"],
	["<pre>\n\n</pre>", "<pre>\n\n</pre>"],
	["<pre>\n</pre>", "<pre></pre>"],
	["<pre>plain</pre>", "<pre>plain</pre>"],
	["<textarea>\n\n</textarea>", "<textarea>\n\n</textarea>"],
	["<textarea>\nkept</textarea>", "<textarea>kept</textarea>"],
	["<textarea>\n</textarea>", "<textarea></textarea>"],
	["<listing>\n\n</listing>", "<listing>\n\n</listing>"],
	[
		"<pre><span>\nnot the first child</span></pre>",
		"<pre><span>\nnot the first child</span></pre>",
	],
	// Escapes in text.
	["<p>a &amp; b &lt; c &gt; d</p>", "<p>a &amp; b &lt; c &gt; d</p>"],
	["<p>&nbsp;</p>", "<p>&nbsp;</p>"],
	["<p>&lt;script&gt;</p>", "<p>&lt;script&gt;</p>"],
	// Escapes in attributes: the quote and the ampersand, but not the angles.
	['<p title="a &amp; b"></p>', '<p title="a &amp; b"></p>'],
	['<p title="&quot;quoted&quot;"></p>', '<p title="&quot;quoted&quot;"></p>'],
	['<p title="a < b > c"></p>', '<p title="a < b > c"></p>'],
	['<p title="&nbsp;"></p>', '<p title="&nbsp;"></p>'],
	// Raw text takes no escaping at all.
	[
		"<style>a::before { content: '&<>' }</style>",
		"<style>a::before { content: '&<>' }</style>",
	],
	["<script>if (a &&  b) {}</script>", "<script>if (a &&  b) {}</script>"],
	// Void elements have no end tag and no children.
	["<p>before<br>after</p>", "<p>before<br>after</p>"],
	[
		'<p><img src="x.png" alt="a &amp; b"></p>',
		'<p><img src="x.png" alt="a &amp; b"></p>',
	],
	["<hr>", "<hr>"],
	['<input type="checkbox" checked="">', '<input type="checkbox" checked="">'],
	// The other node types.
	["<p><!-- a comment --></p>", "<p><!-- a comment --></p>"],
	["<p>text<!--c-->more</p>", "<p>text<!--c-->more</p>"],
	// Structure the parser normalizes on the way in.
	[
		"<table><tbody><tr><td>cell</td></tr></tbody></table>",
		"<table><tbody><tr><td>cell</td></tr></tbody></table>",
	],
	["<ul><li>one</li><li>two</li></ul>", "<ul><li>one</li><li>two</li></ul>"],
	["<p>a<b>bold<i>both</i></b>a</p>", "<p>a<b>bold<i>both</i></b>a</p>"],
	[
		"<template>\n<p>inert</p></template>",
		"<template>\n<p>inert</p></template>",
	],
	// An attribute is written back in double quotes whichever quotes it came in.
	[
		"<div dir=\"rtl\" lang='he'>שלום</div>",
		'<div dir="rtl" lang="he">שלום</div>',
	],
];

test("innerHTML serializes each of the serializer's cases", () => {
	const document = createHTMLDocument("");
	for (const [markup, expected] of CORPUS) {
		const first = document.createElement("div");
		first.innerHTML = markup;
		expect(`${markup} -> ${first.innerHTML}`).toBe(`${markup} -> ${expected}`);
	}
});

test("innerHTML round-trips to a fixpoint over the serializer's cases", () => {
	const document = createHTMLDocument("");
	for (const [markup] of CORPUS) {
		const first = document.createElement("div");
		first.innerHTML = markup;
		const once = first.innerHTML;
		const second = document.createElement("div");
		second.innerHTML = once;
		const twice = second.innerHTML;
		expect(`${markup} -> ${twice}`).toBe(`${markup} -> ${once}`);
	}
});

test("a leading newline survives every round trip a pre element takes", () => {
	// Without the extra newline the serializer writes, each pass through
	// innerHTML would eat one more, and a textarea's value would shrink every
	// time a framework rewrote the markup around it.
	const document = createHTMLDocument("");
	for (const name of ["pre", "textarea", "listing"]) {
		let markup = `<${name}>\n\nkept</${name}>`;
		for (let pass = 0; pass < 3; pass++) {
			const holder = document.createElement("div") as any;
			holder.innerHTML = markup;
			const child = holder.firstElementChild;
			expect(`${name} pass ${pass}: ${child.textContent}`).toBe(
				`${name} pass ${pass}: \nkept`,
			);
			markup = holder.innerHTML;
		}
	}
});

test("the extra newline is written only for a text child that starts with one", () => {
	const document = createHTMLDocument("");
	const holder = document.createElement("div");
	holder.innerHTML = "<pre><span>\nnested</span></pre>";
	expect(holder.innerHTML).toBe("<pre><span>\nnested</span></pre>");
	holder.innerHTML = "<pre>no newline</pre>";
	expect(holder.innerHTML).toBe("<pre>no newline</pre>");
	// A p is not one of the three, so its text is written out untouched.
	const paragraph = document.createElement("p");
	paragraph.textContent = "\nkept";
	expect(paragraph.outerHTML).toBe("<p>\nkept</p>");
});

test("a whole document round-trips through the parser to a fixpoint", () => {
	const source = [
		"<!DOCTYPE html><html><head><title>a &amp; b</title></head>",
		"<body><pre>\n\nx</pre><textarea>\ny</textarea>",
		'<p title="&quot;q&quot;">t &lt; u</p><br><img alt="&amp;">',
		"</body></html>",
	].join("");
	const once = parseHTMLDocument(source).documentElement!.outerHTML;
	const twice = parseHTMLDocument(once).documentElement!.outerHTML;
	expect(twice).toBe(once);
});
