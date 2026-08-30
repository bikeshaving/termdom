/**
 * Properties over what untrusted text can put on the wire.
 *
 * A document's text is the attacker's in the cases this engine is built for --
 * a Markdown file, a model's reply. Two paths carry it to the terminal, and
 * they are defended in different places, so each gets its own property here.
 *
 * The cell path is the wide one: text becomes graphemes, graphemes become
 * cells, cells become bytes. Nothing control-bearing may enter a cell, so
 * nothing control-bearing can leave one.
 *
 * The title path is the narrow one, and the one that bypasses the grid
 * entirely: the title is interpolated into an OSC sequence and written. It is
 * a pure function, so the property over it is exact rather than sampled.
 *
 * `FC_NUM_RUNS=500` widens the search, `FC_SEED=...` replays one.
 */
import {test, expect} from "@b9g/libuild/test";
import fc from "fast-check";
import {MockProcess, nextFrame} from "../tests/test-utils.js";
import {TermDOM} from "../src/internal/termdom.js";
import {titleEscape} from "../src/internal/exchange.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const SEED = Number(process.env.FC_SEED ?? 1);

const assertOptions = {
	numRuns: NUM_RUNS,
	seed: SEED,
	includeErrorInReport: true,
};

/**
 * Whether a code point is one the terminal reads as a command rather than as
 * a character: C0, DEL, and the C1 range whose single bytes are CSI, OSC and
 * DCS. This is the rule both defended paths apply, stated once so a property
 * cannot drift from either.
 */
function isControl(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

function hasControl(text: string): boolean {
	for (const char of text) {
		if (isControl(char.codePointAt(0)!)) {
			return true;
		}
	}
	return false;
}

/**
 * Text that leans on the boundary: the control characters an injection needs,
 * the sequence openers spelled out, and ordinary characters to hide among.
 * fc.string alone reaches a control character too rarely to be the search.
 */
const dangerous: fc.Arbitrary<string> = fc
	.array(
		fc.oneof(
			fc.constantFrom(
				"\x1b", // ESC, the opener of every two-byte sequence
				"\x07", // BEL, which terminates an OSC
				"\x9b", // C1 CSI: a single byte, no ESC needed
				"\x9d", // C1 OSC
				"\x90", // C1 DCS
				"\x00",
				"\x08",
				"\x7f",
				"\x1b]0;",
				"\x1b]52;c;",
				"\x1b[2J",
				"\x1bP",
				"]0;",
				";",
				"a",
				" ",
			),
			fc.string({minLength: 1, maxLength: 2}),
		),
		{maxLength: 20},
	)
	.map((parts) => parts.join(""));

test("a title carries no command but the one that frames it", () => {
	fc.assert(
		fc.property(dangerous, (payload) => {
			const encoded = titleEscape(payload);

			// The sequence this function writes and nothing else: one ESC to
			// open it, one BEL to close it, and no other control anywhere.
			expect(encoded.startsWith("\x1b]2;")).toBe(true);
			expect(encoded.endsWith("\x07")).toBe(true);
			const body = encoded.slice("\x1b]2;".length, -1);
			expect(hasControl(body)).toBe(false);

			// What survives is the payload with its controls dropped and
			// everything else kept, in order -- not merely something safe.
			let expected = "";
			for (const char of payload) {
				if (!isControl(char.codePointAt(0)!)) {
					expected += char;
				}
			}
			expect(body).toBe(expected);
		}),
		assertOptions,
	);
});

test("no text in a document puts a control byte on the wire", async () => {
	await fc.assert(
		fc.asyncProperty(dangerous, async (payload) => {
			const terminal = new MockProcess({rows: 4, cols: 20});
			let raw = "";
			const write = terminal.stdout.write.bind(terminal.stdout);
			(terminal.stdout as unknown as {write: unknown}).write = (
				chunk: unknown,
				enc?: unknown,
				cb?: unknown,
			) => {
				raw += String(chunk);
				return (write as (...a: unknown[]) => unknown)(chunk, enc, cb);
			};
			const dom = new TermDOM({transport: terminal.transport});
			dom.document.body.textContent = payload;
			await nextFrame(dom);

			// The bytes the engine never emits for itself. ESC is not among
			// them -- the engine's own CSI and SGR output is made of them --
			// so the attacker's ESC-led sequences are checked whole below.
			for (const byte of [0x9b, 0x9d, 0x90, 0x07, 0x08, 0x00, 0x7f]) {
				expect(raw.includes(String.fromCharCode(byte))).toBe(false);
			}
			for (const opener of ["\x1b]", "\x1bP", "\x1b[2J"]) {
				expect(raw.includes(opener)).toBe(false);
			}

			// Liveness: every check above passes on a frame that painted
			// nothing, so the painted row has to be read as well. What lands
			// is the payload's own characters, controls dropped, in order.
			const painted = terminal.getVisibleText().split("\n")[0];
			expect(hasControl(painted)).toBe(false);
			let at = 0;
			for (const char of painted.replace(/\s+$/, "")) {
				at = payload.indexOf(char, at);
				expect(at).toBeGreaterThanOrEqual(0);
				at += char.length;
			}
			dom.dispose();
		}),
		assertOptions,
	);
});
