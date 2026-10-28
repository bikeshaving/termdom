/**
 * <embed type="application/x-pty">: a command run in a pseudo-terminal and
 * drawn in the embed's box. A fake spawner stands in for the runtime's
 * pseudo-terminal, so these run where the runtime has none.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {
	encodeKey,
	type PTYProcess,
	type PTYSpawner,
	type PTYSpawnOptions,
	replaceSpawner,
} from "../src/internal/pty.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

interface FakeChild {
	command: string;
	options: PTYSpawnOptions;
	written: string[];
	sizes: Array<[number, number]>;
	killed: boolean;
}

function fakeSpawner(): {spawn: PTYSpawner; children: FakeChild[]} {
	const children: FakeChild[] = [];
	const spawn: PTYSpawner = (command, options): PTYProcess => {
		const child: FakeChild = {
			command,
			options,
			written: [],
			sizes: [[options.cols, options.rows]],
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
	pty: "none" | "auto" | PTYSpawner,
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
		ptyEmbeds: typeof pty === "function" ? "auto" : pty,
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
	const dom = new TermDOM({transport: terminal.transport, ptyEmbeds: "none"});
	const heard: string[] = [];
	dom.document.addEventListener("error", () => heard.push("error"), true);
	dom.document.body.innerHTML =
		`<embed type="application/x-pty" src="top" width="10" height="3">`;
	await dom.dispose();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(heard).toEqual([]);
});

async function errorMessages(
	html: string,
	pty: "none" | "auto",
): Promise<{dom: TermDOM; messages: string[]}> {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom =
		new TermDOM({transport: terminal.transport, ptyEmbeds: pty, html});
	const messages: string[] = [];
	dom.window.addEventListener("error", () => messages.push("window error"));
	dom.document.addEventListener(
		"error",
		(event) => messages.push((event as ErrorEvent).message),
		true,
	);
	await until(() => messages.length > 0);
	await nextFrame(dom);
	return {dom, messages};
}

test("without the ptyEmbeds option, an embed runs nothing and fires an error that says why", async () => {
	replaceSpawner(null);
	const {dom: quiet, messages} = await errorMessages(
		`<embed type="application/x-pty" src="top">`,
		"none",
	);
	expect(messages).toEqual(['The ptyEmbeds option is "none"']);
	await quiet.dispose();
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

test("a policy whose object-src is 'none' keeps an embed's program from running", async () => {
	const {spawn, children} = fakeSpawner();
	replaceSpawner(spawn);
	const {dom, messages} = await errorMessages(
		`<head><meta http-equiv="Content-Security-Policy" content="object-src 'none'"></head>` +
			`<body><embed type="application/x-pty" src="top"></body>`,
		"auto",
	);
	expect(messages).toEqual(["The Content-Security-Policy forbids it"]);
	expect(children).toEqual([]);
	await dom.dispose();
});

test("an embed a policy forbids has no program to post to, and reports the violation once", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount("", spawn);
	const meta = document.createElement("meta");
	meta.httpEquiv = "Content-Security-Policy";
	meta.content = "object-src 'none'";
	document.head.append(meta);
	const heard: string[] = [];
	document.addEventListener("securitypolicyviolation", (event) =>
		heard.push((event as SecurityPolicyViolationEvent).effectiveDirective),
	);
	const embed = document.createElement("embed");
	embed.type = "application/x-pty";
	embed.src = "top";
	embed.addEventListener("error", (event) =>
		heard.push((event as ErrorEvent).message),
	);
	document.body.append(embed);
	let thrown = "nothing thrown";
	try {
		embed.postMessage("x");
	} catch (error) {
		thrown = (error as DOMException).name;
	}
	expect(thrown).toBe("InvalidStateError");
	await until(() => heard.length > 1);
	await settle(dom);
	expect(heard).toEqual([
		"object-src",
		"The Content-Security-Policy forbids it",
	]);
	expect(children).toEqual([]);
	await dom.dispose();
});

test("postMessage is an enumerable member of every embed", async () => {
	const {dom} = await mount("", "none");
	const descriptor = Object.getOwnPropertyDescriptor(
		dom.window.HTMLEmbedElement.prototype,
		"postMessage",
	)!;
	expect([descriptor.enumerable, typeof descriptor.value]).toEqual([
		true,
		"function",
	]);
	await dom.dispose();
});

test("a program that cannot start fires error on its embed and nothing on the window", async () => {
	replaceSpawner(() => {
		throw new Error("no such shell");
	});
	const {dom, messages} = await errorMessages(
		`<embed type="application/x-pty" src="top">`,
		"auto",
	);
	expect(messages).toEqual(["no such shell"]);
	await dom.dispose();
});

test("a pty embed's src reads back as the command it was given", async () => {
	const {spawn} = fakeSpawner();
	replaceSpawner(spawn);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		ptyEmbeds: "auto",
		url: "file:///home/user/app/",
	});
	const pty = dom.document.createElement("embed");
	pty.type = "application/x-pty";
	pty.src = "vim 'notes.txt'";
	const plain = dom.document.createElement("embed");
	plain.src = "image.svg";
	expect(pty.src).toBe("vim 'notes.txt'");
	expect(plain.src).toBe("file:///home/user/app/image.svg");
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

test("a program starts at the size its box is laid out at, and hears what was posted before", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount("<p>above</p>", spawn);
	const embed = document.createElement("embed");
	embed.type = "application/x-pty";
	embed.style.cssText = "display: block; width: 30px; height: 5px";
	embed.src = "vim";
	document.body.append(embed);
	embed.postMessage("i");
	await settle(dom);
	expect(children[0].sizes).toEqual([[30, 5]]);
	expect(children[0].written).toEqual(["i"]);
	await dom.dispose();
});

test("a height alone leaves the embed its natural width, in a flex column too", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom} = await mount(
		`<div style="display: flex; flex-direction: column; height: 6px">` +
		`<embed type="application/x-pty" src="vim" style="height: 4px"></div>` +
		`<embed type="application/x-pty" src="top" style="display: block; height: 4px">`,
		spawn,
	);
	await settle(dom);
	expect(children.map((child) => child.sizes.at(-1))).toEqual([
		[80, 4],
		[80, 4],
	]);
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
	children[0].options.onExit(0, null);
	await until(() => heard.length > 1);
	expect(heard).toEqual(["load", "close"]);
	await dom.dispose();
});

test("close is a CloseEvent with the exit code, and the signal that ended the program", async () => {
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
	children[0].options.onExit(3, null);
	children[1].options.onExit(137, "SIGKILL");
	await until(() => closes.length === 2);
	expect(
		closes.map((event) => [
			event.constructor === dom.window.CloseEvent,
			event.code,
			event.wasClean,
			event.reason,
		]),
	).toEqual([[true, 3, true, ""], [true, 137, false, "SIGKILL"]]);
	await dom.dispose();
});

test("while a program has synchronized output on, the embed keeps its last whole screen", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2">`,
		spawn,
	);
	children[0].options.onData("one");
	await settle(dom);
	expect(rowText(terminal, 0)).toBe("one");
	children[0].options.onData("\x1b[?2026h\rtwo");
	await settle(dom);
	expect(rowText(terminal, 0)).toBe("one");
	children[0].options.onData("\x1b[?2026l");
	await settle(dom);
	expect(rowText(terminal, 0)).toBe("two");
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

test("postMessage types into the program while it runs, and throws InvalidStateError otherwise", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="sh"><embed src="plain.svg">`,
		spawn,
	);
	const [embed, plain] = document.querySelectorAll("embed");
	const notRunning = (send: () => void) => {
		try {
			send();
		} catch (error) {
			return (error as DOMException).name;
		}
		return "nothing thrown";
	};
	expect(notRunning(() => plain.postMessage("x"))).toBe("InvalidStateError");
	embed.postMessage("make\r");
	expect(children[0].written).toEqual(["make\r"]);
	expect(() => (embed.postMessage as () => void)()).toThrow(TypeError);
	expect(() =>
		dom.window.HTMLEmbedElement.prototype.postMessage.call(document.body, "x"),
	).toThrow(TypeError);
	children[0].options.onExit(0, null);
	expect(notRunning(() => embed.postMessage("x"))).toBe("InvalidStateError");
	embed.remove();
	expect(notRunning(() => embed.postMessage("x"))).toBe("InvalidStateError");
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
	embed.postMessage({type: "keydown", key: "ArrowUp"});
	children[0].options.onData("\x1b[?1h\x1b[?2004h");
	embed.postMessage(new KeyboardEvent("keydown", {key: "ArrowUp"}));
	embed.postMessage(new KeyboardEvent("keydown", {key: "c", ctrlKey: true}));
	embed.postMessage(new KeyboardEvent("keyup", {key: "c", ctrlKey: true}));
	embed.postMessage({type: "keydown", key: "Shift", shiftKey: true});
	embed.postMessage({type: "keydown", key: "a", isComposing: true});
	const clipboardData = new DataTransfer();
	clipboardData.setData("text/plain", "one\ntwo");
	embed.postMessage(new ClipboardEvent("paste", {clipboardData}));
	expect(written).toEqual([
		"\x1b[A",
		"\x1bOA",
		"\x03",
		"\x1b[200~one\rtwo\x1b[201~",
	]);
	expect(() => embed.postMessage(42 as unknown as string)).toThrow(TypeError);
	expect(() => embed.postMessage(null as unknown as string)).toThrow(TypeError);
	expect(() => embed.postMessage({key: "a"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage({type: "keydown"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage({type: "paste"} as any)).toThrow(TypeError);
	expect(() => embed.postMessage({type: "click"} as any)).toThrow(TypeError);
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
	await settle(dom);
	expect(children.map((child) => [child.command, child.killed])).toEqual([
		["one", true],
		["two", false],
	]);
	embed.remove();
	expect(children[1].killed).toBe(true);
	embed.setAttribute("src", "three");
	document.body.append(embed);
	embed.remove();
	await settle(dom);
	expect(children.map((child) => child.command)).toEqual(["one", "two"]);
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

test("with ptyEmbeds: \"auto\", Bun runs the command in its own pseudo-terminal", async () => {
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

test("a program in a focused embed hears the terminal lose and regain focus", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2"><button>b</button>`,
		spawn,
	);
	await dom.attach();
	children[0].options.onData("\x1b[?1004h");
	await settle(dom);
	document.querySelector("embed")!.focus();
	await send(terminal, "\x1b[O");
	await send(terminal, "\x1b[I");
	await send(terminal, "\x1b[O");
	document.querySelector("button")!.focus();
	document.querySelector("embed")!.focus();
	expect(children[0].written).toEqual(["\x1b[I", "\x1b[O", "\x1b[I", "\x1b[O"]);
	await dom.dispose();
});

test("a program's cursor hides while the terminal is away", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="10" height="2">`,
		spawn,
	);
	await dom.attach();
	const written = captureRawOutput(terminal);
	const showing = () => {
		const output = written();
		return output.lastIndexOf("\x1b[?25h") > output.lastIndexOf("\x1b[?25l");
	};
	children[0].options.onData("ab");
	document.querySelector("embed")!.focus();
	await settle(dom);
	expect(showing()).toBe(true);
	await send(terminal, "\x1b[O");
	children[0].options.onData("c");
	await settle(dom);
	expect(showing()).toBe(false);
	await send(terminal, "\x1b[I");
	await settle(dom);
	expect(showing()).toBe(true);
	await dom.dispose();
});

test("a program started in a focused embed hears focus leave", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<embed type="application/x-pty" src="first" width="10" height="2"><button>b</button>`,
		spawn,
	);
	const embed = document.querySelector("embed")!;
	embed.focus();
	embed.setAttribute("src", "second");
	await settle(dom);
	children[1].options.onData("\x1b[?1004h");
	await settle(dom);
	document.querySelector("button")!.focus();
	expect(children[1].written).toEqual(["\x1b[O"]);
	await dom.dispose();
});

test("an embed in the starting markup starts once the page is attached", async () => {
	const {spawn, children} = fakeSpawner();
	replaceSpawner(spawn);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		ptyEmbeds: "auto",
		html: `<embed type="application/x-pty" src="top" width="10" height="2">`,
	});
	await settle(dom);
	expect(children.map((child) => child.command)).toEqual(["top"]);
	await dom.dispose();
	expect(children[0].killed).toBe(true);
});

test("an embed in a frame runs nothing and fires an error that says so", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, document} = await mount(
		`<iframe srcdoc="<embed type='application/x-pty' src='sh'>"></iframe>`,
		spawn,
	);
	const frame = document.querySelector("iframe")!;
	await until(() => frame.contentDocument?.querySelector("embed") != null);
	const embed = frame.contentDocument!.querySelector("embed")!;
	const messages: string[] = [];
	embed.addEventListener("error", (event) =>
		messages.push((event as ErrorEvent).message),
	);
	embed.setAttribute("src", "top");
	await until(() => messages.length > 0);
	expect(messages).toEqual(["A frame runs no program"]);
	expect(children).toEqual([]);
	await dom.dispose();
});

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

test("the ptyEmbeds option takes none or auto, and throws on anything else", () => {
	expect(() => new TermDOM({ptyEmbeds: true as unknown as "auto"})).toThrow(
		TypeError,
	);
	const {spawn} = fakeSpawner();
	expect(() => new TermDOM({ptyEmbeds: spawn as unknown as "auto"})).toThrow(
		TypeError,
	);
});

test("nothing a program writes reaches the terminal but its screen", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" width="20" height="3">`,
		spawn,
	);
	await dom.attach();
	document.querySelector("embed")!.focus();
	await settle(dom);
	const written = captureRawOutput(terminal);
	children[0].options.onData(
		"\x1b]0;TITLE\x07\x1b]2;TITLE\x1b\\" +
			"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h" +
			"\x1b[?2004h\x1b[?1h\x1b=\x1b[?6h\x1b[?7l\x1b[4h\x1b[?47h" +
			"\x1b]52;c;Y2xpcA==\x07\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\" +
			"\x1bPtmux;\x1b\x1b]0;PASS\x07\x1b\\\x1b_Gf=100;AAAA\x1b\\" +
			"\x1b[c\x1b[>c\x1b[6n\x1b[18t\x1b[2J\x1b[3J\x1bc\x1b[!p" +
			"\x1b[8;50;200t\x1b[3;1;1t\x07\x1b#8\x1b(0lqk\x1b(B shown",
	);
	await settle(dom);
	const output = written();
	expect(rowText(terminal, 0)).toContain("shown");
	for (const leak of [
		"\x1b]",
		"\x1bP",
		"\x1b_",
		"\x1bc",
		"\x1b=",
		"\x1b#",
		"\x1b(0",
		"\x1b[?1049",
		"\x1b[?47",
		"\x1b[?1000",
		"\x1b[?1002",
		"\x1b[?1003",
		"\x1b[?1006",
		"\x1b[?1004",
		"\x1b[?2004",
		"\x1b[?1h",
		"\x1b[?6h",
		"\x1b[?7l",
		"\x1b[4h",
		"\x1b[3J",
		"\x1b[!p",
		"t",
		"TITLE",
		"PASS",
		"\x07",
	]) {
		expect(
			leak === "t" ? /\x1b\[[\d;]*t/.test(output) : output.includes(leak),
		).toBe(false);
	}
	await dom.dispose();
});

test("a drag that leaves the box is held to its edges, and the border is not the program's", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<div style="height: 2px"></div><embed type="application/x-pty" src="sh" width="10" height="3" style="display: block; margin-left: 4px; border: 1px solid; padding: 1px 2px; box-sizing: content-box">`,
		spawn,
	);
	children[0].options.onData("\x1b[?1002h\x1b[?1006h");
	await settle(dom);
	const box = document.querySelector("embed")!.getBoundingClientRect();
	const left = Math.round(box.left) + 1 + 2 + 1;
	const top = Math.round(box.top) + 1 + 1 + 1;
	await send(terminal, `\x1b[<0;${left - 3};${top - 2}M`);
	await send(terminal, `\x1b[<0;${left - 3};${top - 2}m`);
	await send(terminal, `\x1b[<0;${left - 1};${top}M`);
	await send(terminal, `\x1b[<0;${left - 1};${top}m`);
	expect(children[0].written).toEqual([]);
	await send(terminal, `\x1b[<0;${left};${top}M`);
	await send(terminal, "\x1b[<32;1;1M");
	await send(terminal, `\x1b[<32;${left + 40};${top + 20}M`);
	await send(terminal, `\x1b[<0;${left + 40};${top + 20}m`);
	expect(children[0].written).toEqual([
		"\x1b[<0;1;1M",
		"\x1b[<32;1;1M",
		"\x1b[<32;10;3M",
		"\x1b[<0;10;3m",
	]);
	await dom.dispose();
});

test("an embed the terminal's width sizes follows the terminal, and a box too small still gives one cell", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed type="application/x-pty" src="sh" style="display: block; width: 100%; height: 3px">`,
		spawn,
	);
	await settle(dom);
	expect(children[0].sizes.at(-1)).toEqual([40, 3]);
	terminal.resize(25, 12);
	(terminal as unknown as {emit(event: string): void}).emit("SIGWINCH");
	await until(() => dom.window.innerWidth === 25);
	await settle(dom);
	expect(children[0].sizes.at(-1)).toEqual([25, 3]);
	const embed = document.querySelector("embed")!;
	embed.style.width = "0";
	embed.style.height = "0";
	await settle(dom);
	for (const [cols, rows] of children[0].sizes) {
		expect(cols).toBeGreaterThan(0);
		expect(rows).toBeGreaterThan(0);
	}
	await dom.dispose();
});

test("keys go to the focused embed alone, a click moves them, and an ended program lets Tab go", async () => {
	const {spawn, children} = fakeSpawner();
	const {dom, terminal, document} = await mount(
		`<embed id=one type="application/x-pty" src="one" width="10" height="2" style="display: block">` +
			`<embed id=two type="application/x-pty" src="two" width="10" height="2" style="display: block">` +
			"<button>after</button>",
		spawn,
	);
	await settle(dom);
	const one = document.getElementById("one")!;
	const two = document.getElementById("two")!;
	one.focus();
	await send(terminal, "a");
	const top = Math.round(two.getBoundingClientRect().top);
	await send(terminal, `\x1b[<0;2;${top + 1}M`);
	await send(terminal, `\x1b[<0;2;${top + 1}m`);
	expect(document.activeElement).toBe(two);
	await send(terminal, "b");
	expect(children[0].written).toEqual(["a"]);
	expect(children[1].written).toEqual(["b"]);
	children[1].options.onExit(0, null);
	await settle(dom);
	await send(terminal, "\t");
	expect(children[1].written).toEqual(["b"]);
	expect(document.activeElement).toBe(document.querySelector("button"));
	await dom.dispose();
});
