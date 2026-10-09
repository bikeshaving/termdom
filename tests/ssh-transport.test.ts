/**
 * transportFromSSH runs a TermDOM over an SSH session: the pty request
 * sizes it, the shell request opens the channel it reads and writes, and
 * window changes resize it.
 */
import {EventEmitter} from "node:events";

import {expect, test} from "@b9g/libuild/test";
import type {Session} from "ssh2";

import {type SSHSessionLike, TermDOM, transportFromSSH} from "../src/index.ts";
import {nextFrame, until} from "./test-utils.js";

const DA1 = "\x1b[c";

// ssh2's own session fits the shape.
const fitsSSH2 = (session: Session): SSHSessionLike => session;
void fitsSSH2;

class MockChannel extends EventEmitter {
	written: string;
	exitStatus: number | null;
	ended: boolean;

	constructor() {
		super();
		this.written = "";
		this.exitStatus = null;
		this.ended = false;
	}

	write(chunk: string, callback: (error?: Error | null) => void): boolean {
		this.written += chunk;
		// A terminal that answers DA1 and nothing else, so attach() does not
		// wait out its questions.
		if (chunk.includes(DA1)) {
			queueMicrotask(() => this.type("\x1b[?62;22c"));
		}
		queueMicrotask(() => callback());
		return true;
	}

	exit(status: number): void {
		this.exitStatus = status;
	}

	end(): void {
		this.ended = true;
	}

	type(text: string): void {
		this.emit("data", new TextEncoder().encode(text));
	}
}

class MockSession extends EventEmitter {
	channel: MockChannel | null;

	constructor() {
		super();
		this.channel = null;
	}

	pty(cols: number, rows: number): void {
		this.emit("pty", () => {}, () => {}, {cols, rows});
	}

	shell(): MockChannel {
		this.emit("shell", () => (this.channel = new MockChannel()), () => {});
		return this.channel!;
	}

	windowChange(cols: number, rows: number): void {
		this.emit("window-change", undefined, undefined, {cols, rows});
	}
}

function open(): {session: MockSession; term: TermDOM} {
	const session = new MockSession();
	const term = new TermDOM({
		transport: transportFromSSH(session as unknown as SSHSessionLike),
	});
	return {session, term};
}

test("a session starts at its pty's size once its shell opens", async () => {
	const {session, term} = open();
	term.document.body.innerHTML = "<p>hello over ssh</p>";
	const attached = term.attach();
	session.pty(100, 30);
	const channel = session.shell();
	await attached;
	await nextFrame(term);
	expect([term.window.innerWidth, term.window.innerHeight]).toEqual([100, 30]);
	expect(channel.written).toContain("hello over ssh");
	term.dispose();
});

test("nothing is written before the shell opens", async () => {
	const {session, term} = open();
	term.document.body.textContent = "x";
	void term.attach();
	session.pty(80, 24);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(session.channel).toBe(null);
	session.shell();
	await until(() => session.channel!.written.includes("x"));
	term.dispose();
});

test("keys come in over the channel, and a window change resizes", async () => {
	const {session, term} = open();
	session.pty(80, 24);
	const channel = session.shell();
	await term.attach();
	const keys: string[] = [];
	term.document.addEventListener("keydown", (event) => {
		keys.push((event as KeyboardEvent).key);
	});
	channel.type("a");
	await until(() => keys.length > 0);
	expect(keys).toEqual(["a"]);
	const resized = new Promise((resolve) =>
		term.window.addEventListener("resize", resolve, {once: true}),
	);
	session.windowChange(60, 20);
	await resized;
	expect([term.window.innerWidth, term.window.innerHeight]).toEqual([60, 20]);
	term.dispose();
});

test("window.close() sends the exit status and ends the channel", async () => {
	const {session, term} = open();
	session.pty(80, 24);
	const channel = session.shell();
	await term.attach();
	term.window.close();
	await until(() => channel.ended);
	expect(channel.exitStatus).toBe(0);
});

test("when the client's input ends, the terminal is restored and the channel ends", async () => {
	const {session, term} = open();
	session.pty(80, 24);
	const channel = session.shell();
	await term.attach();
	channel.emit("end");
	await until(() => channel.ended);
	expect(channel.exitStatus).toBe(0);
	// The cursor shown again is among the restores, written before the end.
	expect(channel.written).toContain("\x1b[?25h");
});

test("a session with no pty request starts at 80 by 24", async () => {
	const {session, term} = open();
	session.shell();
	await term.attach();
	expect([term.window.innerWidth, term.window.innerHeight]).toEqual([80, 24]);
	term.dispose();
});

test("a session that closes before its shell opens disposes the TermDOM", async () => {
	const {session, term} = open();
	const attached = term.attach();
	session.emit("close");
	await attached;
	await until(() => term.document.visibilityState === "hidden");
	expect(term.document.visibilityState).toBe("hidden");
});
