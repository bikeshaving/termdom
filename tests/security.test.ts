import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

// TermDOM renders UNTRUSTED content -- a Markdown file, an LLM reply in the chat
// example. Two properties must hold: it never executes that content as code, and
// it never lets that content's control characters reach the terminal as raw
// escape bytes (cursor moves, window-title sets, clipboard writes...).

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

// The strings the engine writes for itself: the overline probe and the
// question about the background, fixed, with nothing of the document in
// them.
const OVERLINE_PROBE = "\x1b[53m\x1bP$qm\x1b\\\x1b[55m";
const BACKGROUND_QUERY = "\x1b]11;?\x1b\\";

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

			const out = raw()
				.split(OVERLINE_PROBE)
				.join("")
				.split(BACKGROUND_QUERY)
				.join("");
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

test("a <script> in rendered HTML is inert, and a handler attribute is the app's", async () => {
	const t = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: t.transport});
	const flags = globalThis as unknown as {
		__termdomScript?: boolean;
		__termdomHandler?: boolean;
	};
	flags.__termdomScript = false;
	flags.__termdomHandler = false;
	// A parsed script never runs: the engine loads nothing. A handler
	// attribute runs when its event fires, as in a browser, because the
	// markup is the app's own and untrusted markup is the app's to
	// sanitize before it reaches innerHTML.
	dom.document.body.innerHTML =
		"<script>globalThis.__termdomScript = true;</script>" +
		"<div onclick=\"globalThis.__termdomHandler = this.tagName === 'DIV' && event.type === 'click';\">text</div>";
	await nextFrame(dom);
	expect(flags.__termdomScript).toBe(false);
	expect(flags.__termdomHandler).toBe(false);
	dom.document
		.querySelector("div")
		?.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
	await nextFrame(dom);
	expect(flags.__termdomScript).toBe(false);
	expect(flags.__termdomHandler).toBe(true);
	dom.dispose();
});

// A document an author builds through the DOM -- a DOMParser result,
// createHTMLDocument, a <template>'s contents, an iframe's content document --
// has no browsing context, so scripting is disabled for it. Its handler
// content attributes must stay inert: they never compile or run, even for the
// events the engine dispatches on its own (a <details open> toggle, an
// <iframe> load), and they reflect as null. This is the guarantee a sanitizer
// such as DOMPurify leans on -- it parses hostile markup into exactly these
// documents, measures it, and strips the handlers before any node is adopted
// into the live, scripted document. If the inert pass could execute, sanitizing
// the markup would run it.

// A spin past the microtask queue and one macrotask: `<details open>` queues
// its toggle in a microtask, an `<iframe>` fires load from a `setTimeout(0)`.
async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

// Markup whose handlers fire with no user interaction: the open details
// toggles and the iframe loads as soon as each is parsed into a document.
const AUTO_FIRING =
	"<details open ontoggle=\"globalThis.__termdomInert = true\"></details>" +
	"<iframe onload=\"globalThis.__termdomInert = true\"></iframe>";

type InertFlags = {__termdomInert?: boolean};

test("a handler in a DOMParser document is inert and reflects as null", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const flags = globalThis as unknown as InertFlags;
	flags.__termdomInert = false;

	const parsed = new dom.window.DOMParser().parseFromString(
		`<body ontoggle="globalThis.__termdomInert = true">${AUTO_FIRING}</body>`,
		"text/html",
	);
	// Reading the reflected handler must not compile it either.
	expect(parsed.body.onload).toBe(null);
	const details = parsed.querySelector("details");
	details?.removeAttribute("open");
	details?.setAttribute("open", "");
	await settle();

	expect(flags.__termdomInert).toBe(false);
	dom.dispose();
});

test("a handler in a createHTMLDocument document is inert", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const flags = globalThis as unknown as InertFlags;
	flags.__termdomInert = false;

	const built = dom.document.implementation.createHTMLDocument("x");
	built.body.innerHTML = AUTO_FIRING;
	const details = built.querySelector("details");
	expect(details?.ontoggle).toBe(null);
	details?.removeAttribute("open");
	details?.setAttribute("open", "");
	await settle();

	expect(flags.__termdomInert).toBe(false);
	dom.dispose();
});

test("a handler in a <template>'s contents is inert", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const flags = globalThis as unknown as InertFlags;
	flags.__termdomInert = false;

	const template = dom.document.createElement("template");
	template.innerHTML = AUTO_FIRING;
	const details = template.content.querySelector("details");
	expect(details?.ontoggle).toBe(null);
	details?.removeAttribute("open");
	details?.setAttribute("open", "");
	await settle();

	expect(flags.__termdomInert).toBe(false);
	dom.dispose();
});

test("a handler in an iframe's content document is inert", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const flags = globalThis as unknown as InertFlags;
	flags.__termdomInert = false;

	const iframe = dom.document.createElement("iframe");
	iframe.setAttribute("srcdoc", AUTO_FIRING);
	dom.document.body.append(iframe);
	// Build the content document, as reading it in the app would.
	void iframe.contentDocument;
	await settle();

	expect(flags.__termdomInert).toBe(false);
	dom.dispose();
});

test("a handler compiles once its node is adopted into the live document", async () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const flags = globalThis as unknown as InertFlags;
	flags.__termdomInert = false;

	// Built in an inert document, the handler does not compile...
	const built = dom.document.implementation.createHTMLDocument("x");
	built.body.innerHTML =
		"<div onclick=\"globalThis.__termdomInert = true\">text</div>";
	const div = built.querySelector("div")!;
	expect(div.onclick).toBe(null);

	// ...but adopting it into the live, scripted document makes it the app's
	// own markup again, exactly as in a browser.
	dom.document.body.append(dom.document.adoptNode(div));
	const adopted = div as unknown as {onclick: unknown};
	expect(typeof adopted.onclick).toBe("function");
	div.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
	await nextFrame(dom);
	expect(flags.__termdomInert).toBe(true);
	dom.dispose();
});
