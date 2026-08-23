import {test, expect} from "@b9g/libuild/test";
import {inspect} from "node:util";
import type {Element} from "../src/internal/dom.js";
import {createDocumentWindow} from "../src/internal/termdom.js";

function asElement(value: unknown): Element {
	return value as Element;
}

/**
 * The one public door to the inspectors: the util.inspect hooks the module
 * installs on the DOM prototypes. depth carries maxDepth; colors stay off
 * so the expectations read as text.
 */
function inspected(target: unknown, maxDepth = 2): string {
	return inspect(target, {colors: false, depth: maxDepth});
}

/** A document of this DOM, from markup, displayed in a window of its own. */
function documentWindow(html: string): {
	window: ReturnType<typeof createDocumentWindow>;
} {
	return {window: createDocumentWindow(html)};
}

test("inspect formats: formats basic elements", () => {
	const dom = documentWindow(
		"<div id=\"test\" class=\"container\">Hello</div>",
	);
	const div = dom.window.document.getElementById("test");

	const output = inspected(asElement(div));

	expect(output).toBe('<div id="test" class="container">Hello</div>');
});

test("inspect formats: handles nested elements", () => {
	const dom = documentWindow(`
		<nav>
			<ul class="menu">
				<li><a href="#home">Home</a></li>
				<li><a href="#about">About</a></li>
			</ul>
		</nav>
	`);
	const nav = dom.window.document.querySelector("nav");

	const output = inspected(asElement(nav), 3);

	expect(output).toContain("<nav>");
	expect(output).toContain('<ul class="menu">');
	expect(output).toContain("<li>");
	expect(output).toContain('<a href="#home">...</a>'); // Text gets truncated at depth 3
});

test("inspect formats: respects maxDepth", () => {
	const dom = documentWindow(`
		<div>
			<div>
				<div>
					<span>Deep content</span>
				</div>
			</div>
		</div>
	`);
	const div = dom.window.document.querySelector("div");

	const output = inspected(asElement(div), 2);

	expect(output).toContain("<div>");
	expect(output).toContain("...");
	expect(output).not.toContain("Deep content");
});

test("inspect formats: shows important attributes", () => {
	const dom = documentWindow(
		"<input type=\"text\" name=\"username\" value=\"john\" placeholder=\"Enter name\">",
	);
	const input = dom.window.document.querySelector("input");

	const output = inspected(asElement(input));

	expect(output).toContain('type="text"');
	expect(output).toContain('name="username"');
	expect(output).toContain('value="john"');
	expect(output).toContain('placeholder="Enter name"');
});

test("inspect formats: handles self-closing tags", () => {
	const dom = documentWindow(
		"<div><img src=\"test.jpg\" alt=\"Test\"><br><hr></div>",
	);
	const div = dom.window.document.querySelector("div");

	const output = inspected(asElement(div));

	expect(output).toContain('<img src="test.jpg" alt="Test">');
	expect(output).toContain("<br>");
	expect(output).toContain("<hr>");
});

test("inspect formats: truncates long text", () => {
	const longText =
		"This is a very long text that should be truncated when displayed in the inspector output to avoid making it too verbose";
	const dom = documentWindow(`<p>${longText}</p>`);
	const p = dom.window.document.querySelector("p");

	const output = inspected(asElement(p));

	expect(output).toContain(
		"<p>This is a very long text that should be truncat...</p>",
	);
});

test("inspect formats: includes doctype and root", () => {
	const dom = documentWindow(
		"<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>",
	);

	const output = inspected(dom.window.document, 2);

	expect(output).toContain("#document");
	expect(output).toContain("<!DOCTYPE html>");
	expect(output).toContain("<html>");
	expect(output).toContain("<head>");
	expect(output).toContain("<title>...</title>"); // Content truncated at depth 2
});

test("inspect formats: handles different node types", () => {
	const dom = documentWindow("<div>Text<!-- comment --></div>");
	const div = dom.window.document.querySelector("div");

	// Text node
	const textNode = div!.firstChild!;
	const textOutput = inspected(textNode);
	expect(textOutput).toBe("Text");

	// Comment node
	const commentNode = div!.childNodes[1];
	const commentOutput = inspected(commentNode);
	expect(commentOutput).toBe("<!-- comment -->");
});

test("elements carry the node:util inspect method", () => {
	const dom = documentWindow("<div id=\"test\">Hello</div>");
	const div = dom.window.document.getElementById("test");
	const inspect = Symbol.for("nodejs.util.inspect.custom");

	expect(typeof (div as any)![inspect]).toBe("function");
	const output = (div as any)![inspect](2, {colors: false});
	expect(output).toBe('<div id="test">Hello</div>');
});
