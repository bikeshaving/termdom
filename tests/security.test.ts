import {test, expect} from "@b9g/libuild/test";
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

test("control characters in text never reach the terminal output", async () => {
	// Mid-string, trailing, and lone -- the trailing case is the one that used
	// to survive, since stripping relied on the next glyph overwriting the cell.
	const payloads = [
		"before\x1b]0;pwned\x07after", // OSC window-title set, mid-string
		"tail\x1b", // lone trailing ESC
		"\x1b", // nothing but ESC
		"\x9b31mgotcha", // C1 CSI (single-byte, no ESC needed)
		"edge0123456789012345678\x1b", // control at the column boundary
		"a\x1b]0;t\x07\x1b]0;t\x07b", // repeated title sets
	];

	for (const payload of payloads) {
		const t = new MockProcess({rows: 4, cols: 20});
		const raw = captureRawOutput(t);
		const dom = new TermDOM({transport: t.transport});
		dom.document.body.textContent = payload;
		await nextFrame(dom);

		const out = raw();
		for (const byte of FORBIDDEN_BYTES) {
			expect(out.includes(String.fromCharCode(byte))).toBe(false);
		}
		for (const seq of FORBIDDEN_SEQUENCES) {
			expect(out.includes(seq)).toBe(false);
		}
		dom.dispose();
	}
});

test("a <script> in rendered HTML is inert (no code execution)", async () => {
	const t = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: t.transport});
	(globalThis as unknown as {__termdomPwned?: boolean}).__termdomPwned = false;
	// If jsdom ran scripts, either of these would flip the flag.
	dom.document.body.innerHTML =
		`<script>globalThis.__termdomPwned = true;</script>` +
		`<img src="x" onerror="globalThis.__termdomPwned = true;">` +
		`<div onclick="globalThis.__termdomPwned = true;">text</div>`;
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
