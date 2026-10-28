/**
 * <embed type="application/x-pty">: a command run in a pseudo-terminal and
 * drawn in the embed's box. A fake spawner stands in for the runtime's
 * pseudo-terminal, so these run where the runtime has none.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {
	encodeKey,
	type PtyProcess,
	type PtySpawner,
	type PtySpawnOptions,
	replaceSpawner,
} from "../src/internal/pty.ts";
import {canCreateRealms} from "../src/internal/realms.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

const withRealms = canCreateRealms() ? test : test.skip;

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
	replaceSpawner(typeof pty === "function" ? pty : null);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		pty: typeof pty === "function" ? "auto" : pty,
	});
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

test("an embed disposed with its page before its error is due fires none", async () => {
	replaceSpawner(null);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport, pty: "none"});
	const heard: string[] = [];
	dom.document.addEventListener("error", () => heard.push("error"), true);
	dom.document.body.innerHTML =
		`<embed type="application/x-pty" src="top" width="10" height="3">`;
	await dom.dispose();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(heard).toEqual([]);
});

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

test("close is a CloseEvent with the program's exit code", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="one"><embed type="application/x-pty" src="two">`,
		spawn,
	);
	const closes: CloseEvent[] = [];
	document.addEventListener(
		"close",
		(event) => {
			closes.push(event as CloseEvent);
		},
		true,
	);
	children[0].options.onExit(3);
	children[1].options.onExit(null);
	await until(() => closes.length === 2);
	expect(
		closes.map((event) => [
			event.constructor === dom.window.CloseEvent,
			event.code,
			event.wasClean,
		]),
	).toEqual([[true, 3, true], [true, 0, false]]);
	await dom.dispose();
});

test("titlechange and bell fire when the program sets its title and rings", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="sh">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	const heard: string[] = [];
	embed.addEventListener("titlechange", (event) => {
		heard.push(`title ${(event as CustomEvent<string>).detail}`);
	});
	embed.addEventListener("bell", () => heard.push("bell"));
	children[0].options.onData("\x1b]0;make: building\x07");
	children[0].options.onData("\x1b]2;make: done\x1b\\\x07\x07");
	children[0].options.onData("\x1b]2;make: done\x07");
	await until(() => heard.length === 3);
	await settle(dom);
	expect(heard).toEqual(["title make: building", "title make: done", "bell"]);
	await dom.dispose();
});

test("postMessage types into the program while it runs, and only then", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="sh"><embed src="plain.svg">`,
		spawn,
	);
	const [embed, plain] = document.querySelectorAll("embed");
	expect("postMessage" in plain).toBe(false);
	embed.postMessage!("make\r");
	expect(children[0].written).toEqual(["make\r"]);
	expect(() => (embed.postMessage as () => void)()).toThrow(TypeError);
	children[0].options.onExit(0);
	expect(() => embed.postMessage!("x")).toThrow(dom.window.DOMException);
	embed.remove();
	expect("postMessage" in embed).toBe(false);
	await dom.dispose();
});

test("postMessage forwards key and paste events as the user's own input", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="vi">`,
		spawn,
	);
	const {KeyboardEvent, ClipboardEvent, DataTransfer} = dom.window;
	const embed = document.querySelector("embed")!;
	const written = children[0].written;
	embed.postMessage!({type: "keydown", key: "ArrowUp"});
	children[0].options.onData("\x1b[?1h\x1b[?2004h");
	embed.postMessage!(new KeyboardEvent("keydown", {key: "ArrowUp"}));
	embed.postMessage!(new KeyboardEvent("keydown", {key: "c", ctrlKey: true}));
	embed.postMessage!(new KeyboardEvent("keyup", {key: "c", ctrlKey: true}));
	embed.postMessage!({type: "keydown", key: "Shift", shiftKey: true});
	embed.postMessage!({type: "keydown", key: "a", isComposing: true});
	const clipboardData = new DataTransfer();
	clipboardData.setData("text/plain", "one\ntwo");
	embed.postMessage!(new ClipboardEvent("paste", {clipboardData}));
	embed.postMessage!(42 as unknown as string);
	expect(written).toEqual([
		"\x1b[A",
		"\x1bOA",
		"\x03",
		"\x1b[200~one\rtwo\x1b[201~",
		"42",
	]);
	expect(() => embed.postMessage!({key: "a"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage!({type: "keydown"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage!({type: "paste"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage!({type: "click"} as any)).toThrow(TypeError);
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
	await send(terminal, `\x1b[<0;6;${top + 2}m`);
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

test("a page that cancels the pointer, the press or the wheel keeps it from the program", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="3" style="display: block">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	const top = Math.round(embed.getBoundingClientRect().top);
	children[0].options.onData("\x1b[?1000h\x1b[?1006h");
	await settle(dom);
	const cancel = (event: Event) => event.preventDefault();
	embed.addEventListener("mousedown", cancel);
	embed.addEventListener("wheel", cancel);
	await send(terminal, `\x1b[<0;2;${top + 1}M`);
	await send(terminal, `\x1b[<0;2;${top + 1}m`);
	await send(terminal, `\x1b[<65;2;${top + 1}M`);
	expect(children[0].written).toEqual([]);
	embed.removeEventListener("mousedown", cancel);
	embed.removeEventListener("wheel", cancel);
	embed.addEventListener("pointerdown", cancel);
	await send(terminal, `\x1b[<0;2;${top + 1}M`);
	await send(terminal, `\x1b[<0;2;${top + 1}m`);
	expect(children[0].written).toEqual([]);
	embed.removeEventListener("pointerdown", cancel);
	await send(terminal, `\x1b[<0;2;${top + 1}M`);
	await send(terminal, `\x1b[<0;2;${top + 1}m`);
	expect(children[0].written).toEqual(["\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
	await dom.dispose();
});

test("a fixed embed hears the row it shows, and its padding is its own", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal} = await mount(
		`<div style="height: 40px">tall</div>` +
			`<embed type="application/x-pty" src="sh" width="10" height="3" style="position: fixed; top: 2px; left: 0; padding: 0 1px">`,
		spawn,
	);
	children[0].options.onData("\x1b[?1000h\x1b[?1006h");
	dom.window.scrollTo(0, 10);
	await settle(dom);
	expect(dom.window.scrollY).toBeGreaterThan(0);
	await send(terminal, "\x1b[<0;1;3M");
	await send(terminal, "\x1b[<0;1;3m");
	expect(children[0].written).toEqual([]);
	await send(terminal, "\x1b[<0;3;4M");
	await send(terminal, "\x1b[<0;3;4m");
	expect(children[0].written).toEqual(["\x1b[<0;2;2M", "\x1b[<0;2;2m"]);
	await dom.dispose();
});

test("a drag the program took stays its own, and one from elsewhere never reaches it", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="3" style="display: block"><div style="height: 3px">below</div>`,
		spawn,
	);
	const top = Math.round(
		document.querySelector("embed")!.getBoundingClientRect().top,
	);
	children[0].options.onData("\x1b[?1002h\x1b[?1006h");
	await settle(dom);
	await send(terminal, `\x1b[<0;2;${top + 5}M`);
	await send(terminal, `\x1b[<32;3;${top + 2}M`);
	await send(terminal, `\x1b[<0;3;${top + 2}m`);
	expect(children[0].written).toEqual([]);
	await send(terminal, `\x1b[<0;2;${top + 2}M`);
	await send(terminal, `\x1b[<32;3;${top + 5}M`);
	await send(terminal, `\x1b[<0;3;${top + 5}m`);
	expect(children[0].written).toEqual([
		"\x1b[<0;2;2M",
		"\x1b[<32;3;3M",
		"\x1b[<0;3;3m",
	]);
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

test("an embed focused in a frame hears focus leave and return with the frame", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<iframe style="width: 20px; height: 4px; border: 0" srcdoc="<embed type='application/x-pty' src='sh' width='12' height='2'>"></iframe><button>b</button>`,
		spawn,
	);
	await settle(dom);
	children[0].options.onData("\x1b[?1004h");
	await settle(dom);
	const frame = document.querySelector("iframe")!;
	frame.contentDocument!.querySelector("embed")!.focus();
	document.querySelector("button")!.focus();
	frame.focus();
	expect(children[0].written).toEqual(["\x1b[I", "\x1b[O", "\x1b[I"]);
	await dom.dispose();
});

test("an embed in the starting markup starts once the page is attached", async () => {
	const {spawn, children} = fakeSpawner();
	replaceSpawner(spawn);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		pty: "auto",
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

test("removing or navigating a frame stops the programs in it", async () => {
	const {spawn, children} = fakeSpawner();
	const frameHTML =
		`<iframe style="width: 20px; height: 4px; border: 0" srcdoc="<embed type='application/x-pty' src='sh' width='12' height='2'>"></iframe>`;
	const {dom, document} = await mount(frameHTML + frameHTML, spawn);
	await settle(dom);
	expect(children.map((child) => child.killed)).toEqual([false, false]);
	const [first, second] = document.querySelectorAll("iframe");
	first.remove();
	expect(children[0].killed).toBe(true);
	second.setAttribute("srcdoc", "<p>gone</p>");
	await settle(dom);
	expect(children[1].killed).toBe(true);
	await dom.dispose();
});

withRealms(
	"an embed in a frame fires its events in the frame's realm",
	async () => {
		const {spawn, children} = fakeSpawner();
		const {dom, document} = await mount(
			`<iframe style="width: 20px; height: 4px; border: 0" srcdoc="<embed type='application/x-pty' src='sh' width='12' height='2'>"></iframe>`,
			spawn,
		);
		await settle(dom);
		const frame = document.querySelector("iframe")!;
		const window = frame.contentWindow as any;
		const embed = frame.contentDocument!.querySelector("embed")! as any;
		const seen: boolean[] = [];
		embed.addEventListener("close", (event: Event) => {
			seen.push(
				event instanceof window.CloseEvent,
				event instanceof dom.window.CloseEvent,
			);
		});
		expect(embed.postMessage instanceof window.Function).toBe(true);
		children[0].options.onExit(0);
		await until(() => seen.length > 0);
		expect(seen).toEqual([true, false]);
		await dom.dispose();
	},
);

test("the wheel scrolls back through what scrolled off, and a key returns", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2" scrollback="3" style="display: block">`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	const top = Math.round(embed.getBoundingClientRect().top);
	children[0].options.onData("1\r\n2\r\n3\r\n4\r\n5\r\n6");
	await settle(dom);
	expect([rowText(terminal, top), rowText(terminal, top + 1)]).toEqual([
		"5",
		"6",
	]);
	await send(terminal, `\x1b[<64;2;${top + 1}M`);
	await settle(dom);
	expect([rowText(terminal, top), rowText(terminal, top + 1)]).toEqual([
		"2",
		"3",
	]);
	children[0].options.onData("\r\n7");
	await settle(dom);
	expect([rowText(terminal, top), rowText(terminal, top + 1)]).toEqual([
		"3",
		"4",
	]);
	embed.setAttribute("scrollback", "1");
	await settle(dom);
	expect([rowText(terminal, top), rowText(terminal, top + 1)]).toEqual([
		"5",
		"6",
	]);
	embed.focus();
	await send(terminal, "x");
	await settle(dom);
	expect([rowText(terminal, top), rowText(terminal, top + 1)]).toEqual([
		"6",
		"7",
	]);
	expect(children[0].written).toEqual(["x"]);
	await dom.dispose();
});

test("with scrollback=\"0\", the wheel passes to the page", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2" scrollback="0" style="display: block"><div style="height: 40px"></div>`,
		spawn,
	);
	const top = Math.round(
		document.querySelector("embed")!.getBoundingClientRect().top,
	);
	children[0].options.onData("1\r\n2\r\n3");
	await settle(dom);
	await send(terminal, `\x1b[<65;2;${top + 1}M`);
	await settle(dom);
	expect(dom.window.scrollY).toBeGreaterThan(0);
	await dom.dispose();
});

test("the pty option takes none or auto, and throws on anything else", () => {
	expect(() => new TermDOM({pty: true as unknown as "auto"})).toThrow(
		TypeError,
	);
	const {spawn} = fakeSpawner();
	expect(() => new TermDOM({pty: spawn as unknown as "auto"})).toThrow(
		TypeError,
	);
});
