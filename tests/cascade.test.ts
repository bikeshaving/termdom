import {test, expect, describe} from "@b9g/libuild/test";
import {StyleManager} from "../src/internal/cascade.js";
import {LayoutEngine} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
import {createDocumentWindow} from "../src/internal/termdom.js";
import {CSS_SHORTHANDS} from "../src/internal/cssproperties.js";

/** A document of this DOM, from markup, displayed in a window of its own. */
function documentWindow(html: string): {
	window: ReturnType<typeof createDocumentWindow>;
} {
	return {window: createDocumentWindow(html)};
}

describe("getComputedStyle - What We Support", () => {
	test("CSS spec defaults", () => {
		const dom = documentWindow(
			"<!DOCTYPE html><html><body><div id=\"test\"></div></body></html>",
		);
		const styleManager = new StyleManager(dom.window);
		const layoutEngine = new LayoutEngine(dom.window);
		styleManager.setLayoutEngine(layoutEngine);
		const element = dom.window.document.getElementById("test")!;
		const styles = dom.window.getComputedStyle(element);

		// Test basic CSS spec defaults (computed values)
		expect(styles.getPropertyValue("margin")).toBe("0px");
		expect(styles.getPropertyValue("padding")).toBe("0px");
		expect(styles.getPropertyValue("border-width")).toBe("0px");
		expect(styles.getPropertyValue("border-style")).toBe("none");
		expect(styles.getPropertyValue("background-color")).toBe(
			"rgba(0, 0, 0, 0)",
		);
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 0)");
		expect(styles.getPropertyValue("font-size")).toBe("1px");
		expect(styles.getPropertyValue("white-space")).toBe("normal");
		expect(styles.getPropertyValue("position")).toBe("static");
		expect(styles.getPropertyValue("width")).toBe("auto");
		expect(styles.getPropertyValue("height")).toBe("auto");
	});

	test("terminal element defaults", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		).toBe("4px");
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
		const dom = documentWindow(`<!DOCTYPE html>
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

		expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
		expect(styles.getPropertyValue("margin")).toBe("10px");
		expect(styles.getPropertyValue("display")).toBe("flex");
		// Non-specified properties should still use defaults
		expect(styles.getPropertyValue("padding")).toBe("0px");
	});

	test("CSS keywords - initial", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("margin")).toBe("0px");
	});

	test("CSS keywords - unset, revert, revert-layer", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("margin")).toBe("0px");
		expect(styles.getPropertyValue("padding")).toBe("0px");
	});

	test.todo("property inheritance", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(childStyles.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
		expect(childStyles.getPropertyValue("font-size")).toBe("16px");
		// Non-inherited properties should use their own defaults
		expect(childStyles.getPropertyValue("margin")).toBe("0px");

		const childWithInherit =
			dom.window.document.getElementById("child-with-inherit")!;
		const childWithInheritStyles =
			dom.window.getComputedStyle(childWithInherit);

		// Explicit inherit should work
		expect(childWithInheritStyles.getPropertyValue("color")).toBe(
			"rgb(0, 0, 255)",
		);
		expect(childWithInheritStyles.getPropertyValue("font-size")).toBe("16px");
	});

	test("CSSStyleDeclaration interface compatibility", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
		expect(styles.getPropertyValue("margin")).toBe("10px");
	});

	test("box model properties", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("border")).toBe("2px solid rgb(0, 0, 0)");
		expect(styles.getPropertyValue("width")).toBe("100px");
		expect(styles.getPropertyValue("height")).toBe("50px");
	});
});

describe("getComputedStyle - What We Don't Support (Failing Tests)", () => {
	test.todo("CSS specificity calculation", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(255, 255, 0)");

		// Without inline style, ID should win
		element.style.removeProperty("color");
		expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");

		// Without ID, class should win
		element.removeAttribute("id");
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

		// Without class, element selector should win
		element.removeAttribute("class");
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 128, 0)");
	});

	test.todo("stylesheet parsing from <style> elements", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
		expect(styles.getPropertyValue("margin")).toBe("20px");
		expect(styles.getPropertyValue("font-size")).toBe("14px");
		expect(styles.getPropertyValue("padding")).toBe("10px");
		expect(styles.getPropertyValue("background-color")).toBe("#f0f0f0");
	});

	test.todo("multiple stylesheets with cascade resolution", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
		// Properties from both should apply
		expect(styles.getPropertyValue("font-size")).toBe("12px");
		expect(styles.getPropertyValue("margin")).toBe("10px");
	});

	test.todo("!important declarations", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
	});

	test.todo("complex selectors", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
			"rgb(255, 0, 0)",
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
		const dom = documentWindow(`<!DOCTYPE html>
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
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("margin")).toBe("10px 20px");
		expect(styles.getPropertyValue("padding")).toBe("5px 15px 25px");
	});

	test.todo("shorthand property expansion - border and background", () => {
		// TODO: Implement border and background shorthand expansion
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("border-color")).toBe("rgb(255, 0, 0)");

		expect(styles.getPropertyValue("background-color")).toBe("#fff");
		expect(styles.getPropertyValue("background-image")).toBe("url(bg.png)");
		expect(styles.getPropertyValue("background-repeat")).toBe("no-repeat");
		expect(styles.getPropertyValue("background-position")).toBe("center");
	});

	test.todo("CSS media queries", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
	});

	test.todo("CSS custom properties (CSS variables)", () => {
		const dom = documentWindow(`<!DOCTYPE html>
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
		expect(styles.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
		expect(styles.getPropertyValue("margin")).toBe("20px");

		// Should also expose custom properties themselves
		expect(styles.getPropertyValue("--primary-color")).toBe("rgb(0, 0, 255)");
		expect(styles.getPropertyValue("--spacing")).toBe("20px");
	});
});

test("a nonzero length without a unit is invalid and never enters the cascade", async () => {
	// Browsers reject the declaration at parse time, so a lower-priority
	// rule still wins. Coercing to 0 instead would let the bad declaration
	// beat the good one -- which is what this engine used to do, and what
	// silently killed `padding-top: 1` in the examples.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		.box { padding-top: 3px; }
		.box { padding-top: 1; }
		.shorthand { padding: 1px 2; }
	</style>`;
	dom.document.body.innerHTML = "<div class=\"box\">B</div><div class=\"shorthand\">S</div>";
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

test("a corner radius computes to a length pair and does not inherit", async () => {
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		.cells { border-radius: 2ch; }
		.ellipse { border-radius: 1px 2px / 3px 4px; }
		.percent { border-radius: 50%; }
		.reset { border-radius: 4px; border-radius: 0; }
	</style>`;
	dom.document.body.innerHTML = `<div class="cells">C<span class="child">K</span></div>
		<div class="ellipse">E</div><div class="percent">P</div><div class="reset">R</div>`;
	await nextFrame(dom);
	const value = (sel: string, prop: string) =>
		dom.window
			.getComputedStyle(dom.document.querySelector(sel)!)
			.getPropertyValue(prop);

	// A cell is the terminal's unit of width, so a radius in ch computes to
	// that many px like any other length.
	expect(value(".cells", "border-top-left-radius")).toBe("2px");
	expect(value(".cells", "border-radius")).toBe("2px");
	// Radii are not inherited properties.
	expect(value(".child", "border-top-left-radius")).toBe("0px");

	// An elliptical corner keeps both radii, horizontal first.
	expect(value(".ellipse", "border-top-left-radius")).toBe("1px 3px");
	expect(value(".ellipse", "border-top-right-radius")).toBe("2px 4px");
	// Two values name one diagonal each: bottom-right repeats top-left.
	expect(value(".ellipse", "border-bottom-right-radius")).toBe("1px 3px");
	expect(value(".ellipse", "border-bottom-left-radius")).toBe("2px 4px");
	expect(value(".ellipse", "border-radius")).toBe("1px 2px / 3px 4px");

	// A percentage resolves against the box when something uses it, so it
	// computes as written.
	expect(value(".percent", "border-top-right-radius")).toBe("50%");
	expect(value(".percent", "border-radius")).toBe("50%");

	expect(value(".reset", "border-radius")).toBe("0px");
	dom.dispose();
});

test("bare numbers stay valid where CSS says they are", async () => {
	// Zero needs no unit on any length, and the number-typed properties
	// take bare numbers by spec -- the check is per-property, not a
	// blanket ban on digits.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		.zero { padding-top: 0; margin: 0; }
		.numeric { line-height: 2; z-index: 5; flex-grow: 2; font-weight: 700; }
		.units { width: 50%; min-width: 10ch; max-width: 20px; margin: 0 auto; }
	</style>`;
	dom.document.body.innerHTML = "<div class=\"zero\">Z</div><div class=\"numeric\">N</div><div class=\"units\">U</div>";
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
	// width and margin are resolved-value properties: a rendered box reports
	// the used length, which is how these units prove they were accepted.
	expect(value(".units", "width")).toBe("15px");
	expect(value(".units", "min-width")).toBe("10px");
	// `margin: 0 auto` centres the box, and the used margin says by how much.
	expect(value(".units", "margin-left")).toMatch(/^\d+(\.\d+)?px$/);
	dom.dispose();
});

test("min-width applies to ordinary block boxes", async () => {
	// A block container is a COLUMN flex container internally, so `width` is its
	// children's CROSS axis -- and the cross-axis path resolved a definite size
	// without clamping it, so min-width did nothing on most of a document.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		#narrow { width: 5ch; min-width: 20ch; }
		#wide { width: 30ch; max-width: 5ch; }
	</style>`;
	dom.document.body.innerHTML = "<div id=\"narrow\">a</div><div id=\"wide\">b</div>";

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
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = "<style>#p { text-decoration-line: underline; }</style>";
	dom.document.body.innerHTML = "<div id=\"p\">abc</div>";

	await nextFrame(dom);

	expect(/\x1b\[[^m]*4[;m]/.test(terminal.getStaticANSI())).toBe(true);

	dom.dispose();
});

// ---- Inline border:none ----
//
// `none` and `hidden` are declarations like any other: element.style stores
// them, and the cascade sees them. A border keyword that went unstored would
// resurrect whatever sits below it in the cascade, so an author could never
// turn OFF a UA border from element.style.

test("style.border = 'none' overrides the UA textarea border", async () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const textarea = dom.document.createElement("textarea");
	textarea.setAttribute("rows", "1");
	textarea.style.border = "none";
	textarea.style.padding = "0";
	dom.document.body.appendChild(textarea);
	await nextFrame(dom);

	const computed = dom.window.getComputedStyle(textarea);
	expect(computed.getPropertyValue("border-top-style")).toBe("none");
	expect(textarea.getBoundingClientRect().height).toBe(1);
	dom.dispose();
});

test("setProperty and cssText forms of border:none work too", async () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const a = dom.document.createElement("textarea");
	a.setAttribute("rows", "1");
	a.style.setProperty("border", "none");
	a.style.setProperty("padding", "0");
	const b = dom.document.createElement("textarea");
	b.setAttribute("rows", "1");
	b.style.cssText = "border: none; padding: 0";
	dom.document.body.append(a, b);
	await nextFrame(dom);

	expect(a.getBoundingClientRect().height).toBe(1);
	expect(b.getBoundingClientRect().height).toBe(1);
	dom.dispose();
});

test("a border style of none zeroes the USED border width", async () => {
	// css-backgrounds §3.3: computed border-width is 0 when the style is none
	// or hidden -- the box reserves no space however wide the width says.
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = "<style>#box { border: 2px solid; border-style: none; width: 10px; }</style>";
	dom.document.body.innerHTML = "<div id=\"box\">x</div>";
	await nextFrame(dom);

	const box = dom.document.getElementById("box")!;
	expect(box.clientWidth).toBe(10);
	expect(box.getBoundingClientRect().height).toBe(1);
	dom.dispose();
});

test("a single side turns off: style.borderTop = 'none'", async () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const textarea = dom.document.createElement("textarea");
	textarea.setAttribute("rows", "1");
	textarea.style.borderTop = "none";
	dom.document.body.appendChild(textarea);
	await nextFrame(dom);

	// Bottom border survives; the top border row is gone: 1 content + 1 border.
	expect(textarea.getBoundingClientRect().height).toBe(2);
	dom.dispose();
});

test("style.background = 'none' overrides a stylesheet background", async () => {
	// `background: none` declares image none and color transparent, both of
	// which have to reach the cascade to beat a class background.
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = "<style>.paint { background: red; }</style>";
	dom.document.body.innerHTML = "<div class=\"paint\" id=\"box\" style=\"background: none\">x</div>";
	await nextFrame(dom);

	const computed = dom.window.getComputedStyle(
		dom.document.getElementById("box")!,
	);
	expect(computed.getPropertyValue("background-color")).toBe(
		"rgba(0, 0, 0, 0)",
	);
	const cell = (terminal as any).terminal.buffer.active.getLine(0).getCell(0);
	expect(cell.isBgDefault()).toBeTruthy();
	dom.dispose();
});

test("toggling border none -> solid -> none through element.style survives", async () => {
	// A later set overwrites the declaration in place, and a return to none
	// erases the border again.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const el = dom.document.createElement("div");
	el.textContent = "x";
	dom.document.body.appendChild(el);
	const computed = () =>
		dom.window.getComputedStyle(el).getPropertyValue("border-top-style");

	el.style.border = "none";
	await nextFrame(dom);
	expect(computed()).toBe("none");

	el.style.border = "1px solid red";
	await nextFrame(dom);
	expect(computed()).toBe("solid");
	expect(el.getBoundingClientRect().height).toBe(3);

	el.style.border = "none";
	await nextFrame(dom);
	expect(computed()).toBe("none");
	expect(el.getBoundingClientRect().height).toBe(1);
	dom.dispose();
});

test("an inline shorthand's !important carries to its longhands", async () => {
	// setProperty records a priority under the SHORTHAND key while the cascade
	// resolves longhands, so the covering shorthand's priority has to carry
	// onto every longhand it declares.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		#a { border: 2px solid !important; }
		#b { margin-top: 5px !important; }
	</style>`;
	dom.document.body.innerHTML = "<div id=\"a\">x</div><div id=\"b\">y</div>";
	const a = dom.document.getElementById("a")!;
	const b = dom.document.getElementById("b")!;
	(a as HTMLElement).style.setProperty("border", "none", "important");
	(b as HTMLElement).style.setProperty("margin", "1px", "important");
	await nextFrame(dom);

	// Inline !important beats stylesheet !important, shorthand or not.
	expect(
		dom.window.getComputedStyle(a).getPropertyValue("border-top-style"),
	).toBe("none");
	expect(a.getBoundingClientRect().height).toBe(1);
	expect(dom.window.getComputedStyle(b).getPropertyValue("margin-top")).toBe(
		"1px",
	);
	dom.dispose();
});

test("border: solid means a visible medium border, sheet and inline alike", async () => {
	// A style keyword with no width leaves the width at its initial, medium
	// -- which is a real, visible border (one cell; the grid cannot grade
	// thin/medium/thick). The stylesheet and inline paths must agree on it.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = "<style>#sheet { border: solid; }</style>";
	dom.document.body.innerHTML = "<div id=\"sheet\">a</div><div id=\"inline\" style=\"border: solid\">b</div>";
	await nextFrame(dom);

	for (const id of ["sheet", "inline"]) {
		const el = dom.document.getElementById(id)!;
		expect(el.getBoundingClientRect().height).toBe(3);
	}
	expect(terminal.getVisibleText()).toContain("┌");
	dom.dispose();
});

// ---- element.style and the style attribute ----

test("a property write reflects into the attribute and repaints", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const el = dom.document.createElement("div");
	el.textContent = "text";
	dom.document.body.appendChild(el);
	await nextFrame(dom);
	expect(terminal.getScreenContents()).not.toMatch(/\x1b\[38;2;255;0;0/);

	// The attribute is the store: serializing to it is what produces the
	// mutation record invalidation listens for.
	el.style.color = "red";
	expect(el.getAttribute("style")).toBe("color: red;");
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toMatch(/\x1b\[38;2;255;0;0/);
	dom.dispose();
});

test("writing the attribute reparses into element.style", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const el = dom.document.createElement("div");
	dom.document.body.appendChild(el);

	el.setAttribute(
		"style",
		"color: blue; border: 1px solid red; padding: 0 !important",
	);
	expect(el.style.color).toBe("blue");
	// A shorthand is stored as the longhands it declares: one color, twelve
	// border longhands, the five border-image longhands `border` also resets,
	// four paddings.
	expect(el.style.length).toBe(22);
	expect(el.style.item(1)).toBe("border-top-width");
	expect(el.style.getPropertyPriority("padding")).toBe("important");
	expect(el.style.getPropertyValue("border-top-style")).toBe("solid");
	// A shorthand reads back reconstructed from those longhands.
	expect(el.style.getPropertyValue("border")).toBe("1px solid red");
	expect(el.style.getPropertyValue("padding")).toBe("0");

	el.style.removeProperty("border");
	expect(el.getAttribute("style")).toBe("color: blue; padding: 0 !important;");

	el.removeAttribute("style");
	expect(el.style.length).toBe(0);
	expect(el.style.color).toBe("");

	el.style.cssText = "display: flex";
	expect(el.getAttribute("style")).toBe("display: flex;");
	expect(dom.window.getComputedStyle(el).getPropertyValue("display")).toBe(
		"flex",
	);
	dom.dispose();
});

test("a viewport-relative length re-resolves when the terminal resizes", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const div = dom.document.createElement("div");
	div.style.width = "50vw";
	div.textContent = "x";
	dom.document.body.appendChild(div);
	await nextFrame(dom);

	// A style an author holds is live across the resize, like any other.
	const held = dom.window.getComputedStyle(div);
	expect(held.width).toBe("20px");
	expect(div.getBoundingClientRect().width).toBe(20);

	terminal.resize(80, 10);
	(terminal as any).emit("SIGWINCH");
	const deadline = Date.now() + 2000;
	while (dom.window.innerWidth !== 80 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	await nextFrame(dom);

	expect(dom.window.innerWidth).toBe(80);
	expect(held.width).toBe("40px");
	expect(dom.window.getComputedStyle(div).width).toBe("40px");
	expect(div.getBoundingClientRect().width).toBe(40);

	dom.dispose();
});

test("an author's shorthand read does not poison the computed value", async () => {
	// getComputedStyle().margin answers with USED values; the engine's own
	// computedValueOf answers with computed ones. The two must not share an
	// answer.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const div = dom.document.createElement("div");
	div.style.margin = "50%";
	div.textContent = "x";
	dom.document.body.appendChild(div);
	await nextFrame(dom);

	const declaration = dom.window.getComputedStyle(div) as any;
	// The author's read resolves the percentage against the containing block.
	expect(declaration.margin).toBe("20px");
	// The engine's read still answers what the cascade said.
	expect(declaration.computedValueOf("margin")).toBe("50%");
	expect(declaration.computedValueOf("margin-top")).toBe("50%");

	dom.dispose();
});

/**
 * A value for every shorthand `expandShorthands` decomposes, chosen to state
 * something on each longhand the grammar names.
 */
const EXPANDED_SHORTHANDS: Record<string, string> = {
	"background": "red",
	"border": "1px solid red",
	"border-block": "1px solid red",
	"border-block-color": "red blue",
	"border-block-end": "1px solid red",
	"border-block-start": "1px solid red",
	"border-block-style": "solid dashed",
	"border-block-width": "1px 2px",
	"border-bottom": "1px solid red",
	"border-color": "red",
	"border-image": "none",
	"border-inline": "1px solid red",
	"border-inline-color": "red blue",
	"border-inline-end": "1px solid red",
	"border-inline-start": "1px solid red",
	"border-inline-style": "solid dashed",
	"border-inline-width": "1px 2px",
	"border-left": "1px solid red",
	"border-radius": "1ch",
	"border-right": "1px solid red",
	"border-style": "solid",
	"border-top": "1px solid red",
	"border-width": "1px",
	"flex": "1 1 auto",
	"flex-flow": "column wrap",
	"gap": "1px 2ch",
	"inset": "1px 2ch",
	"inset-block": "1px 2px",
	"inset-inline": "1ch 2ch",
	"list-style": "square inside",
	"margin": "1px 2ch",
	"margin-block": "1px 2px",
	"margin-inline": "1ch 2ch",
	"outline": "1px solid red",
	"overflow": "hidden scroll",
	"padding": "1px 2ch",
	"padding-block": "1px 2px",
	"padding-inline": "1ch 2ch",
	"grid": "auto-flow dense 4px / 1fr 1fr",
	"grid-area": "hero / 1 / span 2 / -1",
	"grid-column": "2 / span 3",
	"grid-gap": "1px 2ch",
	"grid-row": "main",
	"grid-template": '"a b" 2px "c d" 3px / 1fr 2fr',
	"place-content": "space-between center",
	"place-items": "center start",
	"place-self": "center start",
	"text-decoration": "underline",
	"transition": "left 2s ease-in 0.5s, color 1s",
};

/**
 * The shorthands that reach the cascade whole, each with what it is waiting
 * for. A shorthand here declares nothing to its longhands: an author writing
 * one gets the declaration back from CSSOM and no rendering from it.
 */
const UNEXPANDED_SHORTHANDS: Record<string, string> = {
	"-webkit-border-after": "vendor alias for border-block-end",
	"-webkit-border-before": "vendor alias for border-block-start",
	"-webkit-border-end": "vendor alias for border-inline-end",
	"-webkit-border-start": "vendor alias for border-inline-start",
	"-webkit-mask": "vendor alias for mask, which needs pixels",
	"-webkit-text-stroke": "glyph outlines, which the emulator owns",
	"all": "stands for every property there is; the cascade reads it directly",
	"animation": "no animation clock",
	"animation-range": "no animation clock",
	"background-position": "an image to position, which needs pixels",
	"caret": "the caret is the terminal's own cursor",
	"column-rule": "multi-column layout",
	"columns": "multi-column layout",
	"contain-intrinsic-size": "containment",
	"container": "container queries",
	"corner-block-end-shape": "corner shapes are finer than a cell",
	"corner-block-start-shape": "corner shapes are finer than a cell",
	"corner-bottom-shape": "corner shapes are finer than a cell",
	"corner-inline-end-shape": "corner shapes are finer than a cell",
	"corner-inline-start-shape": "corner shapes are finer than a cell",
	"corner-left-shape": "corner shapes are finer than a cell",
	"corner-right-shape": "corner shapes are finer than a cell",
	"corner-shape": "corner shapes are finer than a cell",
	"corner-top-shape": "corner shapes are finer than a cell",
	"font": "system font keywords and a line-height the grid fixes",
	"interest-delay": "no interest timers",
	"mask": "masking, which needs pixels",
	"mask-border": "masking, which needs pixels",
	"offset": "motion paths, which need sub-cell geometry",
	"overscroll-behavior": "overscroll behavior",
	"position-try": "anchor positioning",
	"scroll-margin": "scroll snapping",
	"scroll-margin-block": "scroll snapping",
	"scroll-margin-inline": "scroll snapping",
	"scroll-padding": "scroll snapping",
	"scroll-padding-block": "scroll snapping",
	"scroll-padding-inline": "scroll snapping",
	"scroll-timeline": "scroll-driven animations",
	"text-emphasis": "emphasis marks are finer than a cell",
	"text-wrap": "text-wrap-style, its second half",
	"timeline-trigger": "no animation clock",
	"timeline-trigger-activation-range": "no animation clock",
	"timeline-trigger-active-range": "no animation clock",
	"view-timeline": "scroll-driven animations",
};

test("every CSS shorthand is expanded or listed as unexpanded", () => {
	// The property table is generated from mdn-data, so a shorthand the
	// platform adds arrives here on its own. It is handled or it is named --
	// and either way somebody looked at it.
	const probe = createDocumentWindow(
		"<div></div>",
	).document.querySelector("div")!;
	for (const shorthand of Object.keys(CSS_SHORTHANDS)) {
		const expanded = shorthand in EXPANDED_SHORTHANDS;
		const unexpanded = shorthand in UNEXPANDED_SHORTHANDS;
		expect(`${shorthand}: ${expanded !== unexpanded}`).toBe(
			`${shorthand}: true`,
		);
		if (!expanded) {
			continue;
		}
		const value = EXPANDED_SHORTHANDS[shorthand];
		// The public face of expansion: a shorthand set on a declaration
		// enumerates as the longhands it declared.
		probe.setAttribute("style", `${shorthand}: ${value}`);
		const longhands = Array.from(
			probe.style as unknown as Iterable<string>,
		).filter((name) => name !== shorthand);
		expect(`${shorthand} -> ${longhands.length > 0}`).toBe(
			`${shorthand} -> true`,
		);
		for (const longhand of longhands) {
			expect(`${shorthand} declares ${longhand}`).toBe(
				`${shorthand} declares ${
					CSS_SHORTHANDS[shorthand].includes(longhand) ? longhand : "?"
				}`,
			);
		}
	}
	for (const shorthand of Object.keys(UNEXPANDED_SHORTHANDS)) {
		expect(`${shorthand} is a shorthand: ${shorthand in CSS_SHORTHANDS}`).toBe(
			`${shorthand} is a shorthand: true`,
		);
	}
});
