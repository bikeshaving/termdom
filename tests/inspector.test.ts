import {test, expect} from "@b9g/libuild/test";
import {
	inspectElement,
	inspectDocument,
	inspectNode,
} from "../src/internal/inspector.js";
import type {Document, Element, Node} from "../src/internal/dom.js";
import {createDocumentWindow} from "../src/internal/termdom.js";

function asElement(value: unknown): Element {
	return value as Element;
}

/** A document of this DOM, from markup, displayed in a window of its own. */
function documentWindow(html: string): {
	window: ReturnType<typeof createDocumentWindow>;
} {
	return {window: createDocumentWindow(html)};
}

test("inspectElement formats basic elements", () => {
	const dom = documentWindow(
		"<div id=\"test\" class=\"container\">Hello</div>",
	);
	const div = dom.window.document.getElementById("test");

	const output = inspectElement(asElement(div), {colorize: false});

	expect(output).toBe('<div id="test" class="container">Hello</div>');
});

test("inspectElement handles nested elements", () => {
	const dom = documentWindow(`
		<nav>
			<ul class="menu">
				<li><a href="#home">Home</a></li>
				<li><a href="#about">About</a></li>
			</ul>
		</nav>
	`);
	const nav = dom.window.document.querySelector("nav");

	const output = inspectElement(asElement(nav), {colorize: false, maxDepth: 3});

	expect(output).toContain("<nav>");
	expect(output).toContain('<ul class="menu">');
	expect(output).toContain("<li>");
	expect(output).toContain('<a href="#home">...</a>'); // Text gets truncated at depth 3
});

test("inspectElement respects maxDepth", () => {
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

	const output = inspectElement(asElement(div), {colorize: false, maxDepth: 2});

	expect(output).toContain("<div>");
	expect(output).toContain("...");
	expect(output).not.toContain("Deep content");
});

test("inspectElement compact mode", () => {
	const dom = documentWindow(
		"<div><span>A</span><span>B</span><span>C</span></div>",
	);
	const div = dom.window.document.querySelector("div");

	const output = inspectElement(asElement(
		div,
	), {colorize: false, compact: true});

	expect(output).toBe("<div><span>A</span><span>B</span><span>C</span></div>");
});

test("inspectElement shows important attributes", () => {
	const dom = documentWindow(
		"<input type=\"text\" name=\"username\" value=\"john\" placeholder=\"Enter name\">",
	);
	const input = dom.window.document.querySelector("input");

	const output = inspectElement(asElement(input), {colorize: false});

	expect(output).toContain('type="text"');
	expect(output).toContain('name="username"');
	expect(output).toContain('value="john"');
	expect(output).toContain('placeholder="Enter name"');
});

test("inspectElement handles self-closing tags", () => {
	const dom = documentWindow(
		"<div><img src=\"test.jpg\" alt=\"Test\"><br><hr></div>",
	);
	const div = dom.window.document.querySelector("div");

	const output = inspectElement(asElement(div), {colorize: false});

	expect(output).toContain('<img src="test.jpg" alt="Test">');
	expect(output).toContain("<br>");
	expect(output).toContain("<hr>");
});

test("inspectElement truncates long text", () => {
	const longText =
		"This is a very long text that should be truncated when displayed in the inspector output to avoid making it too verbose";
	const dom = documentWindow(`<p>${longText}</p>`);
	const p = dom.window.document.querySelector("p");

	const output = inspectElement(asElement(p), {colorize: false});

	expect(output).toContain(
		"<p>This is a very long text that should be truncat...</p>",
	);
});

test("inspectDocument includes doctype and root", () => {
	const dom = documentWindow(
		"<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>",
	);

	const output = inspectDocument(dom.window.document as unknown as Document, {
		colorize: false,
		maxDepth: 2,
	});

	expect(output).toContain("#document");
	expect(output).toContain("<!DOCTYPE html>");
	expect(output).toContain("<html>");
	expect(output).toContain("<head>");
	expect(output).toContain("<title>...</title>"); // Content truncated at depth 2
});

test("inspectNode handles different node types", () => {
	const dom = documentWindow("<div>Text<!-- comment --></div>");
	const div = dom.window.document.querySelector("div");

	// Text node
	const textNode = div!.firstChild!;
	const textOutput = inspectNode(textNode as unknown as Node, {
		colorize: false,
	});
	expect(textOutput).toBe("Text");

	// Comment node
	const commentNode = div!.childNodes[1];
	const commentOutput = inspectNode(commentNode as unknown as Node, {
		colorize: false,
	});
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

test("showStyles option includes style attribute", () => {
	const dom = documentWindow(
		"<div style=\"color: red; background: blue;\">Styled</div>",
	);
	const div = dom.window.document.querySelector("div");

	const withStyles = inspectElement(asElement(div), {
		colorize: false,
		showStyles: true,
	});
	expect(withStyles).toContain('style="color: red; background: blue;"');

	const withoutStyles = inspectElement(asElement(div), {
		colorize: false,
		showStyles: false,
	});
	expect(withoutStyles).not.toContain("style=");
});

test("showAll option includes all attributes", () => {
	const dom = documentWindow(
		"<div id=\"test\" data-foo=\"bar\" aria-label=\"Test\" custom=\"value\">Content</div>",
	);
	const div = dom.window.document.querySelector("div");

	const withAll = inspectElement(asElement(div), {
		colorize: false,
		showAll: true,
	});
	expect(withAll).toContain('data-foo="bar"');
	expect(withAll).toContain('aria-label="Test"');
	expect(withAll).toContain('custom="value"');

	const withoutAll = inspectElement(asElement(div), {
		colorize: false,
		showAll: false,
	});
	expect(withoutAll).toContain('id="test"'); // id is always shown
	expect(withoutAll).not.toContain('data-foo="bar"');
});
