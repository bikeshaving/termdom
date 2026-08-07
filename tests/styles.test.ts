import {test, expect, describe} from "@b9g/libuild/test";
import {JSDOM} from "jsdom";
import {StyleManager} from "../src/internal/styles.js";
import {LayoutEngine} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

describe("getComputedStyle - What We Support", () => {
	test("CSS spec defaults", () => {
		const dom = new JSDOM(
			`<!DOCTYPE html><html><body><div id="test"></div></body></html>`,
		);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Test basic CSS spec defaults (computed values)
		expect(styles.getPropertyValue("margin")).toBe("0px 0px 0px 0px");
		expect(styles.getPropertyValue("padding")).toBe("0px 0px 0px 0px");
		expect(styles.getPropertyValue("border-width")).toBe("0px");
		expect(styles.getPropertyValue("border-style")).toBe("none");
		expect(styles.getPropertyValue("background-color")).toBe("transparent");
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
		expect(styles.getPropertyValue("font-size")).toBe("1rem");
		expect(styles.getPropertyValue("white-space")).toBe("normal");
		expect(styles.getPropertyValue("position")).toBe("static");
		expect(styles.getPropertyValue("width")).toBe("auto");
		expect(styles.getPropertyValue("height")).toBe("auto");
	});

	test("terminal element defaults", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="div"></div>
					<span id="span"></span>
					<ul id="ul"></ul>
					<li id="li"></li>
					<pre id="pre"></pre>
					<strong id="strong"></strong>
					<button id="button"></button>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);

		// Block elements
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("div")!)
				.getPropertyValue("display"),
		).toBe("block");

		// Inline elements
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("span")!)
				.getPropertyValue("display"),
		).toBe("inline");
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("strong")!)
				.getPropertyValue("font-weight"),
		).toBe("bold");

		// List elements
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("ul")!)
				.getPropertyValue("display"),
		).toBe("block");
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("ul")!)
				.getPropertyValue("padding-left"),
		).toBe("4ch");
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("li")!)
				.getPropertyValue("display"),
		).toBe("list-item");

		// Special elements
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("pre")!)
				.getPropertyValue("white-space"),
		).toBe("pre");
		expect(
			dom.window
				.getComputedStyle(dom.window.document.getElementById("button")!)
				.getPropertyValue("display"),
		).toBe("inline-block");
		// The button is "[ Label ]": chrome comes from UA ::before/::after
		// bracket rules, not from box properties.
		const button = dom.window.document.getElementById("button")!;
		const buttonStyle = dom.window.getComputedStyle(button);
		expect(buttonStyle.getPropertyValue("border-top-style")).toBe("none");
		expect(
			dom.window
				.getComputedStyle(button, "::before")
				.getPropertyValue("content"),
		).toBe('"[ "');
	});

	test("inline styles override defaults", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="test" style="color: red; margin: 10px; display: flex;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		expect(styles.getPropertyValue("color")).toBe("red");
		expect(styles.getPropertyValue("margin")).toBe("10px 10px 10px 10px");
		expect(styles.getPropertyValue("display")).toBe("flex");
		// Non-specified properties should still use defaults
		expect(styles.getPropertyValue("padding")).toBe("0px 0px 0px 0px");
	});

	test("CSS keywords - initial", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="test" style="color: initial; margin: initial;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should resolve to CSS spec defaults (computed values)
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
		expect(styles.getPropertyValue("margin")).toBe("0px 0px 0px 0px");
	});

	test("CSS keywords - unset, revert, revert-layer", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="test" style="color: unset; margin: revert; padding: revert-layer;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should resolve to defaults (we treat these the same as initial for now)
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
		expect(styles.getPropertyValue("margin")).toBe("0px 0px 0px 0px");
		expect(styles.getPropertyValue("padding")).toBe("0px 0px 0px 0px");
	});

	test.todo("property inheritance", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="parent" style="color: blue; font-size: 16px; margin: 20px;">
						<span id="child"></span>
						<div id="child-with-inherit" style="color: inherit; font-size: inherit;"></div>
					</div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);

		const child = dom.window.document.getElementById("child")!;
		const childStyles = dom.window.getComputedStyle(child);

		// Inherited properties should inherit from parent
		expect(childStyles.getPropertyValue("color")).toBe("blue");
		expect(childStyles.getPropertyValue("font-size")).toBe("16px");
		// Non-inherited properties should use their own defaults
		expect(childStyles.getPropertyValue("margin")).toBe("0px 0px 0px 0px");

		const childWithInherit =
			dom.window.document.getElementById("child-with-inherit")!;
		const childWithInheritStyles =
			dom.window.getComputedStyle(childWithInherit);

		// Explicit inherit should work
		expect(childWithInheritStyles.getPropertyValue("color")).toBe("blue");
		expect(childWithInheritStyles.getPropertyValue("font-size")).toBe("16px");
	});

	test("CSSStyleDeclaration interface compatibility", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="test" style="color: red; margin: 10px;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should provide CSSStyleDeclaration-compatible interface
		expect(styles).toBeTruthy();

		// Should have CSSStyleDeclaration methods
		expect(typeof styles.getPropertyValue).toBe("function");
		expect(typeof styles.setProperty).toBe("function");
		expect(typeof styles.removeProperty).toBe("function");

		// Should work with standard CSS properties
		expect(styles.getPropertyValue("color")).toBe("red");
		expect(styles.getPropertyValue("margin")).toBe("10px 10px 10px 10px");
	});

	test("box model properties", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<body>
					<div id="test" style="
						margin: 5px 10px 15px 20px;
						padding: 1px 2px 3px 4px;
						border: 2px solid black;
						width: 100px;
						height: 50px;
					"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		expect(styles.getPropertyValue("margin")).toBe("5px 10px 15px 20px");
		expect(styles.getPropertyValue("padding")).toBe("1px 2px 3px 4px");
		expect(styles.getPropertyValue("border")).toBe("2px solid black");
		expect(styles.getPropertyValue("width")).toBe("100px");
		expect(styles.getPropertyValue("height")).toBe("50px");
	});
});

describe("getComputedStyle - What We Don't Support (Failing Tests)", () => {
	test.todo("CSS specificity calculation", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						.class { color: blue; }
						#id { color: red; }
						div { color: green; }
					</style>
				</head>
				<body>
					<div id="test" class="class" style="color: yellow;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should resolve to inline style (highest specificity)
		expect(styles.getPropertyValue("color")).toBe("yellow");

		// Without inline style, ID should win
		element.style.removeProperty("color");
		expect(styles.getPropertyValue("color")).toBe("red");

		// Without ID, class should win
		element.removeAttribute("id");
		expect(styles.getPropertyValue("color")).toBe("blue");

		// Without class, element selector should win
		element.removeAttribute("class");
		expect(styles.getPropertyValue("color")).toBe("green");
	});

	test.todo("stylesheet parsing from <style> elements", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { 
							color: red; 
							margin: 20px;
							font-size: 14px;
						}
						.container {
							padding: 10px;
							background-color: #f0f0f0;
						}
					</style>
				</head>
				<body>
					<div id="test" class="container"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should apply styles from <style> element
		expect(styles.getPropertyValue("color")).toBe("red");
		expect(styles.getPropertyValue("margin")).toBe("20px");
		expect(styles.getPropertyValue("font-size")).toBe("14px");
		expect(styles.getPropertyValue("padding")).toBe("10px");
		expect(styles.getPropertyValue("background-color")).toBe("#f0f0f0");
	});

	test.todo("multiple stylesheets with cascade resolution", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { color: red; font-size: 12px; }
					</style>
					<style>
						div { color: blue; margin: 10px; }
					</style>
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Later stylesheet should win for same specificity
		expect(styles.getPropertyValue("color")).toBe("blue");
		// Properties from both should apply
		expect(styles.getPropertyValue("font-size")).toBe("12px");
		expect(styles.getPropertyValue("margin")).toBe("10px");
	});

	test.todo("!important declarations", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { color: red !important; }
						#test { color: blue; }
					</style>
				</head>
				<body>
					<div id="test" style="color: green;"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// !important should override everything except inline !important
		expect(styles.getPropertyValue("color")).toBe("red");
	});

	test.todo("complex selectors", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						.parent .child { color: red; }
						div > span { font-size: 16px; }
						.container + .sibling { margin: 20px; }
						div:first-child { padding: 10px; }
					</style>
				</head>
				<body>
					<div class="parent">
						<span class="child">Child</span>
						<span>Direct child</span>
					</div>
					<div class="container"></div>
					<div class="sibling"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);

		// Descendant selector
		const child = dom.window.document.querySelector(".child")!;
		expect(dom.window.getComputedStyle(child).getPropertyValue("color")).toBe(
			"red",
		);

		// Child selector
		const directChild = dom.window.document.querySelector("div > span")!;
		expect(
			dom.window.getComputedStyle(directChild).getPropertyValue("font-size"),
		).toBe("16px");

		// Adjacent sibling
		const sibling = dom.window.document.querySelector(".sibling")!;
		expect(
			dom.window.getComputedStyle(sibling).getPropertyValue("margin"),
		).toBe("20px");

		// Pseudo-class
		const firstDiv = dom.window.document.querySelector("div:first-child")!;
		expect(
			dom.window.getComputedStyle(firstDiv).getPropertyValue("padding"),
		).toBe("10px");
	});

	test.todo("external stylesheets", () => {
		// This would require implementing <link> element support
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<link rel="stylesheet" href="styles.css">
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should load and apply external stylesheet
		// This test would need mock file system or HTTP support
		expect(styles.getPropertyValue("color")).toBe("from-external-css");
	});

	test("shorthand property expansion - margin and padding", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { 
							margin: 10px 20px;
							padding: 5px 15px 25px;
						}
					</style>
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Margin shorthand should expand to individual properties
		expect(styles.getPropertyValue("margin-top")).toBe("10px");
		expect(styles.getPropertyValue("margin-right")).toBe("20px");
		expect(styles.getPropertyValue("margin-bottom")).toBe("10px");
		expect(styles.getPropertyValue("margin-left")).toBe("20px");

		// Padding shorthand should expand to individual properties
		expect(styles.getPropertyValue("padding-top")).toBe("5px");
		expect(styles.getPropertyValue("padding-right")).toBe("15px");
		expect(styles.getPropertyValue("padding-bottom")).toBe("25px");
		expect(styles.getPropertyValue("padding-left")).toBe("15px");

		// And the shorthand properties should return the expanded form
		expect(styles.getPropertyValue("margin")).toBe("10px 20px 10px 20px");
		expect(styles.getPropertyValue("padding")).toBe("5px 15px 25px 15px");
	});

	test.todo("shorthand property expansion - border and background", () => {
		// TODO: Implement border and background shorthand expansion
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { 
							border: 2px solid red;
							background: #fff url(bg.png) no-repeat center;
						}
					</style>
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		expect(styles.getPropertyValue("border-width")).toBe("2px");
		expect(styles.getPropertyValue("border-style")).toBe("solid");
		expect(styles.getPropertyValue("border-color")).toBe("red");

		expect(styles.getPropertyValue("background-color")).toBe("#fff");
		expect(styles.getPropertyValue("background-image")).toBe("url(bg.png)");
		expect(styles.getPropertyValue("background-repeat")).toBe("no-repeat");
		expect(styles.getPropertyValue("background-position")).toBe("center");
	});

	test.todo("CSS media queries", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						div { color: red; }
						@media screen and (max-width: 600px) {
							div { color: blue; }
						}
					</style>
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should apply media query based on viewport size
		// This would need viewport size simulation
		expect(styles.getPropertyValue("color")).toBe("blue");
	});

	test.todo("CSS custom properties (CSS variables)", () => {
		const dom = new JSDOM(`<!DOCTYPE html>
			<html>
				<head>
					<style>
						:root {
							--primary-color: blue;
							--spacing: 20px;
						}
						div {
							color: var(--primary-color);
							margin: var(--spacing);
						}
					</style>
				</head>
				<body>
					<div id="test"></div>
				</body>
			</html>
		`);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Should resolve CSS custom properties
		expect(styles.getPropertyValue("color")).toBe("blue");
		expect(styles.getPropertyValue("margin")).toBe("20px");

		// Should also expose custom properties themselves
		expect(styles.getPropertyValue("--primary-color")).toBe("blue");
		expect(styles.getPropertyValue("--spacing")).toBe("20px");
	});
});

test("a nonzero length without a unit is invalid and never enters the cascade", async () => {
	// Browsers reject the declaration at parse time, so a lower-priority
	// rule still wins. Coercing to 0 instead would let the bad declaration
	// beat the good one -- which is what this engine used to do, and what
	// silently killed `padding-top: 1` in the examples.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>
		.box { padding-top: 3px; }
		.box { padding-top: 1; }
		.shorthand { padding: 1px 2; }
	</style>`;
	dom.document.body.innerHTML = `<div class="box">B</div><div class="shorthand">S</div>`;
	await nextFrame(dom);
	const value = (sel: string, prop: string) =>
		dom.window
			.getComputedStyle(dom.document.querySelector(sel)!)
			.getPropertyValue(prop);

	expect(value(".box", "padding-top")).toBe("3px");
	// A shorthand is invalid as a whole if any component is: neither the
	// good 1px nor the bad 2 survives.
	expect(value(".shorthand", "padding-top")).toBe("0px");
	expect(value(".shorthand", "padding-right")).toBe("0px");
	dom.dispose();
});

test("bare numbers stay valid where CSS says they are", async () => {
	// Zero needs no unit on any length, and the number-typed properties
	// take bare numbers by spec -- the check is per-property, not a
	// blanket ban on digits.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>
		.zero { padding-top: 0; margin: 0; }
		.numeric { line-height: 2; z-index: 5; flex-grow: 2; font-weight: 700; }
		.units { width: 50%; min-width: 10ch; max-width: 20px; margin: 0 auto; }
	</style>`;
	dom.document.body.innerHTML = `<div class="zero">Z</div><div class="numeric">N</div><div class="units">U</div>`;
	await nextFrame(dom);
	const value = (sel: string, prop: string) =>
		dom.window
			.getComputedStyle(dom.document.querySelector(sel)!)
			.getPropertyValue(prop);

	expect(value(".zero", "padding-top")).toBe("0px");
	expect(value(".numeric", "line-height")).toBe("2");
	expect(value(".numeric", "z-index")).toBe("5");
	expect(value(".numeric", "flex-grow")).toBe("2");
	expect(value(".numeric", "font-weight")).toBe("700");
	expect(value(".units", "width")).toBe("50%");
	expect(value(".units", "min-width")).toBe("10ch");
	expect(value(".units", "margin-left")).toBe("auto");
	dom.dispose();
});

test("min-width applies to ordinary block boxes", async () => {
	// A block container is a COLUMN flex container internally, so `width` is its
	// children's CROSS axis -- and the cross-axis path resolved a definite size
	// without clamping it, so min-width did nothing on most of a document.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>
		#narrow { width: 5ch; min-width: 20ch; }
		#wide { width: 30ch; max-width: 5ch; }
	</style>`;
	dom.document.body.innerHTML = `<div id="narrow">a</div><div id="wide">b</div>`;

	await nextFrame(dom);

	expect(
		dom.document.getElementById("narrow")!.getBoundingClientRect().width,
	).toBe(20);
	expect(
		dom.document.getElementById("wide")!.getBoundingClientRect().width,
	).toBe(5);

	dom.dispose();
});

test("the text-decoration longhand underlines, not just the shorthand", async () => {
	// text-decoration is a shorthand whose value lives in the longhands, so
	// `text-decoration-line: underline` leaves the shorthand computing to "none".
	const terminal = new MockProcess({cols: 20, rows: 3});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>#p { text-decoration-line: underline; }</style>`;
	dom.document.body.innerHTML = `<div id="p">abc</div>`;

	await nextFrame(dom);

	expect(/\x1b\[[^m]*4[;m]/.test(terminal.getStaticANSI())).toBe(true);

	dom.dispose();
});
