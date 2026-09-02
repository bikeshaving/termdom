/**
 * What the wire reader does with input that is malformed, unsolicited or
 * unterminated. None of it may swallow the keystrokes that follow, and none
 * of it may reach the DOM as a keystroke carrying control bytes.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(): Promise<
	{proc: MockProcess; dom: TermDOM; keys: string[]}
> {
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

test("an unterminated unsolicited clipboard opener does not swallow keys", async () => {
	const {proc, dom, keys} = await mount();
	await send(proc, "\x1b]52;c;");
	await send(proc, "x");
	expect(keys.at(-1)).toBe("x");
	for (const key of keys) {
		expect(key.includes("\x1b")).toBe(false);
	}
	dom.dispose();
});

test("a paste that never closes is delivered at the cap, and keys resume", async () => {
	const {proc, dom, keys} = await mount();
	let pasted: string | null = null;
	dom.document.addEventListener("paste", (event) => {
		pasted = (event as ClipboardEvent).clipboardData?.getData("text/plain") ??
			"";
	});
	(dom.document.getElementById("t") as HTMLTextAreaElement).focus();
	await send(proc, "\x1b[200~");
	const chunk = "a".repeat(1 << 16);
	for (let i = 0; i < 17; i++) {
		await send(proc, chunk);
	}
	await send(proc, "x");
	expect(pasted).not.toBe(null);
	expect((pasted as unknown as string).length).toBeGreaterThan(0);
	expect(keys.at(-1)).toBe("x");
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
	await send(proc, "x");
	expect(keys.at(-1)).toBe("x");
	dom.dispose();
});
