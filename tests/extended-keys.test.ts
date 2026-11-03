/**
 * A terminal that says it has the kitty keyboard protocol is asked for its
 * flags 1 and 4, so Escape arrives as CSI 27 u and keys with modifiers as
 * CSI u: Escape and then a key in one read are two keys, and Ctrl+Enter is
 * not Enter. tmux and xterm, which name themselves in XTVERSION, get
 * modifyOtherKeys. A terminal that says neither is asked for nothing, and
 * ESC and a key in one read stay Alt and the key.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {
	captureRawOutput,
	MockProcess,
	nextFrame,
	scriptReplies,
	until,
} from "./test-utils.js";

const DEVICE_ATTRIBUTES = {ask: "\x1b[c", reply: "\x1b[?1;2c"};
const FLAGS_QUERY = "\x1b[?u";
const KITTY_ON = "\x1b[=5;1u";
const KITTY_OFF = "\x1b[=0;1u";

interface Pressed {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

async function attach(
	answers: Array<{ask: string; reply: string | null}>,
	transport?: (terminal: MockProcess) => MockProcess["transport"],
): Promise<{dom: TermDOM; terminal: MockProcess; output: () => string}> {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const output = captureRawOutput(terminal);
	scriptReplies(terminal, [...answers, DEVICE_ATTRIBUTES]);
	const dom = new TermDOM({
		transport: transport?.(terminal) ?? terminal.transport,
	});
	dom.document.body.innerHTML = "<div>hi</div>";
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 50));
	return {dom, terminal, output};
}

async function press(
	dom: TermDOM,
	terminal: MockProcess,
	input: string,
): Promise<Pressed[]> {
	const events: Pressed[] = [];
	const listener = (event: KeyboardEvent) => {
		const {key, shiftKey, ctrlKey, altKey, metaKey} = event;
		events.push({key, shiftKey, ctrlKey, altKey, metaKey});
	};
	dom.document.addEventListener("keydown", listener);
	terminal.stdin.simulateResponse(input);
	await new Promise((resolve) => setTimeout(resolve, 20));
	dom.document.removeEventListener("keydown", listener);
	return events;
}

function pressed(key: string, modifiers: Partial<Pressed> = {}): Pressed {
	return {
		key,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		...modifiers,
	};
}

test("Escape and then Ctrl+N in one read are two keys once the protocol is engaged", async () => {
	const {dom, terminal, output} = await attach([
		{ask: FLAGS_QUERY, reply: "\x1b[?0u"},
	]);
	expect(output()).toContain(KITTY_ON);
	expect(await press(dom, terminal, "\x1b[27u\x0e")).toEqual([
		pressed("Escape"),
		pressed("n", {ctrlKey: true}),
	]);
	expect(await press(dom, terminal, "\x1b[27u\x1b[110;5u")).toEqual([
		pressed("Escape"),
		pressed("n", {ctrlKey: true}),
	]);
	const before = output().length;
	await dom.dispose();
	expect(output().slice(before)).toContain(KITTY_OFF);
});

test("a terminal that answers only DA1 is asked for nothing and keeps Alt", async () => {
	const {dom, terminal, output} = await attach([]);
	expect(await press(dom, terminal, "\x1b\x0e")).toEqual([
		pressed("n", {ctrlKey: true, altKey: true}),
	]);
	await dom.dispose();
	for (const sequence of ["\x1b[=", "\x1b[>1u", "\x1b[<u", "\x1b[>4"]) {
		expect(output()).not.toContain(sequence);
	}
});

test("flags a terminal already had are kept, and given back", async () => {
	const {dom, output} = await attach([{ask: FLAGS_QUERY, reply: "\x1b[?2u"}]);
	expect(output()).toContain("\x1b[=7;1u");
	await dom.dispose();
	expect(output()).toMatch(/\x1b\[=2;1u[^]*$/);
	expect(output()).not.toContain(KITTY_OFF);
});

test("CSI u keys decode with their modifiers", async () => {
	const {dom, terminal} = await attach([{ask: FLAGS_QUERY, reply: "\x1b[?0u"}]);
	const events = await press(
		dom,
		terminal,
		"\x1b[27;5u\x1b[97;3u\x1b[97;9u\x1b[97:65;6u\x1b[13;5u\x1b[13;2u" +
			"\x1b[9;5u\x1b[47:63;4u\x1b[47;4u\x1b[57400;5u\x1b[57376u\x1b[57441u",
	);
	expect(events).toEqual([
		pressed("Escape", {ctrlKey: true}),
		pressed("a", {altKey: true}),
		pressed("a", {metaKey: true}),
		pressed("A", {shiftKey: true, ctrlKey: true}),
		pressed("Enter", {ctrlKey: true}),
		pressed("Enter", {shiftKey: true}),
		pressed("Tab", {ctrlKey: true}),
		pressed("?", {shiftKey: true, altKey: true}),
		pressed("/", {shiftKey: true, altKey: true}),
		pressed("1", {ctrlKey: true}),
		pressed("F13"),
		pressed("Unidentified"),
	]);
	await dom.dispose();
});

test("tmux and xterm are asked for modifyOtherKeys", async () => {
	for (const name of ["tmux 3.6b", "XTerm(390)"]) {
		const {dom, terminal, output} = await attach([
			{ask: "\x1b[>0q", reply: `\x1bP>|${name}\x1b\\`},
		]);
		expect(output()).toContain("\x1b[>4;1m");
		expect(output()).not.toContain("\x1b[=");
		expect(await press(dom, terminal, "\x1b[27;5;13~")).toEqual([
			pressed("Enter", {ctrlKey: true}),
		]);
		await dom.dispose();
		expect(output()).toMatch(/\x1b\[>4m[^]*$/);
	}
});

test("suspending gives the flags back and resuming asks again", async () => {
	let resume!: () => void;
	let suspends = 0;
	const {dom, terminal, output} = await attach(
		[{ask: FLAGS_QUERY, reply: "\x1b[?0u"}],
		(terminal) => ({
			...terminal.transport,
			cols: terminal.transport.cols,
			rows: terminal.transport.rows,
			suspend: () => {
				suspends++;
				return new Promise<void>((resolve) => (resume = resolve));
			},
		}),
	);
	const before = output().length;
	terminal.stdin.simulateResponse("\x1b[122;5u");
	await until(() => suspends === 1);
	expect(output().slice(before)).toContain(KITTY_OFF);
	expect(output().slice(before)).not.toContain(KITTY_ON);
	const resumedAt = output().length;
	resume();
	await until(() => output().slice(resumedAt).includes(KITTY_ON));
	expect(output().slice(resumedAt)).toContain(KITTY_ON);
	await dom.dispose();
});

test("the alternate screen gets the flags, and both screens get them back", async () => {
	const {dom, output} = await attach([{ask: FLAGS_QUERY, reply: "\x1b[?0u"}]);
	const before = output().length;
	await dom.document.documentElement.requestFullscreen();
	await nextFrame(dom);
	const entry = output().slice(before);
	expect(entry.indexOf(KITTY_ON, entry.indexOf("\x1b[?1049h"))).not.toBe(-1);
	const disposedAt = output().length;
	await dom.dispose();
	const teardown = output().slice(disposedAt);
	const leave = teardown.indexOf("\x1b[?1049l");
	expect(leave).not.toBe(-1);
	expect(teardown.lastIndexOf(KITTY_OFF, leave)).not.toBe(-1);
	expect(teardown.indexOf(KITTY_OFF, leave)).not.toBe(-1);
	expect(teardown).not.toContain(KITTY_ON);
});

test("the panic restore gives the flags back", async () => {
	const {dom, output} = await attach([{ask: FLAGS_QUERY, reply: "\x1b[?0u"}]);
	const before = output().length;
	const handlers = process.listeners("uncaughtException");
	process.removeAllListeners("uncaughtException");
	try {
		process.emit(
			"uncaughtExceptionMonitor",
			new Error("unhandled"),
			"uncaughtException",
		);
	} finally {
		for (const handler of handlers) {
			process.on("uncaughtException", handler);
		}
	}
	const panic = output().slice(before);
	const leave = panic.indexOf("\x1b[?1047l");
	expect(leave).not.toBe(-1);
	expect(panic.lastIndexOf(KITTY_OFF, leave)).not.toBe(-1);
	expect(panic.indexOf(KITTY_OFF, leave)).not.toBe(-1);
	await dom.dispose();
});

test("the panic restore writes no flags for a terminal that never had them", async () => {
	const {dom, output} = await attach([]);
	const before = output().length;
	const handlers = process.listeners("uncaughtException");
	process.removeAllListeners("uncaughtException");
	try {
		process.emit(
			"uncaughtExceptionMonitor",
			new Error("unhandled"),
			"uncaughtException",
		);
	} finally {
		for (const handler of handlers) {
			process.on("uncaughtException", handler);
		}
	}
	expect(output().slice(before)).toContain("\x1b[?1047l");
	expect(output().slice(before)).not.toContain("\x1b[=");
	await dom.dispose();
});
