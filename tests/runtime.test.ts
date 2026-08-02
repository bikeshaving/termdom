import {describe, expect, test} from "@b9g/libuild/test";
import {stringWidth, stringWidthFallback} from "../src/internal/runtime.js";

/**
 * termdom uses Bun.stringWidth when it is available and stringWidthFallback
 * everywhere else. Width drives line breaking and cell alignment, so the two
 * have to agree exactly: if they diverge, the same document renders with
 * different wrapping and misaligned table borders on Node and Deno, and no
 * Bun-hosted test would notice, because under Bun the fallback never runs.
 *
 * These tests hold the fallback against Bun.stringWidth directly, so they only
 * run under Bun -- on Node/Deno there is nothing to compare against.
 */
const bunStringWidth =
	typeof Bun !== "undefined" ? Bun.stringWidth.bind(Bun) : null;

(bunStringWidth ? describe : describe.skip)(
	"stringWidthFallback matches Bun.stringWidth",
	() => {
		const cases: Array<[string, string]> = [
			["ASCII", "hello world"],
			["empty", ""],
			["CJK ideographs", "中文字"],
			["hiragana", "こんにちは"],
			["katakana", "カタカナ"],
			["CJK punctuation", "、。「」"],
			["fullwidth forms", "ＡＢＣ"],
			["hangul", "한글"],
			["mixed CJK and ASCII", "中a文b字c"],
			["emoji", "🚀"],
			["emoji ZWJ sequence", "👨‍👩‍👧"],
			["emoji with variation selector", "⚡️"],
			["heart with variation selector", "❤️"],
			["default-presentation symbol", "✅"],
			["regional indicator flag", "🇯🇵"],
			["lone regional indicator", "🇯"],
			["combining accent", "é"],
			["box drawing", "─│┌┐└┘"],
			["arrows", "→←↑↓"],
			["zero width joiner", "‍"],
			["lone variation selector", "️"],
			["ASCII with variation selector", "b️"],
			["digit with variation selector", "1️"],
		];

		for (const [name, input] of cases) {
			test(name, () => {
				expect(stringWidthFallback(input)).toBe(bunStringWidth!(input));
			});
		}

		test("every codepoint in the BMP and astral planes", () => {
			const mismatches: string[] = [];
			for (let code = 0; code <= 0x3ffff; code++) {
				// Lone surrogates are not characters.
				if (code >= 0xd800 && code <= 0xdfff) continue;
				const char = String.fromCodePoint(code);
				if (stringWidthFallback(char) !== bunStringWidth!(char)) {
					mismatches.push(`U+${code.toString(16).toUpperCase()}`);
				}
			}
			expect(mismatches).toEqual([]);
		});

		test("random strings of mixed scripts, emoji and marks", () => {
			const pool = [
				..."abcXYZ 019",
				..."中文字",
				..."こんにちは",
				..."カタカナ",
				..."한글",
				"🚀",
				"👨‍👩‍👧",
				"⚡️",
				"✅",
				"❤️",
				"é",
				"、",
				"ＡＢ",
				"─",
				"→",
				"́",
				"‍",
				"️",
				"🇯🇵",
			];

			// Deterministic PRNG: a flaky width test would be miserable to debug.
			let seed = 12345;
			const next = () =>
				(seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

			const mismatches: string[] = [];
			for (let i = 0; i < 20000; i++) {
				let input = "";
				const length = 1 + Math.floor(next() * 8);
				for (let j = 0; j < length; j++) {
					input += pool[Math.floor(next() * pool.length)];
				}

				if (stringWidthFallback(input) !== bunStringWidth!(input)) {
					mismatches.push(JSON.stringify(input));
				}
			}
			expect(mismatches).toEqual([]);
		});
	},
);

/**
 * The one place the two deliberately DISAGREE, and why stringWidth() gates on
 * it: Bun.stringWidth charges a cell per code point, so a combining mark --
 * which renders onto the character before it and advances nothing -- is counted
 * as if it were a letter of its own.
 */
test("combining marks take the grapheme-aware path, not Bun's", () => {
	// "שָׁלוֹם": four Hebrew letters carrying three niqqud. Four cells.
	expect(stringWidth("שָׁלוֹם")).toBe(4);
	// Arabic with harakat: five letters, three marks.
	expect(stringWidth("مَرْحَبًا")).toBe(5);
	// Cyrillic with a combining titlo.
	expect(stringWidth("и҃")).toBe(1);
	// And the fast path is still exact for everything without them.
	expect(stringWidth("hello")).toBe(5);
	expect(stringWidth("中文")).toBe(4);
});
