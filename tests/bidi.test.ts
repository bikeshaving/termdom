/**
 * Right-to-left text.
 *
 * Terminals overwhelmingly do not run the Unicode bidirectional algorithm, and
 * this renderer paints single cells at absolute positions -- so termdom takes
 * the explicit side of ECMA-48's BDSM contract and hands over cells that are
 * already in visual order. These tests pin both halves: the reordering itself,
 * and the negotiation that decides whether we do it at all.
 */

import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils.js";
import {TermDOM} from "../src/internal/termdom.js";
import {
	hasRTL,
	inferParagraphDirection,
	toVisualOrder,
} from "../src/internal/bidi.js";

const HEBREW = "שלום";
const HEBREW_VISUAL = [...HEBREW].reverse().join("");

test("a right-to-left run is reversed into visual order", () => {
	expect(toVisualOrder(HEBREW, "rtl")).toBe(HEBREW_VISUAL);
	expect(toVisualOrder("hello", "ltr")).toBe("hello");
});

test("numbers keep their own direction inside RTL text", () => {
	// UAX #9 gives digits their own weak classes; the effect is that a number is
	// never reversed, in either script's numerals.
	const visual = toVisualOrder("مرحبا Bun 2.1", "rtl");
	expect(visual).toContain("Bun 2.1");
	// The Latin run sits to the LEFT of the Arabic in an RTL paragraph.
	expect(visual.indexOf("Bun")).toBeLessThan(
		visual.search(/\p{Script=Arabic}/u),
	);
});

test("Arabic-Indic digits are not reversed either", () => {
	expect(toVisualOrder("١٢٣", "rtl")).toContain("١٢٣");
});

test("Arabic letters are shaped into their contextual forms", () => {
	// Arabic is cursive: a letter takes a different form depending on its
	// neighbours, so reordering alone leaves disconnected isolated letters.
	// Hebrew does not join and passes through untouched.
	const visual = toVisualOrder("مرحبا", "rtl");
	expect(visual).not.toContain("م"); // U+0645, the isolated form
	// Presentation forms only (U+FE70..U+FEFF).
	expect(/^[\uFE70-\uFEFF]+$/.test(visual)).toBe(true);
	expect(toVisualOrder("שלום", "rtl")).toBe([..."שלום"].reverse().join(""));
});

test("a lam-alef ligature collapses two characters into one", () => {
	// Which is why shaping runs at the END of layout and never on the text that
	// gets measured: doing it earlier would slide every character offset after
	// it, and those offsets are what the caret and selection are expressed in.
	const visual = toVisualOrder("لا", "rtl");
	expect([...visual].length).toBe(1);
	expect(visual.codePointAt(0)).toBe(0xfefb);
});

test("an LTR paragraph reverses only its RTL islands", () => {
	const visual = toVisualOrder(`hello ${HEBREW} world`, "ltr");
	expect(visual).toBe(`hello ${HEBREW_VISUAL} world`);
});

test("paired punctuation is mirrored inside an RTL run", () => {
	// A terminal will not mirror the glyph for us, so the codepoint itself has
	// to change: the parenthesis that opens the group sits at its right edge.
	const visual = toVisualOrder("شكرا (نعم)", "rtl");
	expect(visual.startsWith("(")).toBe(true);
	expect(visual.indexOf(")")).toBeGreaterThan(0);
});

test("paragraph direction is inferred from the first strong character", () => {
	expect(inferParagraphDirection("hello שלום")).toBe("ltr");
	expect(inferParagraphDirection("שלום hello")).toBe("rtl");
	expect(inferParagraphDirection("123 !?")).toBe("ltr");
	expect(hasRTL("plain ascii")).toBe(false);
});

test("undeclared RTL text still paints in visual order", async () => {
	// The common way such a string arrives: no dir attribute, no CSS, just
	// Hebrew dropped into a div. The content decides the direction.
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>${HEBREW}</div>`;

	await nextFrame(dom);
	await nextFrame(dom);

	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(HEBREW_VISUAL);

	dom.dispose();
});

test("direction: rtl right-aligns the line and keeps Latin runs readable", async () => {
	const terminal = new MockProcess({cols: 30, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="direction: rtl; width: 20ch">مرحبا Bun</div>`;

	await nextFrame(dom);
	await nextFrame(dom);

	const line = terminal.getPlainText().split("\n")[0];
	// Right-aligned: `start` means the start of the reading direction.
	expect(line.startsWith(" ")).toBe(true);
	// The Latin word survives left-to-right, to the left of the Arabic.
	expect(line).toContain("Bun");

	dom.dispose();
});

test("the terminal is asked to leave bidi to us, and its answer is honoured", async () => {
	// MockProcess wraps a real headless terminal, which does not implement BDSM
	// and answers DECRQM with 0 ("not recognised") -- so we reorder.
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>${HEBREW}</div>`;

	await nextFrame(dom);
	await nextFrame(dom);

	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(HEBREW_VISUAL);

	dom.dispose();
});

test("a terminal that insists on reordering gets logical order instead", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const stdout = terminal.stdout as unknown as {
		write: (...args: unknown[]) => boolean;
	};
	const original = stdout.write.bind(stdout);
	// Swallow the probe before the headless terminal can answer it, and reply
	// the way a terminal with permanent implicit bidi would.
	stdout.write = (...args: unknown[]) => {
		const data = String(args[0]);
		if (data.includes("\x1b[8$p")) {
			setTimeout(
				() =>
					(
						terminal.stdin as unknown as {simulateResponse: (s: string) => void}
					).simulateResponse("\x1b[8;3$y"),
				0,
			);
			const rest = data.replace("\x1b[8l", "").replace("\x1b[8$p", "");
			return rest ? original(rest, ...args.slice(1)) : true;
		}
		return original(...args);
	};

	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>${HEBREW}</div>`;
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 60));
	await nextFrame(dom);
	await nextFrame(dom);

	// Doing it twice is a sentence backwards again, so we stand down.
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(HEBREW);

	dom.dispose();
});

test("grapheme-cluster mode is negotiated, and given back on dispose", async () => {
	// Mode 2027 (terminal-unicode-core): terminals measure by POSIX wcwidth,
	// which is per code point and cannot express a ZWJ sequence as one unit.
	// We measure by cluster, so this asks the terminal to agree.
	const terminal = new MockProcess({cols: 20, rows: 4});
	const stdout = terminal.stdout as unknown as {
		write: (...args: unknown[]) => boolean;
	};
	const original = stdout.write.bind(stdout);
	const seen: string[] = [];
	stdout.write = (...args: unknown[]) => {
		const data = String(args[0]);
		seen.push(data);
		if (data.includes("\x1b[?2027$p")) {
			setTimeout(
				() =>
					(
						terminal.stdin as unknown as {simulateResponse: (s: string) => void}
					).simulateResponse("\x1b[?2027;1$y"),
				0,
			);
			const rest = data.replace("\x1b[?2027h", "").replace("\x1b[?2027$p", "");
			return rest ? original(rest, ...args.slice(1)) : true;
		}
		return original(...args);
	};

	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>hi</div>`;
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 60));
	dom.dispose();

	const all = seen.join("");
	expect(all).toContain("\x1b[?2027h");
	expect(all).toContain("\x1b[?2027$p");
	// Ours to turn off, since it was ours to turn on.
	expect(all).toContain("\x1b[?2027l");

	dom.dispose();
});

test("a terminal that ignores mode 2027 is left alone", async () => {
	// Silence is the common answer, and means the same as "not recognised": our
	// measurements do not change, only whether the terminal agrees with them.
	const terminal = new MockProcess({cols: 20, rows: 4});
	const stdout = terminal.stdout as unknown as {
		write: (...args: unknown[]) => boolean;
	};
	const original = stdout.write.bind(stdout);
	const seen: string[] = [];
	stdout.write = (...args: unknown[]) => {
		seen.push(String(args[0]));
		return original(...args);
	};

	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>hi</div>`;
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	dom.dispose();

	// Nothing to restore: the mode never took.
	expect(seen.join("")).not.toContain("\x1b[?2027l");

	dom.dispose();
});
