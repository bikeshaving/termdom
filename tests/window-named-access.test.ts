/**
 * Named access on the Window object: an element's id, or the name of an
 * embed, form, img or object, is a property of the window while the
 * element is in the document.
 */
import {expect, test} from "@b9g/libuild/test";

import {createWindow} from "../src/internal/dom.ts";

function open(html: string): {window: any; document: any} {
	const window = createWindow(html) as any;
	return {window, document: window.document};
}

test("an element's id and a form's or image's name are window properties", () => {
	const {window} = open(
		"<div id=target></div><form name=signup></form><img name=logo>" +
		"<p name=paragraph></p>",
	);
	expect(window.target.localName).toBe("div");
	expect(window.signup.localName).toBe("form");
	expect(window.logo.localName).toBe("img");
	expect("paragraph" in window).toBe(false);
});

test("a name several elements share is one live collection", () => {
	const {window, document} = open("<div id=twin></div><span id=twin></span>");
	const twins = window.twin;
	expect(twins.length).toBe(2);
	expect(window.twin).toBe(twins);
	const third = document.createElement("b");
	third.id = "twin";
	document.body.append(third);
	expect(twins.length).toBe(3);
});

test("names follow the document as it changes", () => {
	const {window, document} = open("");
	const element = document.createElement("p");
	element.id = "later";
	expect("later" in window).toBe(false);
	document.body.append(element);
	expect(window.later).toBe(element);
	element.id = "renamed";
	expect("later" in window).toBe(false);
	expect(window.renamed).toBe(element);
	element.remove();
	expect("renamed" in window).toBe(false);
});

test("the window's own members and prototype win over a named element", () => {
	const {window, document} =
		open("<div id=document></div><div id=addEventListener></div>");
	expect(window.document).toBe(document);
	expect(typeof window.addEventListener).toBe("function");
});

test("a write shadows the element, and names are not enumerable", () => {
	const {window} = open("<div id=target></div>");
	expect(Object.keys(window)).not.toContain("target");
	window.target = 5;
	expect(window.target).toBe(5);
	expect(Object.keys(window)).toContain("target");
});

test("an element in a shadow tree is not named on the window", () => {
	const {window, document} = open("<div id=host></div>");
	const root = document.getElementById("host").attachShadow({mode: "open"});
	root.innerHTML = "<b id=inside></b>";
	expect("inside" in window).toBe(false);
});
