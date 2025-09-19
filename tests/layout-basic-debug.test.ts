import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils.js";

/**
 * Basic debug tests to isolate core layout issues revealed by stress tests
 */

/* eslint-disable no-console */
test("Simple static text rendering", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.textContent = "Hello World";
	termdom.document.body.appendChild(div);

	await termdom.render();

	// Debug the terminal buffer directly
	const buffer = (terminal as any).terminal.buffer.active;
	console.log("Terminal buffer rows:", buffer.length);
	for (let i = 0; i < Math.min(5, buffer.length); i++) {
		const line = buffer.getLine(i);
		if (line) {
			console.log(`Row ${i}:`, JSON.stringify(line.translateToString(true)));
		}
	}

	const output = terminal.getPlainText();
	console.log("getPlainText output:", JSON.stringify(output));

	expect(output).toContain("Hello World");
});

test("Simple innerHTML change", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Initial";
	termdom.document.body.appendChild(div);

	console.log("=== Initial render ===");
	await termdom.render();
	const initialOutput = terminal.getPlainText();
	console.log("Initial output:", JSON.stringify(initialOutput));

	// Change content
	div.innerHTML = "Changed";

	console.log("=== After innerHTML change ===");
	await termdom.render();
	const changedOutput = terminal.getPlainText();
	console.log("Changed output:", JSON.stringify(changedOutput));

	expect(changedOutput).toContain("Changed");
	expect(changedOutput).not.toContain("Initial");
});

test("Debug Yoga node creation for inline elements", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Text <span>span text</span> more";
	termdom.document.body.appendChild(div);

	try {
		await termdom.render();
		const output = terminal.getPlainText();
		console.log("Success - output:", JSON.stringify(output));
		expect(output).toContain("Text span text more");
	} catch (error) {
		console.log("Error during render:", (error as Error).message);
		console.log("Stack:", (error as Error).stack);
		// Re-throw to fail the test with detailed info
		throw error;
	}
});
