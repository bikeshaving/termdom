/**
 * navigator.clipboard, gated on user activation: the clipboard belongs to the
 * user, so it is reachable only from inside the dispatch of a trusted event
 * the user caused.
 *
 * The transport here records everything written and can be fed input by hand,
 * which is what a gesture is at this layer -- decoded stdin.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

/** Feed bytes as the terminal would, and wait for the read side to see them. */
function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type ClipboardProc = MockProcess & {

	/** Answered for the next clipboard query, if the terminal is one that does. */
	clipboard: string | null;
};

async function mount(): Promise<{
	proc: ClipboardProc;
	raw: () => string;
	dom: TermDOM;
}> {
	const proc = new MockProcess({cols: 40, rows: 12}) as ClipboardProc;
	proc.clipboard = null;
	const dom = new TermDOM({transport: proc.transport});
	dom.document.body.textContent = "clipboard";
	await nextFrame(dom);
	const raw = captureRawOutput(proc, {
		onChunk: (chunk) => {
			if (proc.clipboard !== null && chunk.includes("\x1b]52;c;?\x07")) {
				const payload = Buffer.from(proc.clipboard, "utf8").toString("base64");
				proc.clipboard = null;
				setTimeout(() => {
					void send(proc, `\x1b]52;c;${payload}\x07`);
				}, 0);
			}
		},
	});
	return {proc, raw, dom};
}

async function rejection(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("the promise resolved");
}

test("writeText inside a keystroke's dispatch reaches the terminal", async () => {
	const {proc, raw, dom} = await mount();
	let written: Promise<void> | null = null;
	dom.document.addEventListener("keydown", () => {
		written = dom.window.navigator.clipboard.writeText("hello");
	});
	await send(proc, "c");
	await written;
	const payload = Buffer.from("hello", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	dom.dispose();
});

test("a mouse press is a gesture too", async () => {
	const {proc, raw, dom} = await mount();
	const {document} = dom;
	let written: Promise<void> | null = null;
	document.body.addEventListener("mousedown", () => {
		written = dom.window.navigator.clipboard.writeText("gesture");
	});
	await send(proc, "\x1b[<0;1;1M");
	await written;
	const payload = Buffer.from("gesture", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	dom.dispose();
});

test("a keystroke's gesture is over once its dispatch is", async () => {
	const {proc, raw, dom} = await mount();
	await send(proc, "c");
	const error = await rejection(
		dom.window.navigator.clipboard.writeText("late"),
	);
	expect(error.name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;");
	dom.dispose();
});

test("a handler that awaits before writing is too late", async () => {
	const {proc, raw, dom} = await mount();
	const pending: Array<Promise<any>> = [];
	dom.document.addEventListener("keydown", () => {
		pending.push(
			(async () => {
				await Promise.resolve();
				return rejection(dom.window.navigator.clipboard.writeText("awaited"));
			})(),
		);
	});
	await send(proc, "c");
	expect((await pending[0]).name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;");
	dom.dispose();
});

test("writeText from a bare timer or microtask is refused", async () => {
	const {raw, dom} = await mount();
	const fromTimer = await new Promise<any>((resolve) => {
		setTimeout(() => {
			resolve(rejection(dom.window.navigator.clipboard.writeText("sneaky")));
		}, 0);
	});
	const error = await fromTimer;
	expect(error.name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;");
	const fromMicrotask = await Promise.resolve().then(() =>
		rejection(dom.window.navigator.clipboard.writeText("sneaky")),
	);
	expect((await fromMicrotask).name).toBe("NotAllowedError");
	dom.dispose();
});

test("an event an app dispatches itself is not a gesture", async () => {
	const {raw, dom} = await mount();
	const {document, window} = dom;
	const pending: Array<Promise<any>> = [];
	document.body.addEventListener("keydown", () => {
		pending.push(
			rejection(dom.window.navigator.clipboard.writeText("forged")),
		);
	});
	document.body.dispatchEvent(
		new window.KeyboardEvent("keydown", {key: "c", bubbles: true}),
	);
	expect((await pending[0]).name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;");
	dom.dispose();
});

test("readText outside a gesture is refused, and asks the terminal nothing", async () => {
	const {proc, raw, dom} = await mount();
	proc.clipboard = "should not be read";
	const error = await rejection(dom.window.navigator.clipboard.readText());
	expect(error.name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;?");
	const {document, window} = dom;
	const pending: Array<Promise<any>> = [];
	document.body.addEventListener("keydown", () => {
		pending.push(rejection(dom.window.navigator.clipboard.readText()));
	});
	document.body.dispatchEvent(
		new window.KeyboardEvent("keydown", {key: "v", bubbles: true}),
	);
	expect((await pending[0]).name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;?");
	dom.dispose();
});

test("readText queries the terminal and resolves with what it answers", async () => {
	const {proc, raw, dom} = await mount();
	proc.clipboard = "pasted text";
	let reading: Promise<string> | null = null;
	dom.document.addEventListener("keydown", () => {
		reading = dom.window.navigator.clipboard.readText();
	});
	await send(proc, "v");
	expect(raw()).toContain("\x1b]52;c;?\x07");
	expect(await reading).toBe("pasted text");
	dom.dispose();
});

test("a clipboard reply survives arriving in pieces, and glued to typing", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	const keys: string[] = [];
	let reading: Promise<string> | null = null;
	document.addEventListener("keydown", (event: any) => {
		keys.push(event.key);
		if (event.key === "v") {
			reading = dom.window.navigator.clipboard.readText();
		}
	});
	await send(proc, "v");
	const payload = Buffer.from("héllo", "utf8").toString("base64");
	await send(proc, `\x1b]52;c;${payload.slice(0, 3)}`);
	await send(proc, `${payload.slice(3)}\x07jj`);
	expect(await reading).toBe("héllo");
	expect(keys.join("")).toBe("vjj");
	dom.dispose();
});

test("a reply whose base64 will not decode reads as an empty clipboard", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	const keys: string[] = [];
	let reading: Promise<string> | null = null;
	document.addEventListener("keydown", (event: any) => {
		keys.push(event.key);
		if (event.key === "v") {
			reading = dom.window.navigator.clipboard.readText();
		}
	});
	await send(proc, "v");
	// One base64 digit carries no byte: a payload that cannot decode is
	// answered as empty, and the input after it still arrives.
	await send(proc, "\x1b]52;c;A\x07");
	expect(await reading).toBe("");
	await send(proc, "j");
	expect(keys.join("")).toBe("vj");
	dom.dispose();
});

test("readText rejects when the terminal does not answer", async () => {
	const {proc, raw, dom} = await mount();
	const pending: Array<Promise<any>> = [];
	dom.document.addEventListener("keydown", () => {
		pending.push(rejection(dom.window.navigator.clipboard.readText()));
	});
	await send(proc, "v");
	expect(raw()).toContain("\x1b]52;c;?\x07");
	expect((await pending[0]).name).toBe("NotAllowedError");
	dom.dispose();
});

test("navigator.userActivation reports the gate the clipboard asks about", async () => {
	const {proc, dom} = await mount();
	const activation = dom.window.navigator.userActivation;
	expect(activation.hasBeenActive).toBe(false);
	expect(activation.isActive).toBe(false);
	const duringKeydown: boolean[] = [];
	dom.document.addEventListener("keydown", () => {
		duringKeydown.push(activation.isActive, activation.hasBeenActive);
	});
	await send(proc, "x");
	expect(duringKeydown).toEqual([true, true]);
	// The gesture is the dispatch, and the dispatch is over.
	expect(activation.isActive).toBe(false);
	expect(activation.hasBeenActive).toBe(true);
	dom.dispose();
});

test("Escape is not a gesture", async () => {
	const {proc, dom} = await mount();
	const active: boolean[] = [];
	dom.document.addEventListener("keydown", () => {
		active.push(dom.window.navigator.userActivation.isActive);
	});
	await send(proc, "\x1b");
	await send(proc, "a");
	expect(active).toEqual([false, true]);
	dom.dispose();
});

test("Enter on a button is a gesture, through the click it generates", async () => {
	const {proc, raw, dom} = await mount();
	const {document} = dom;
	document.body.innerHTML = "<button id=\"copy\">copy</button>";
	await nextFrame(dom);
	const button = document.getElementById("copy") as any;
	button.focus();
	let written: Promise<void> | null = null;
	let trusted: boolean | null = null;
	button.addEventListener("click", (event: any) => {
		trusted = event.isTrusted;
		written = dom.window.navigator.clipboard.writeText("keyboard");
	});
	await send(proc, "\r");
	await written;
	expect(trusted).toBe(true);
	const payload = Buffer.from("keyboard", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	dom.dispose();
});

test("a paste fires at the focused textControl and inserts by default", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	document.body.innerHTML = "<input id=\"textControl\">";
	await nextFrame(dom);
	const textControl = document.getElementById("textControl") as any;
	textControl.focus();
	await nextFrame(dom);
	const seen: Array<{target: string; text: string; trusted: boolean}> = [];
	document.addEventListener("paste", (event: any) => {
		seen.push({
			target: (event.target as any).id ?? "",
			text: event.clipboardData.getData("text/plain"),
			trusted: event.isTrusted,
		});
	});
	await send(proc, "\x1b[200~hello\x1b[201~");
	await nextFrame(dom);
	expect(seen).toEqual([{target: "textControl", text: "hello", trusted: true}]);
	expect(textControl.value).toBe("hello");
	dom.dispose();
});

test("a paste with nothing focused fires at the body", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	const targets: unknown[] = [];
	let text = "";
	document.body.addEventListener("paste", (event: any) => {
		targets.push(event.target);
		text = event.clipboardData.getData("text");
	});
	await send(proc, "\x1b[200~loose\x1b[201~");
	await nextFrame(dom);
	expect(targets).toEqual([document.body]);
	expect(text).toBe("loose");
	dom.dispose();
});

test("preventing the paste suppresses the insert", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	document.body.innerHTML = "<input id=\"textControl\">";
	await nextFrame(dom);
	const textControl = document.getElementById("textControl") as any;
	textControl.focus();
	await nextFrame(dom);
	const inputTypes: string[] = [];
	textControl.addEventListener("beforeinput", (event: any) => {
		inputTypes.push(event.inputType);
	});
	document.addEventListener("paste", (event: any) => {
		event.preventDefault();
	});
	await send(proc, "\x1b[200~blocked\x1b[201~");
	await nextFrame(dom);
	expect(inputTypes).toEqual([]);
	expect(textControl.value).toBe("");
	dom.dispose();
});

test("a paste's clipboardData is the pasted text, and read-only", async () => {
	const {proc, dom} = await mount();
	const {document} = dom;
	let types: readonly string[] = [];
	let rewritten = "";
	let items = 0;
	let kind = "";
	let files = -1;
	document.body.addEventListener("paste", (event: any) => {
		const data = event.clipboardData;
		types = data.types;
		items = data.items.length;
		kind = data.items[0].kind;
		files = data.files.length;
		data.setData("text/plain", "rewritten");
		rewritten = data.getData("TEXT ");
	});
	await send(proc, "\x1b[200~held\x1b[201~");
	await nextFrame(dom);
	expect(Array.from(types)).toEqual(["text/plain"]);
	expect(items).toBe(1);
	expect(kind).toBe("string");
	expect(files).toBe(0);
	expect(rewritten).toBe("held");
	dom.dispose();
});

test("a transfer held past its event answers with nothing", async () => {
	const {proc, dom} = await mount();
	let held: any = null;
	let duringEvent = "";
	dom.document.body.addEventListener("paste", (event: any) => {
		held = event.clipboardData;
		duringEvent = held.getData("text/plain");
	});
	await send(proc, "\x1b[200~held\x1b[201~");
	await nextFrame(dom);
	expect(duringEvent).toBe("held");
	expect(held.getData("text/plain")).toBe("");
	expect(Array.from(held.types)).toEqual([]);
	dom.dispose();
});

test("a paste is a gesture: the clipboard is reachable from its listener", async () => {
	const {proc, raw, dom} = await mount();
	let written: Promise<void> | null = null;
	dom.document.body.addEventListener("paste", () => {
		written = dom.window.navigator.clipboard.writeText("from paste");
	});
	await send(proc, "\x1b[200~text\x1b[201~");
	await written;
	const payload = Buffer.from("from paste", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	dom.dispose();
});

test("a DataTransfer an app builds is writable, and normalizes its formats", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const data = new (dom.window as any).DataTransfer();
	data.setData("Text", "one");
	data.setData("text/html", "<b>one</b>");
	expect(data.getData("text/plain")).toBe("one");
	expect(Array.from(data.types)).toEqual(["text/plain", "text/html"]);
	expect(data.items.length).toBe(2);
	expect(data.items[1].type).toBe("text/html");
	const read = new Promise<string>((resolve) => {
		data.items[0].getAsString(resolve);
	});
	data.clearData("text/html");
	expect(Array.from(data.types)).toEqual(["text/plain"]);
	data.items.clear();
	expect(data.items.length).toBe(0);
	expect(data.getData("text")).toBe("");
	dom.dispose();
	return read.then((value) => {
		expect(value).toBe("one");
	});
});

test("copy and cut exist as events an app can build and dispatch", async () => {
	const {proc, dom} = await mount();
	const {document, window} = dom;
	const seen: Array<{type: string; text: string; trusted: boolean}> = [];
	for (const type of ["copy", "cut"]) {
		document.body.addEventListener(type, (event: any) => {
			seen.push({
				type: event.type,
				text: event.clipboardData.getData("text/plain"),
				trusted: event.isTrusted,
			});
		});
	}
	for (const type of ["copy", "cut"]) {
		const data = new (window as any).DataTransfer();
		data.setData("text/plain", type);
		document.body.dispatchEvent(
			new (window as any).ClipboardEvent(type, {clipboardData: data}),
		);
	}
	expect(seen).toEqual([
		{type: "copy", text: "copy", trusted: false},
		{type: "cut", text: "cut", trusted: false},
	]);
	// The user agent fires neither: the terminal keeps the copy gesture and
	// does not report it, so no keystroke and no drag becomes one.
	await send(proc, "c");
	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<0;9;1m");
	expect(seen.length).toBe(2);
	dom.dispose();
});

test("write() carries a ClipboardItem's text over OSC 52", async () => {
	const {proc, raw, dom} = await mount();
	const {ClipboardItem} = dom.window as any;
	const clipboard = dom.window.navigator.clipboard as any;
	let written: Promise<void> | null = null;
	dom.document.addEventListener("keydown", () => {
		written = clipboard.write([
			new ClipboardItem({"text/plain": "an item"}),
		]);
	});
	await send(proc, "c");
	await written;
	const payload = Buffer.from("an item", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	dom.dispose();
});

test("write() takes a Blob, and refuses an item with no text", async () => {
	const {proc, raw, dom} = await mount();
	const {ClipboardItem} = dom.window as any;
	const clipboard = dom.window.navigator.clipboard as any;
	let written: Promise<void> | null = null;
	const refused: Array<Promise<any>> = [];
	dom.document.addEventListener("keydown", () => {
		written = clipboard.write([
			new ClipboardItem({
				"text/plain": new Blob(["blobbed"], {type: "text/plain"}),
			}),
		]);
		refused.push(
			rejection(
				clipboard.write([new ClipboardItem({"text/html": "<b>no</b>"})]),
			),
		);
	});
	await send(proc, "c");
	await written;
	const payload = Buffer.from("blobbed", "utf8").toString("base64");
	expect(raw()).toContain(`\x1b]52;c;${payload}\x07`);
	expect((await refused[0]).name).toBe("NotAllowedError");
	dom.dispose();
});

test("write() outside a gesture is refused", async () => {
	const {raw, dom} = await mount();
	const {ClipboardItem} = dom.window as any;
	const clipboard = dom.window.navigator.clipboard as any;
	const error = await rejection(
		clipboard.write([new ClipboardItem({"text/plain": "late"})]),
	);
	expect(error.name).toBe("NotAllowedError");
	expect(raw()).not.toContain("\x1b]52;c;");
	dom.dispose();
});

test("read() answers with one text/plain item, and is gated", async () => {
	const {proc, dom} = await mount();
	const clipboard = dom.window.navigator.clipboard as any;
	expect((await rejection(clipboard.read())).name).toBe("NotAllowedError");
	proc.clipboard = "from the terminal";
	let reading: Promise<any[]> | null = null;
	dom.document.addEventListener("keydown", () => {
		reading = clipboard.read();
	});
	await send(proc, "v");
	const items = (await reading) as unknown as any[];
	expect(items.length).toBe(1);
	expect(Array.from(items[0].types)).toEqual(["text/plain"]);
	const blob = await items[0].getType("text/plain");
	expect(await blob.text()).toBe("from the terminal");
	expect((await rejection(items[0].getType("text/html"))).name).toBe(
		"NotFoundError",
	);
	dom.dispose();
});

test("ClipboardItem.supports answers for text and nothing else", async () => {
	const {dom} = await mount();
	const {ClipboardItem} = dom.window as any;
	expect(ClipboardItem.supports("text/plain")).toBe(true);
	expect(ClipboardItem.supports(" TEXT/plain ")).toBe(true);
	expect(ClipboardItem.supports("text/html")).toBe(false);
	expect(ClipboardItem.supports("image/png")).toBe(false);
	dom.dispose();
});

test("the clipboard interfaces are on the window, and name their instances", async () => {
	const {dom} = await mount();
	const window = dom.window as any;
	expect(window.navigator.clipboard instanceof window.Clipboard).toBe(true);
	expect(window.navigator.permissions instanceof window.Permissions).toBe(
		true,
	);
	expect(new window.ClipboardItem({"text/plain": "x"})).toBeInstanceOf(
		window.ClipboardItem,
	);
	const data = new window.DataTransfer();
	expect(data).toBeInstanceOf(window.DataTransfer);
	expect(data.items).toBeInstanceOf(window.DataTransferItemList);
	const event = new window.ClipboardEvent("copy", {clipboardData: data});
	expect(event).toBeInstanceOf(window.ClipboardEvent);
	expect(event).toBeInstanceOf(window.Event);
	expect(event.clipboardData).toBe(data);
	expect(new window.ClipboardEvent("copy").clipboardData).toBe(null);
	// Neither the clipboard nor a permission is an application's to build.
	expect(() => new window.Clipboard()).toThrow(TypeError);
	expect(() => new window.PermissionStatus()).toThrow(TypeError);
	dom.dispose();
});

test("permissions.query reports the gesture the clipboard asks about", async () => {
	const {proc, dom} = await mount();
	const permissions = dom.window.navigator.permissions as any;
	const read = await permissions.query({name: "clipboard-read"});
	const write = await permissions.query({name: "clipboard-write"});
	expect(read.name).toBe("clipboard-read");
	expect(read.state).toBe("prompt");
	expect(write.state).toBe("prompt");
	expect(read).toBeInstanceOf((dom.window as any).PermissionStatus);
	const duringKeydown: string[] = [];
	dom.document.addEventListener("keydown", () => {
		duringKeydown.push(read.state, write.state);
	});
	await send(proc, "c");
	expect(duringKeydown).toEqual(["granted", "granted"]);
	expect(read.state).toBe("prompt");
	expect(read.onchange).toBe(null);
	dom.dispose();
});

test("permissions.query refuses a name that is not one", async () => {
	const {dom} = await mount();
	const permissions = dom.window.navigator.permissions as any;
	const unknownName = await rejection(permissions.query({name: "clipboard"}));
	expect(unknownName).toBeInstanceOf(TypeError);
	expect(await rejection(permissions.query({}))).toBeInstanceOf(TypeError);
	// A name the API defines that a terminal has nothing behind.
	expect((await permissions.query({name: "geolocation"})).state).toBe(
		"denied",
	);
	dom.dispose();
});

/**
 * Ask the terminal for its clipboard from inside a keystroke, then answer
 * the query with these raw chunks, and return what the page read.
 */
async function readReply(chunks: string[]): Promise<string> {
	const {proc, dom} = await mount();
	let reading: Promise<string> | null = null;
	dom.document.addEventListener("keydown", () => {
		reading ??= dom.window.navigator.clipboard.readText();
	});
	await send(proc, "v");
	for (const chunk of chunks) {
		await send(proc, chunk);
	}
	const text = await reading!;
	dom.dispose();
	return text;
}

test("the wire's base64 tolerates what terminals send", async () => {
	const read = (payload: string) => readReply([`\x1b]52;c;${payload}\x07`]);
	expect(await read("aGk=")).toBe("hi");
	expect(await read("aGk")).toBe("hi");
	expect(await read("aG\r\nk=")).toBe("hi");
	expect(await read("=aGk=")).toBe("hi");
	expect(await read("")).toBe("");
	// A payload no reading rescues answers as an empty clipboard: OSC 52
	// has no channel for saying more.
	expect(await read("A")).toBe("");
	expect(await read("aGkAB")).toBe("");
	const long = "x".repeat(300);
	expect(await read(Buffer.from(long, "utf8").toString("base64"))).toBe(long);
});

test("a reply cut inside its own opening still reads as a reply", async () => {
	const reply = "\x1b]52;c;aGk=\x07";
	// Every cut past the escape itself.
	for (const at of [2, 3, 4, 5, 6, 7, 8]) {
		expect(await readReply([reply.slice(0, at), reply.slice(at)])).toBe("hi");
	}
	// An opening that only looks like a reply is keys, and a bare trailing
	// ESC is the Escape key, held for nothing.
	const {proc, dom} = await mount();
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event: any) => {
		keys.push(event.key);
	});
	await send(proc, "\x1b]2");
	expect(keys).toEqual(["Escape", "]", "2"]);
	await send(proc, "\x1b");
	expect(keys.slice(3)).toEqual(["Escape"]);
	dom.dispose();
});
