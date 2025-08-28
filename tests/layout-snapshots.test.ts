/**
 * Visual Layout Snapshot Tests
 *
 * Tests that capture the actual rendered output of layout scenarios
 * to ensure visual consistency across changes.
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {TestTerminal} from "./test-utils.js";

test("simple text layout", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 20});
	const dom = new TermDOM({process: terminal, width: 40, height: 20});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);

	await dom.waitForRender();
	const snapshot = terminal.getScreenContents();

	// Bun snapshot for test assertion
	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("flex column layout", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 20});
	const dom = new TermDOM({process: terminal, width: 40, height: 20});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.gap = "1ch";

	const item1 = document.createElement("div");
	item1.textContent = "Item 1";
	item1.style.backgroundColor = "blue";
	item1.style.color = "white";

	const item2 = document.createElement("div");
	item2.textContent = "Item 2";
	item2.style.backgroundColor = "red";
	item2.style.color = "white";

	container.appendChild(item1);
	container.appendChild(item2);
	document.body.appendChild(container);

	await dom.waitForRender();
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("text wrapping layout", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 20});
	const dom = new TermDOM({process: terminal, width: 40, height: 20});
	const {document} = dom;

	const div = document.createElement("div");
	div.style.width = "20ch";
	div.textContent =
		"This is a long line of text that should wrap across multiple lines when the container is too narrow";
	document.body.appendChild(div);

	await dom.waitForRender();
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("nested containers layout", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 20});
	const dom = new TermDOM({process: terminal, width: 40, height: 20});
	const {document} = dom;

	const outer = document.createElement("div");
	outer.style.border = "1px solid white";
	outer.style.padding = "2ch";

	const inner = document.createElement("div");
	inner.style.backgroundColor = "green";
	inner.style.color = "black";
	inner.style.padding = "1ch";
	inner.textContent = "Nested content";

	outer.appendChild(inner);
	document.body.appendChild(outer);

	await dom.waitForRender();
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});
