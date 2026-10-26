/**
 * <embed type="application/x-pty">: a command run in a pseudo-terminal and
 * drawn in the embed's box. A fake spawner stands in for the
 * pseudo-terminal, so these run where the runtime has none.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	type PtyProcess,
	type PtySpawner,
	type PtySpawnOptions,
	TermDOM,
} from "../src/index.ts";
import {encodeKey} from "../src/internal/pty.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

interface FakeChild {
	command: string;
	options: PtySpawnOptions;
	written: string[];
	sizes: Array<[number, number]>;
	killed: boolean;
}

function fakeSpawner(): {spawn: PtySpawner; children: FakeChild[]} {
	const children: FakeChild[] = [];
	const spawn: PtySpawner = (command, options): PtyProcess => {
		const child: FakeChild = {
			command,
			options,
			written: [],
			sizes: [],
			killed: false,
		};
		children.push(child);
		return {
			write: (data) => child.written.push(data),
			resize: (cols, rows) => child.sizes.push([cols, rows]),
			kill: () => {
				child.killed = true;
			},
		};
	};
	return {spawn, children};
}

async function mount(
	html: string,
	pty: "none" | "auto" | PtySpawner,
): Promise<{
	dom: TermDOM;
	terminal: MockProcess;
	document: Document;
	heard: string[];
}> {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport, pty});
	const heard: string[] = [];
	for (const type of ["load", "error", "close"]) {
		dom.document.addEventListener(type, () => heard.push(type), true);
	}
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, terminal, document: dom.document, heard};
}

function rowText(terminal: MockProcess, row: number): string {
	return (terminal as any)
		.terminal.buffer.active.getLine(row)
		.translateToString(true);
}

function fgAt(terminal: MockProcess, col: number, row: number): number {
	const at = (terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	return at.isFgRGB() ? at.getFgColor() : -1;
}

async function send(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	await new Promise((resolve) => setTimeout(resolve, 30));
}

async function settle(dom: TermDOM): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
	await nextFrame(dom);
}

test("without the pty option, an embed runs nothing and fires error", async () => {
	const {dom, document, heard} = await mount(
		`<embed type="application/x-pty" src="top" width="10" height="3">`,
		"none",
	);
	const embed = document.querySelector("embed")!;
	await until(() => heard.length > 0);
	expect(heard).toEqual(["error"]);
	expect(embed.getBoundingClientRect().width).toBe(0);
	expect(embed.tabIndex).toBe(0);
	await dom.dispose();
});

test("the program starts at the embed's size and its screen is drawn", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<p>above</p><embed type="application/x-pty" src="top -o cpu" width="12" height="3">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	expect(children.length).toBe(1);
	expect(children[0].command).toBe("top -o cpu");
	expect([children[0].options.cols, children[0].options.rows]).toEqual([12, 3]);
	children[0].options.onData("\x1b[31mred\x1b[0m\r\nnext");
	await settle(dom);
	await until(() => rowText(terminal, 1).includes("red"));
	expect(rowText(terminal, 1)).toBe("red");
	expect(rowText(terminal, 2)).toBe("next");
	expect(fgAt(terminal, 0, 1)).toBe(0xcd0000);
	const box = embed.getBoundingClientRect();
	expect([box.width, box.height]).toEqual([12, 3]);
	await dom.dispose();
	expect(children[0].killed).toBe(true);
});

test("the program is resized to the embed's box", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="top" style="display: block; width: 30px; height: 5px">`,
		spawn,
	);
	await settle(dom);
	expect(children[0].sizes.at(-1)).toEqual([30, 5]);
	document.querySelector("embed")!.style.width = "20px";
	await settle(dom);
	expect(children[0].sizes.at(-1)).toEqual([20, 5]);
	await dom.dispose();
});

test("a focused embed sends keys to the program, unless the page takes them", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2"><button>after</button>`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	embed.focus();
	await send(terminal, "a");
	await send(terminal, "\r");
	await send(terminal, "\x03");
	await send(terminal, "\t");
	await send(terminal, "\x1b[A");
	expect(children[0].written).toEqual(["a", "\r", "\x03", "\t", "\x1b[A"]);
	expect(document.activeElement).toBe(embed);
	expect(dom.window.closed).toBe(false);
	children[0].options.onData("\x1b[?1h");
	await settle(dom);
	await send(terminal, "\x1b[A");
	expect(children[0].written.at(-1)).toBe("\x1bOA");
	document.addEventListener("keydown", (event) => {
		if (event.key === "Tab") {
			event.preventDefault();
			document.querySelector("button")!.focus();
		}
	});
	await send(terminal, "\t");
	expect(children[0].written.at(-1)).toBe("\x1bOA");
	expect(document.activeElement).toBe(document.querySelector("button"));
	await dom.dispose();
});

test("load fires when the program starts, and close when it ends", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, heard} = await mount(
		`<embed type="application/x-pty" src="true">`,
		spawn,
	);
	await until(() => heard.length > 0);
	children[0].options.onExit(0);
	await until(() => heard.length > 1);
	expect(heard).toEqual(["load", "close"]);
	await dom.dispose();
});

test("removing the embed or changing its src stops the program", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="one">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	embed.setAttribute("src", "two");
	expect(children.map((child) => [child.command, child.killed])).toEqual([
		["one", true],
		["two", false],
	]);
	embed.remove();
	expect(children[1].killed).toBe(true);
	await dom.dispose();
});

test("an embed of any other type stays as it was", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed src="movie.swf" width="10" height="5">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	expect(children.length).toBe(0);
	expect(embed.getBoundingClientRect().width).toBe(0);
	expect(embed.tabIndex).toBe(-1);
	await dom.dispose();
});

test("keys are sent as xterm sends them", () => {
	const key = (name: string, modifiers: Record<string, boolean> = {}) => ({
		key: name,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		...modifiers,
	});
	expect(encodeKey(key("x"), false)).toBe("x");
	expect(encodeKey(key("c", {ctrlKey: true}), false)).toBe("\x03");
	expect(encodeKey(key("x", {altKey: true}), false)).toBe("\x1bx");
	expect(encodeKey(key("Backspace"), false)).toBe("\x7f");
	expect(encodeKey(key("Tab", {shiftKey: true}), false)).toBe("\x1b[Z");
	expect(encodeKey(key("ArrowLeft"), true)).toBe("\x1bOD");
	expect(encodeKey(key("ArrowLeft", {ctrlKey: true}), true)).toBe("\x1b[1;5D");
	expect(encodeKey(key("PageDown"), false)).toBe("\x1b[6~");
	expect(encodeKey(key("F1"), false)).toBe("\x1bOP");
	expect(encodeKey(key("F12", {shiftKey: true}), false)).toBe("\x1b[24;2~");
	expect(encodeKey(key("Shift"), false)).toBe(null);
});

test("with pty: \"auto\", Bun runs the command in its own pseudo-terminal", async () => {
	if ((globalThis as {Bun?: unknown}).Bun === undefined) {
		return;
	}
	const {dom, terminal, heard} = await mount(
		`<embed type="application/x-pty" src="stty size; printf '\\033[1mdone'" width="20" height="3">`,
		"auto",
	);
	await until(() => heard.includes("close"));
	await settle(dom);
	expect(rowText(terminal, 0)).toBe("3 20");
	expect(rowText(terminal, 1)).toBe("done");
	expect(heard).toEqual(["load", "close"]);
	await dom.dispose();
});

function cursorAt(terminal: MockProcess): [number, number] {
	const buffer = (terminal as any).terminal.buffer.active;
	return [buffer.cursorX, buffer.cursorY];
}

test("the program's cursor is the terminal's while the embed has focus", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<p>above</p><embed type="application/x-pty" src="sh" width="10" height="3">`,
		spawn,
	);
	children[0].options.onData("ab\r\ncd");
	document.querySelector("embed")!.focus();
	await settle(dom);
	expect(cursorAt(terminal)).toEqual([2, 2]);
	const output = captureRawOutput(terminal);
	children[0].options.onData("\x1b[6 q");
	await settle(dom);
	expect(output()).toContain("\x1b[6 q");
	children[0].options.onData("\x1b[?25l");
	await settle(dom);
	expect(rowText(terminal, 2)).toBe("cd");
	await dom.dispose();
});

test("a paste goes to a focused program, bracketed when it asks", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2">`,
		spawn,
	);
	document.querySelector("embed")!.focus();
	await send(terminal, "\x1b[200~one\rtwo\x1b[201~");
	expect(children[0].written.at(-1)).toBe("one\rtwo");
	children[0].options.onData("\x1b[?2004h");
	await settle(dom);
	await send(terminal, "\x1b[200~three\x1b[201~");
	expect(children[0].written.at(-1)).toBe("\x1b[200~three\x1b[201~");
	await dom.dispose();
});

test("a program that asks for the mouse hears it in its box, wheel included", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<div style="height: 30px">tall</div>` +
			`<embed type="application/x-pty" src="sh" width="10" height="3" style="display: block; margin-left: 4px">`,
		spawn,
	);
	dom.window.scrollTo(0, 25);
	await settle(dom);
	const scrolled = dom.window.scrollY;
	const embed = document.querySelector("embed")!;
	const top = Math.round(embed.getBoundingClientRect().top);
	await send(terminal, `\x1b[<0;6;${top + 2}M`);
	expect(children[0].written).toEqual([]);
	expect(document.activeElement).toBe(embed);
	children[0].options.onData("\x1b[?1000h\x1b[?1006h");
	await settle(dom);
	await send(terminal, `\x1b[<0;6;${top + 2}M`);
	await send(terminal, `\x1b[<0;6;${top + 2}m`);
	await send(terminal, `\x1b[<65;5;${top + 1}M`);
	expect(children[0].written).toEqual([
		"\x1b[<0;2;2M",
		"\x1b[<0;2;2m",
		"\x1b[<65;1;1M",
	]);
	expect(dom.window.scrollY).toBe(scrolled);
	children[0].options.onData("\x1b[?1006l");
	await settle(dom);
	await send(terminal, `\x1b[<0;6;${top + 2}M`);
	expect(children[0].written.at(-1)).toBe("\x1b[M\x20\x22\x22");
	await dom.dispose();
});

test("a program that asks hears when its embed gains and loses focus", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2"><button>b</button>`,
		spawn,
	);
	children[0].options.onData("\x1b[?1004h");
	await settle(dom);
	document.querySelector("embed")!.focus();
	document.querySelector("button")!.focus();
	document.querySelector("embed")!.focus();
	(document.activeElement as HTMLElement).blur();
	expect(children[0].written).toEqual(["\x1b[I", "\x1b[O", "\x1b[I", "\x1b[O"]);
	await dom.dispose();
});

test("an embed in the starting markup starts once the page is attached", async () => {
	const {spawn, children} = fakeSpawner();
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		pty: spawn,
		html: `<embed type="application/x-pty" src="top" width="10" height="2">`,
	});
	expect(children.map((child) => child.command)).toEqual(["top"]);
	await dom.dispose();
	expect(children[0].killed).toBe(true);
});

test("an embed in a frame draws in the frame and takes the keys there", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<iframe style="width: 20px; height: 4px; border: 0" srcdoc="<style>body{margin:0}</style><embed type='application/x-pty' src='sh' width='12' height='2'>"></iframe>`,
		spawn,
	);
	await settle(dom);
	expect(children.map((child) => child.command)).toEqual(["sh"]);
	children[0].options.onData("inner");
	await settle(dom);
	await until(() => rowText(terminal, 0).includes("inner"));
	const frame = document.querySelector("iframe")!;
	frame.contentDocument!.querySelector("embed")!.focus();
	await send(terminal, "x");
	await send(terminal, "\x03");
	expect(children[0].written).toEqual(["x", "\x03"]);
	expect(dom.window.closed).toBe(false);
	await dom.dispose();
	expect(children[0].killed).toBe(true);
});

test("the pty option takes none, auto or a function, and throws on anything else", () => {
	expect(() => new TermDOM({pty: true as unknown as "auto"})).toThrow(
		TypeError,
	);
});
