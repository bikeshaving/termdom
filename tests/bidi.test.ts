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
	// never reversed. Treating them as neutral turned "2.1" into "1.2".
	const visual = toVisualOrder("مرحبا Bun 2.1", "rtl");
	expect(visual).toContain("Bun 2.1");
	expect(visual.indexOf("Bun")).toBeLessThan(visual.indexOf("م"));
});

test("Arabic-Indic digits are not reversed either", () => {
	expect(toVisualOrder("١٢٣", "rtl")).toContain("١٢٣");
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
