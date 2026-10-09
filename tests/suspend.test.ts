/**
 * Ctrl+Z suspends the program as a shell's job control does: the engine
 * hands the terminal back, the transport stops the process until the shell
 * continues it, and the engine takes the terminal again. The document is
 * hidden meanwhile. Where the transport cannot suspend, Ctrl+Z is a key.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

const CTRL_Z = "\x1a";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

test("Ctrl+Z hands the terminal back, suspends, and takes it again", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const written = captureRawOutput(terminal);
	let resume!: () => void;
	let suspends = 0;
	const transport = {
		...terminal.transport,
		cols: terminal.transport.cols,
		rows: terminal.transport.rows,
		suspend: () => {
			suspends++;
			return new Promise<void>((resolve) => {
				resume = resolve;
			});
		},
	};
	const dom = new TermDOM({transport});
	const {document} = dom;
	document.body.innerHTML = "<p>work in progress</p>";
	await dom.attach();
	await nextFrame(dom);
	const states: string[] = [];
	document.addEventListener("visibilitychange", () => {
		states.push(document.visibilityState);
	});
	const before = written().length;

	terminal.stdin.simulateResponse(CTRL_Z);
	await until(() => suspends === 1);
	expect(document.visibilityState).toBe("hidden");
	const handedBack = written().slice(before);
	expect(handedBack).toContain(PASTE_OFF);
	expect(handedBack).toContain("work in progress");
	const resumedAt = written().length;

	resume();
	await until(() => document.visibilityState === "visible");
	await until(() => written().slice(resumedAt).includes("work in progress"));
	expect(written().slice(resumedAt)).toContain(PASTE_ON);
	expect(states).toEqual(["hidden", "visible"]);
	await dom.dispose();
});

test("Ctrl+Z is an ordinary key where the transport cannot suspend", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const transport = {
		...terminal.transport,
		cols: terminal.transport.cols,
		rows: terminal.transport.rows,
		suspend: undefined,
	};
	const dom = new TermDOM({transport});
	await dom.attach();
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		const key = event as KeyboardEvent;
		keys.push(`${key.ctrlKey ? "ctrl+" : ""}${key.key}`);
	});
	terminal.stdin.simulateResponse(CTRL_Z);
	await until(() => keys.length === 1);
	expect(keys).toEqual(["ctrl+z"]);
	await dom.dispose();
});

test("the process transport stops itself with SIGTSTP and goes on at SIGCONT", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const sent: Array<[number, string]> = [];
	const raw: boolean[] = [];
	Object.assign(terminal, {
		pid: 4242,
		platform: "linux",
		kill: (pid: number, signal: string) => {
			sent.push([pid, signal]);
		},
	});
	const setRawMode = terminal.stdin.setRawMode.bind(terminal.stdin);
	terminal.stdin.setRawMode = (mode: boolean) => {
		raw.push(mode);
		return setRawMode(mode);
	};
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	await nextFrame(dom);
	raw.length = 0;

	terminal.stdin.simulateResponse(CTRL_Z);
	await until(() => sent.length === 1);
	expect(sent).toEqual([[4242, "SIGTSTP"]]);
	expect(raw).toEqual([false]);

	terminal.emit("SIGCONT");
	await until(() => dom.document.visibilityState === "visible");
	expect(raw).toEqual([false, true]);
	await dom.dispose();
});

test("the process transport goes on when SIGTSTP stops nothing, as for a session leader", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const sent: string[] = [];
	Object.assign(terminal, {
		pid: 4242,
		platform: "linux",
		kill: (_pid: number, signal: string) => {
			sent.push(signal);
		},
	});
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	await nextFrame(dom);

	terminal.stdin.simulateResponse(CTRL_Z);
	await until(() => sent.length === 1);
	await until(() => dom.document.visibilityState === "visible");
	await dom.dispose();
});

test("no frame goes out between handing the terminal back and resuming", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const written = captureRawOutput(terminal);
	let resume!: () => void;
	let atSuspend = "";
	const transport = {
		...terminal.transport,
		cols: terminal.transport.cols,
		rows: terminal.transport.rows,
		suspend: async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			atSuspend = written();
			return new Promise<void>((resolve) => {
				resume = resolve;
			});
		},
	};
	const dom = new TermDOM({transport});
	const {document} = dom;
	document.body.innerHTML = "<p>before</p>";
	await dom.attach();
	await nextFrame(dom);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			document.body.innerHTML = "<p>\u{1F31E} while hidden</p>";
		}
	});

	terminal.stdin.simulateResponse(CTRL_Z);
	await until(() => atSuspend !== "");
	const handedBack = atSuspend.slice(atSuspend.lastIndexOf(PASTE_OFF));
	expect(handedBack).not.toContain("while hidden");
	expect(handedBack).not.toContain("\x1b[6n");

	resume();
	await until(() => written().includes("while hidden"));
	expect(written()).toContain("while hidden");
	await dom.dispose();
});
