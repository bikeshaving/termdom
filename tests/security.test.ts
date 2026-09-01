import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// TermDOM renders UNTRUSTED content -- a Markdown file, an LLM reply in the chat
// example. Two properties must hold: it never executes that content as code, and
// it never lets that content's control characters reach the terminal as raw
// escape bytes (cursor moves, window-title sets, clipboard writes...).

function captureRawOutput(t: MockProcess): () => string {
	let raw = "";
	const orig = t.stdout.write.bind(t.stdout);
	(t.stdout as unknown as {write: unknown}).write = (
		chunk: unknown,
		enc?: unknown,
		cb?: unknown,
	) => {
		raw += String(chunk);
		return (orig as (...a: unknown[]) => unknown)(chunk, enc, cb);
	};
	return () => raw;
}

// Control bytes TermDOM NEVER emits itself, so any occurrence is smuggled
// through text content. (Bare ESC 0x1b is excluded: TermDOM emits it for its
// own CSI/SGR output, so its mere presence proves nothing -- the attacker's
// ESC-based sequences are checked as whole strings instead.)
const FORBIDDEN_BYTES: number[] = [
	0x9b, // C1 CSI
	0x9d, // C1 OSC
	0x90, // C1 DCS
	0x07, // BEL
	0x08, // BS
	0x00, // NUL
	0x7f, // DEL
];
// Whole attacker sequences that must never appear intact in the output.
const FORBIDDEN_SEQUENCES = ["\x1b]0;", "\x1b[2J", "\x1b]", "\x1bP"];

// Each payload with the row it must paint: the control characters gone and
// every other character kept. Asserting the row is what catches a control
// character that reached a CELL -- a lone ESC forms none of the sequences
// below, so the byte checks alone cannot see it, and the trailing case is the
// one that used to survive.
const PAYLOADS: Array<[string, string]> = [
	// OSC window-title set, mid-string.
	["before\x1b]0;pwned\x07after", "before]0;pwnedafter"],
	["tail\x1b", "tail"],
	["\x1b", ""],
	// C1 CSI, a single byte needing no ESC.
	["\x9b31mgotcha", "31mgotcha"],
	// A control at the column boundary, on a terminal 20 columns wide.
	["edge0123456789012345678\x1b", "edge0123456789012345"],
	["a\x1b]0;t\x07\x1b]0;t\x07b", "a]0;t]0;tb"],
];

// One test per payload rather than a loop: a payload whose escape reaches the
// terminal takes the emulator with it, and a loop lets that one smother every
// case after it.
for (const [payload, painted] of PAYLOADS) {
	test(`control characters never reach the terminal: ${JSON.stringify(payload)}`,
		async () => {
			const t = new MockProcess({rows: 4, cols: 20});
			const raw = captureRawOutput(t);
			const dom = new TermDOM({transport: t.transport});
			dom.document.body.textContent = payload;
			await nextFrame(dom);

			// The text reaches the screen stripped of its controls and whole
			// otherwise. This is also the liveness check the byte tests below
			// need: every one of them passes on a frame that painted nothing.
			expect(t.getVisibleText().split("\n")[0]).toBe(painted);

			const out = raw();
			for (const byte of FORBIDDEN_BYTES) {
				expect(out.includes(String.fromCharCode(byte))).toBe(false);
			}
			for (const seq of FORBIDDEN_SEQUENCES) {
				expect(out.includes(seq)).toBe(false);
			}
			dom.dispose();
		});
}

/**
 * The title does not go through the cell grid: it is interpolated into an OSC
 * sequence and written straight to the terminal. A control character in it
 * ends that sequence early and hands the rest of the string to the terminal as
 * its own commands, so it is sanitized where it is encoded.
 */
test("a title never carries its own escape sequences to the terminal", async () => {
	const t = new MockProcess({rows: 4, cols: 20});
	const dom = new TermDOM({transport: t.transport});
	await nextFrame(dom);
	const raw = captureRawOutput(t);

	// BEL ends the OSC, the second OSC retitles the window, the CSI wipes the
	// screen. All three are the document's text, none of them are commands.
	dom.document.title = "safe\x07\x1b]0;PWNED\x07\x1b[2J";
	await nextFrame(dom);

	// The title rides the write queue, so wait for it to arrive rather than
	// for a fixed span -- under a loaded runner a fixed one is a coin flip.
	const deadline = Date.now() + 2000;
	while (!raw().includes("\x1b]2;") && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5));
	}

	const out = raw();
	expect(out).toContain("\x1b]2;safe]0;PWNED[2J\x07");
	for (const byte of FORBIDDEN_BYTES) {
		if (byte === 0x07) {
			continue; // the terminator this sequence legitimately ends with
		}
		expect(out.includes(String.fromCharCode(byte))).toBe(false);
	}
	expect(out.includes("\x1b]0;")).toBe(false);
	expect(out.includes("\x1b[2J")).toBe(false);
	dom.dispose();
});

test("a <script> in rendered HTML is inert (no code execution)", async () => {
	const t = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: t.transport});
	(globalThis as unknown as {__termdomPwned?: boolean}).__termdomPwned = false;
	// If parsed scripts ran, either of these would flip the flag.
	dom.document.body.innerHTML =
		"<script>globalThis.__termdomPwned = true;</script>" +
		"<img src=\"x\" onerror=\"globalThis.__termdomPwned = true;\">" +
		"<div onclick=\"globalThis.__termdomPwned = true;\">text</div>";
	await nextFrame(dom);
	// Click the handler-bearing div: an inline on* attribute must not execute.
	dom.document
		.querySelector("div")
		?.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
	await nextFrame(dom);

	expect(
		(globalThis as unknown as {__termdomPwned?: boolean}).__termdomPwned,
	).toBe(false);
	dom.dispose();
});
