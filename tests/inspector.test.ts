import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {
	inspectElement,
	inspectDocument,
	inspectNode,
	setupInspectMethods,
} from "../src/inspector.js";

test("inspectElement formats basic elements", () => {
	const dom = new JSDOM(`<div id="test" class="container">Hello</div>`);
	const div = dom.window.document.getElementById("test");

	const output = inspectElement(div!, {colorize: false});

	expect(output).toBe('<div id="test" class="container">Hello</div>');
});

test("inspectElement handles nested elements", () => {
	const dom = new JSDOM(`
		<nav>
			<ul class="menu">
				<li><a href="#home">Home</a></li>
				<li><a href="#about">About</a></li>
			</ul>
		</nav>
	`);
	const nav = dom.window.document.querySelector("nav");

	const output = inspectElement(nav!, {colorize: false, maxDepth: 3});

	expect(output).toContain("<nav>");
	expect(output).toContain('<ul class="menu">');
	expect(output).toContain("<li>");
	expect(output).toContain('<a href="#home">...</a>'); // Text gets truncated at depth 3
});

test("inspectElement respects maxDepth", () => {
	const dom = new JSDOM(`
		<div>
			<div>
				<div>
					<span>Deep content</span>
				</div>
			</div>
		</div>
	`);
	const div = dom.window.document.querySelector("div");

	const output = inspectElement(div!, {colorize: false, maxDepth: 2});

	expect(output).toContain("<div>");
	expect(output).toContain("...");
	expect(output).not.toContain("Deep content");
});

test("inspectElement compact mode", () => {
	const dom = new JSDOM(
		`<div><span>A</span><span>B</span><span>C</span></div>`,
	);
	const div = dom.window.document.querySelector("div");

	const output = inspectElement(div!, {colorize: false, compact: true});

	expect(output).toBe("<div><span>A</span><span>B</span><span>C</span></div>");
});

test("inspectElement shows important attributes", () => {
	const dom = new JSDOM(
		`<input type="text" name="username" value="john" placeholder="Enter name">`,
	);
	const input = dom.window.document.querySelector("input");

	const output = inspectElement(input!, {colorize: false});

	expect(output).toContain('type="text"');
	expect(output).toContain('name="username"');
	expect(output).toContain('value="john"');
	expect(output).toContain('placeholder="Enter name"');
});

test("inspectElement handles self-closing tags", () => {
	const dom = new JSDOM(`<div><img src="test.jpg" alt="Test"><br><hr></div>`);
	const div = dom.window.document.querySelector("div");

	const output = inspectElement(div!, {colorize: false});

	expect(output).toContain('<img src="test.jpg" alt="Test">');
	expect(output).toContain("<br>");
	expect(output).toContain("<hr>");
});

test("inspectElement truncates long text", () => {
	const longText =
		"This is a very long text that should be truncated when displayed in the inspector output to avoid making it too verbose";
	const dom = new JSDOM(`<p>${longText}</p>`);
	const p = dom.window.document.querySelector("p");

	const output = inspectElement(p!, {colorize: false});

	expect(output).toContain(
		"<p>This is a very long text that should be truncat...</p>",
	);
});

test("inspectDocument includes doctype and root", () => {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>`,
	);

	const output = inspectDocument(dom.window.document, {
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
	const dom = new JSDOM(`<div>Text<!-- comment --></div>`);
	const div = dom.window.document.querySelector("div");

	// Text node
	const textNode = div!.firstChild!;
	const textOutput = inspectNode(textNode, {colorize: false});
	expect(textOutput).toBe("Text");

	// Comment node
	const commentNode = div!.childNodes[1];
	const commentOutput = inspectNode(commentNode, {colorize: false});
	expect(commentOutput).toBe("<!-- comment -->");
});

test("setupInspectMethods adds inspect to prototypes", () => {
	const dom = new JSDOM(`<div id="test">Hello</div>`);
	setupInspectMethods(dom.window);

	const div = dom.window.document.getElementById("test");
	const inspect = Symbol.for("nodejs.util.inspect.custom");

	// Check that inspect method exists
	expect(typeof (div as any)![inspect]).toBe("function");

	// Test that it works
	const output = (div as any)![inspect](2, {colors: false});
	expect(output).toBe('<div id="test">Hello</div>');
});

test("showStyles option includes style attribute", () => {
	const dom = new JSDOM(
		`<div style="color: red; background: blue;">Styled</div>`,
	);
	const div = dom.window.document.querySelector("div");

	const withStyles = inspectElement(div!, {colorize: false, showStyles: true});
	expect(withStyles).toContain('style="color: red; background: blue;"');

	const withoutStyles = inspectElement(div!, {
		colorize: false,
		showStyles: false,
	});
	expect(withoutStyles).not.toContain("style=");
});

test("showAll option includes all attributes", () => {
	const dom = new JSDOM(
		`<div id="test" data-foo="bar" aria-label="Test" custom="value">Content</div>`,
	);
	const div = dom.window.document.querySelector("div");

	const withAll = inspectElement(div!, {colorize: false, showAll: true});
	expect(withAll).toContain('data-foo="bar"');
	expect(withAll).toContain('aria-label="Test"');
	expect(withAll).toContain('custom="value"');

	const withoutAll = inspectElement(div!, {colorize: false, showAll: false});
	expect(withoutAll).toContain('id="test"'); // id is always shown
	expect(withoutAll).not.toContain('data-foo="bar"');
});
