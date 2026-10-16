/**
 * The caret of a focused text control is the terminal's own cursor, and
 * caret-shape, caret-animation and caret-color choose how the terminal
 * draws it: DECSCUSR for the shape and blinking, OSC 12 for the color.
 * Each is written when it changes, and reset when the session ends only
 * if it was ever set, since a reset takes back what the shell set.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

interface FocusedInput {
	dom: TermDOM;
	terminal: MockProcess;
	input: HTMLInputElement;
	output: () => string;
}

// The cursor's style goes out after the frame that placed the caret, so
// a test waits for the bytes it names.
async function written(output: () => string, part: string): Promise<string> {
	await until(() => output().includes(part));
	return output();
}

async function focusInput(css: string): Promise<FocusedInput> {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const output = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<style>${css}</style><input id="i">`;
	dom.attach();
	const input = dom.document.getElementById("i") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);
	return {dom, terminal, input, output};
}

function count(text: string, part: string): number {
	return text.split(part).length - 1;
}

test("caret-shape picks the cursor style, and caret-animation: manual holds it steady", async () => {
	const cases: Array<[string, string, number]> = [
		["block", "auto", 1],
		["block", "manual", 2],
		["underscore", "auto", 3],
		["underscore", "manual", 4],
		["bar", "auto", 5],
		["bar", "manual", 6],
	];
	for (const [shape, animation, style] of cases) {
		const {dom, output} = await focusInput(
			`input { caret-shape: ${shape}; caret-animation: ${animation} }`,
		);
		expect(await written(output, `\x1b[${style} q`)).toContain(
			`\x1b[${style} q`,
		);
		await dom.dispose();
	}
});

test("an auto caret leaves the terminal's cursor alone, and resets nothing", async () => {
	const {dom, output} = await focusInput("");
	await dom.dispose();
	expect(output()).not.toMatch(/\x1b\[\d q/);
	expect(output()).not.toContain("\x1b]12;");
	expect(output()).not.toContain("\x1b]112");
});

test("the cursor style is written once, and reset as the session ends", async () => {
	const {dom, terminal, input, output} =
		await focusInput("input { caret-shape: block }");
	await written(output, "\x1b[1 q");
	for (const key of "abc") {
		terminal.stdin.simulateResponse(key);
		await nextFrame(dom);
	}
	expect(input.value).toBe("abc");
	expect(count(output(), "\x1b[1 q")).toBe(1);
	void dom.dispose();
	expect(output()).toContain("\x1b[0 q");
});

test("a restyle of the focused control switches the cursor style", async () => {
	const {dom, input, output} = await focusInput(
		"input { caret-shape: block } input.insert { caret-shape: bar }",
	);
	await written(output, "\x1b[1 q");
	input.classList.add("insert");
	await nextFrame(dom);
	expect(await written(output, "\x1b[5 q")).toContain("\x1b[5 q");
	await dom.dispose();
});

test("caret-color colors the cursor, and is reset as the session ends", async () => {
	const {dom, output} = await focusInput("input { caret-color: red }");
	expect(await written(output, "\x1b]12;")).toContain(
		"\x1b]12;rgb:ff/00/00\x07",
	);
	void dom.dispose();
	expect(output()).toContain("\x1b]112\x07");
});

test("a suspended session hands the cursor's style back, and sets it again", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const output = captureRawOutput(terminal);
	let resume!: () => void;
	let suspended = false;
	const dom = new TermDOM({
		transport: {
			...terminal.transport,
			cols: terminal.transport.cols,
			rows: terminal.transport.rows,
			suspend: () => {
				suspended = true;
				return new Promise<void>((resolve) => {
					resume = resolve;
				});
			},
		},
	});
	dom.document.body.innerHTML =
		"<style>input { caret-shape: bar }</style><input id=\"i\">";
	dom.attach();
	(dom.document.getElementById("i") as HTMLInputElement).focus();
	await nextFrame(dom);
	await written(output, "\x1b[5 q");
	const before = output().length;
	terminal.stdin.simulateResponse("\x1a");
	await until(() => suspended);
	expect(await written(output, "\x1b[0 q")).toContain("\x1b[0 q");
	const resumedAt = output().length;
	expect(resumedAt).toBeGreaterThan(before);
	resume();
	await until(() => output().slice(resumedAt).includes("\x1b[5 q"));
	expect(output().slice(resumedAt)).toContain("\x1b[5 q");
	await dom.dispose();
});
