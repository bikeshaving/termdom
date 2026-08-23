/**
 * The width-parity domain, shared by the oracle generator and the width
 * tests so both sweep the same inputs: the named cases, the planes sweep
 * with its exclusions, and the deterministic mixed-script strings.
 */

export const ORACLE_CASES: Array<[string, string]> = [
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

/**
 * One codepoint of the planes sweep: the oracle's width, or -1 for the
 * codepoints the models differ on by design -- surrogates, marks, format
 * and unassigned characters, conjoining jamo, runtime-probed uncertain
 * widths, and the spacing signs Bun zero-rates although they take a cell.
 */
export function oracleSweepWidth(
	code: number,
	width: (input: string) => number,
	uncertain: (cluster: string) => boolean,
): number {
	if (code >= 0xd800 && code <= 0xdfff) {
		return -1;
	}
	const char = String.fromCodePoint(code);
	if (/^[\p{M}\p{Cf}\p{Cn}\p{Co}]$/u.test(char)) {
		return -1;
	}
	if (
		(code >= 0x1160 && code <= 0x11ff) || (code >= 0xd7b0 && code <= 0xd7fb)
	) {
		return -1;
	}
	if (uncertain(char)) {
		return -1;
	}
	if (code === 0x980 || code === 0xc80 || code === 0xd3a) {
		return -1;
	}
	return width(char);
}

/**
 * The mixed-script strings, from a deterministic PRNG: a flaky width test
 * would be miserable to debug, and the generator and the test must draw
 * the same sequence.
 */
export function randomMixedStrings(): Array<[number, string]> {
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
		"🇯🇵",
	];
	let seed = 12345;
	const next = () =>
		(seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const strings: Array<[number, string]> = [];
	for (let i = 0; i < 20000; i++) {
		let input = "";
		const length = 1 + Math.floor(next() * 8);
		for (let j = 0; j < length; j++) {
			input += pool[Math.floor(next() * pool.length)];
		}
		strings.push([i, input]);
	}
	return strings;
}
