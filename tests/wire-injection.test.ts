/**
 * What the wire reader does with input that is malformed, unsolicited or
 * unterminated. None of it may swallow the keystrokes that follow, and none
 * of it may reach the DOM as a keystroke carrying control bytes.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, until} from "./test-utils.js";

function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(): Promise<{
	proc: MockProcess;
	dom: TermDOM;
	keys: string[];
}> {
	const proc = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: proc.transport});
	dom.document.body.innerHTML = "<textarea id=t></textarea>";
	await nextFrame(dom);
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		keys.push((event as KeyboardEvent).key);
	});
	return {proc, dom, keys};
}

test("an unsolicited clipboard reply is dropped, and the next key arrives", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b]52;c;aGVsbG8=\x07");
	await send(proc, "x");
	expect(keys).toEqual(["x"]);
	dom.dispose();
});

test("an unterminated unsolicited clipboard opener swallows only what a reply holds, and not for long", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b]52;c;");
	await send(proc, "\r");
	expect(keys).toEqual(["Enter"]);
	await send(proc, "\x1b]52;c;");
	await new Promise((resolve) => setTimeout(resolve, 600));
	await send(proc, "x");
	expect(keys).toEqual(["Enter", "x"]);
	dom.dispose();
});

test("a clipboard reply nobody is waiting for, cut across reads, is not typed", async () => {
	const {proc, dom, keys} = await mount();
	const reply = btoa("rm -rf ~ ;".repeat(40));
	await send(proc, "\x1b]52;c;" + reply.slice(0, 100));
	await send(proc, reply.slice(100, 300));
	await send(proc, reply.slice(300) + "\x07x");
	expect(keys).toEqual(["x"]);
	await send(proc, "\x1b]52;");
	await send(proc, "c;" + reply + "\x1b");
	await send(proc, "\\y");
	expect(keys).toEqual(["x", "y"]);
	await send(proc, "\x1b]52;c;" + reply.slice(0, 100));
	await send(proc, reply.slice(100) + "\x1b[Az");
	expect(keys).toEqual(["x", "y", "ArrowUp", "z"]);
	dom.dispose();
});

test("a clipboard reply too large to keep is not typed past where it was given up", async () => {
	const {proc, dom, keys} = await mount();
	let reading: Promise<Error | null> | null = null;
	dom.document.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key === "v") {
			reading = dom
				.window.navigator.clipboard.readText()
				.then(() => null, (err: Error) => err);
		}
	});
	await send(proc, "v");
	const chunk = "QUJD".repeat(4096);
	await send(proc, "\x1b]52;c;" + chunk);
	for (let i = 0; i < 6; i++) {
		await send(proc, chunk);
	}
	await send(proc, "\x07x");
	const error = await (reading as unknown as Promise<Error | null>);
	expect(error?.name).toBe("NotAllowedError");
	expect(keys).toEqual(["v", "x"]);
	dom.dispose();
});

test("a paste past the cap is delivered in parts, and none of it as keys", async () => {
	const {proc, dom, keys} = await mount();
	const pasted: string[] = [];
	dom.document.addEventListener("paste", (event) => {
		pasted.push(
			(event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "",
		);
		event.preventDefault();
	});
	(dom.document.getElementById("t") as HTMLTextAreaElement).focus();
	await send(proc, "\x1b[200~");
	const chunk = "a".repeat(1 << 16);
	for (let i = 0; i < 17; i++) {
		await send(proc, chunk);
	}
	await send(proc, "b\rls -la\r");
	await send(proc, "\x1b[201~");
	await send(proc, "x");
	expect(pasted.at(-1)).toBe("b\nls -la\n");
	expect(pasted.join("").length).toBe(17 * (1 << 16) + 9);
	expect(keys).toEqual(["x"]);
	dom.dispose();
});

test("a long truncated escape sequence is never a keystroke", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b[" + "5".repeat(40));
	await send(proc, "~x");
	expect(keys).toEqual(["x"]);
	for (const key of keys) {
		expect(key.includes("\x1b")).toBe(false);
	}
	dom.dispose();
});

test("an unrecognized sequence split across chunks is dropped whole", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b[1;" + "1;".repeat(20));
	await send(proc, "5Ax");
	expect(keys).toEqual(["x"]);
	dom.dispose();
});

test("a clipboard reply that never closes is released when the query gives up", async () => {
	const {proc, dom, keys} = await mount();
	let reading: Promise<string> | null = null;
	dom.document.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key === "v") {
			reading = dom.window.navigator.clipboard.readText();
		}
	});
	await send(proc, "v");
	await send(proc, "\x1b]52;c;aGVs");
	const error = await (reading as unknown as Promise<string>).then(
		() => null,
		(err: Error) => err,
	);
	expect(error?.name).toBe("NotAllowedError");
	// The rest of it comes after the query gave up.
	await send(proc, "bG8=\x07x");
	expect(keys).toEqual(["v", "x"]);
	dom.dispose();
});

test("a paste holding an OSC opener arrives while a reply is due", async () => {
	const {proc, dom} = await mount();
	let pasted: string | null = null;
	dom.document.addEventListener("paste", (event) => {
		pasted =
			(event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
	});
	dom.document.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key === "v") {
			void dom.window.navigator.clipboard.readText().catch(() => {});
		}
	});
	(dom.document.getElementById("t") as HTMLTextAreaElement).focus();
	await send(proc, "v");
	await send(proc, "\x1b[200~a\x1b]b\x1b[201~");
	expect(pasted).toBe("a\x1b]b");
	dom.dispose();
});

test("a string sequence that arrives whole is dropped whole", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b]0;title\x07x");
	await send(proc, "\x1bPq#0;1;1\x1b\\x");
	await send(proc, "\x1b_apc\x07x");
	expect(keys).toEqual(["x", "x", "x"]);
	dom.dispose();
});

test("a string opener with no terminator in its write is keys, and swallows nothing", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b]0;" + "t".repeat(5000));
	await send(proc, "x");
	await until(() => keys.at(-1) === "x");
	// ESC and a key in one write is what a terminal sends for Alt+].
	expect(keys[0]).toBe("]");
	expect(keys.at(-1)).toBe("x");
	for (const key of keys) {
		expect(key.includes("\x1b")).toBe(false);
	}
	dom.dispose();
});

test("a background reply split across reads is no keystrokes", async () => {
	for (const [head, tail] of [
		["\x1b]11;rgb:1111/2222", "/3333\x07"],
		["\x1b]11;rgb:1111/2222/3333\x1b", "\\"],
	]) {
		const proc = new MockProcess({cols: 40, rows: 12});
		const stdout =
			proc.stdout as unknown as {write: (...args: unknown[]) => boolean};
		const write = stdout.write.bind(stdout);
		stdout.write = (...args: unknown[]) => {
			if (String(args[0]).includes("\x1b]11;?\x1b\\")) {
				void send(proc, head).then(() => send(proc, tail));
			}
			return write(...args);
		};
		const dom = new TermDOM({transport: proc.transport});
		const keys: string[] = [];
		dom.document.addEventListener("keydown", (event) => {
			keys.push((event as KeyboardEvent).key);
		});
		await dom.attach();
		await nextFrame(dom);
		expect(keys).toEqual([]);
		expect(dom.window.matchMedia("(prefers-color-scheme: dark)").matches)
			.toBe(true);
		dom.dispose();
	}
});

test("a coded key past the last code point is no key, and the keys around it arrive", async () => {
	const {proc, dom, keys} = await mount();
	await send(
		proc,
		"a\x1b[1114112u\x1b[97:1114112;2u\x1b[27;1;1114112~\x1b[99999999999ub",
	);
	expect(keys).toEqual(["a", "b"]);
	dom.dispose();
});

test("string openers one after another are read once, not once each", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, `${"\x1bP".repeat(30000)}\x1b[Ax`);
	expect(keys.slice(-2)).toEqual(["ArrowUp", "x"]);
	dom.dispose();
});
