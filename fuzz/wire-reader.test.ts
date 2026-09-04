/**
 * Properties over the wire reader: whatever bytes arrive, in whatever
 * chunks, nothing throws, no keystroke reaches the DOM carrying a control
 * byte, and a keystroke sent after the noise still arrives.
 *
 * `FC_NUM_RUNS=200` widens the search, `FC_SEED=...` replays one.
 */
import {expect, test} from "@b9g/libuild/test";
import fc from "fast-check";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 40);
const params = {
	numRuns: NUM_RUNS,
	...(process.env.FC_SEED ? {seed: Number(process.env.FC_SEED)} : {}),
};

function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// Pieces a terminal, a multiplexer or a confused program might send:
// whole and broken control sequences, string openers with and without
// their closers, C0 bytes, DEL, and plain text.
const piece = fc.oneof(
	fc.constantFrom(
		"\x1b",
		"\x1b[",
		"\x1b]",
		"\x1bO",
		"\x1bP",
		"\x1b_",
		"\x1b^",
		"\x1bX",
		"\x1b\\",
		"\x07",
		"\x1b[200~",
		"\x1b[201~",
		"\x1b]52;c;",
		"\x1b]52;c;?\x07",
		"\x1b]0;title\x07",
		"\x1b[<0;5;5M",
		"\x1b[5;5R",
		"\x1b[?1;2$y",
		"\x1b[1;5A",
		"\x1b[Z",
		"\x7f",
		"\r",
		"\t",
		"\x00",
		"\x01",
	),
	fc
		.array(fc.constantFrom(..."0123456789;?<>=!$~".split("")), {maxLength: 12})
		.map((chars) => chars.join("")),
	fc.string({maxLength: 6}),
	fc.string({unit: "grapheme", maxLength: 4}),
	fc
		.uint8Array({maxLength: 8})
		.map((bytes) => Buffer.from(bytes).toString("latin1")),
);

// Ctrl+C and Ctrl+D end the session, which is the one thing this test
// does not want.
const noise = fc
	.array(piece, {maxLength: 24})
	.map((parts) => parts.join("").replace(/[\x03\x04\x1a\x1c]/g, ""));

// Every way of cutting the noise into chunks.
const chunked = noise.chain((text) =>
	fc
		.array(fc.integer({min: 1, max: Math.max(1, text.length)}), {maxLength: 8})
		.map((cuts) => {
			const points = [...new Set(cuts.filter((c) => c < text.length))].sort(
				(a, b) => a - b,
			);
			const chunks: string[] = [];
			let last = 0;
			for (const point of points) {
				chunks.push(text.slice(last, point));
				last = point;
			}
			chunks.push(text.slice(last));
			return chunks;
		}),
);

function isCleanKey(key: string): boolean {
	if (/^[A-Z][A-Za-z0-9]+$/.test(key)) {
		return true;
	}
	for (const char of key) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
			return false;
		}
	}
	return true;
}

test("any bytes in any chunks: no throw, no control byte in a key, and the next key arrives", async () => {
	await fc.assert(
		fc.asyncProperty(chunked, async (chunks) => {
			const proc = new MockProcess({cols: 40, rows: 12});
			const dom = new TermDOM({transport: proc.transport});
			dom.document.body.innerHTML = "<textarea id=t></textarea>";
			await nextFrame(dom);
			(dom.document.getElementById("t") as HTMLTextAreaElement).focus();
			const keys: string[] = [];
			dom.document.addEventListener("keydown", (event) => {
				keys.push((event as KeyboardEvent).key);
			});
			try {
				for (const chunk of chunks) {
					await send(proc, chunk);
				}
				// Close whatever the noise left open, then type.
				await send(proc, "\x1b[201~\x1b\\\x07~");
				await send(proc, "x");
				for (const key of keys) {
					expect(isCleanKey(key)).toBe(true);
				}
				expect(keys.at(-1)).toBe("x");
			} finally {
				dom.dispose();
			}
		}),
		params,
	);
});
