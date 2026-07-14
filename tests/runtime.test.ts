import {describe, expect, test} from "bun:test";
import {stringWidthFallback} from "../src/runtime.js";

/**
 * termdom uses Bun.stringWidth when it is available and stringWidthFallback
 * everywhere else. Width drives line breaking and cell alignment, so the two
 * have to agree exactly: if they diverge, the same document renders with
 * different wrapping and misaligned table borders on Node and Deno, and no
 * Bun-hosted test would notice, because under Bun the fallback never runs.
 *
 * These tests hold the fallback against Bun.stringWidth directly.
 */
describe("stringWidthFallback matches Bun.stringWidth", () => {
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
			expect(stringWidthFallback(input)).toBe(Bun.stringWidth(input));
		});
	}

	test("every codepoint in the BMP and astral planes", () => {
		const mismatches: string[] = [];
		for (let code = 0; code <= 0x3ffff; code++) {
			// Lone surrogates are not characters.
			if (code >= 0xd800 && code <= 0xdfff) continue;
			const char = String.fromCodePoint(code);
			if (stringWidthFallback(char) !== Bun.stringWidth(char)) {
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

			if (stringWidthFallback(input) !== Bun.stringWidth(input)) {
				mismatches.push(JSON.stringify(input));
			}
		}
		expect(mismatches).toEqual([]);
	});
});
