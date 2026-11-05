/**
 * Runs Unicode's bidi conformance files, BidiCharacterTest.txt and
 * BidiTest.txt, against an implementation with bidi-js's shape. A case
 * passes when the resolved paragraph level, each resolved level, and the
 * visual order all match. Shared by tests/bidi-conformance.test.ts, which
 * runs a checked-in subset, and scripts/generate-bidi-conformance.ts,
 * which runs the full files and writes that subset.
 */

export interface BidiImplementation {
	getEmbeddingLevels(
		text: string,
		direction?: "ltr" | "rtl" | "auto",
	): {
		levels: Uint8Array;
		paragraphs: Array<{start: number; end: number; level: number}>;
	};
	getReorderedString(
		text: string,
		embedding: ReturnType<BidiImplementation["getEmbeddingLevels"]>,
	): string;
}

export interface ConformanceResult {
	passed: number;
	failed: string[];
}

const DIRECTIONS = ["ltr", "rtl", "auto"] as const;

// A character of each class that is neither a bracket nor mirrored.
const REPRESENTATIVES: Record<string, number> = {
	L: 0x61,
	R: 0x5d0,
	AL: 0x627,
	EN: 0x30,
	ES: 0x2b,
	ET: 0x24,
	AN: 0x660,
	CS: 0x2c,
	NSM: 0x300,
	BN: 0xad,
	B: 0x2029,
	S: 0x9,
	WS: 0x20,
	ON: 0x21,
	LRE: 0x202a,
	LRO: 0x202d,
	RLE: 0x202b,
	RLO: 0x202e,
	PDF: 0x202c,
	LRI: 0x2066,
	RLI: 0x2067,
	FSI: 0x2068,
	PDI: 0x2069,
};

function check(
	bidi: BidiImplementation,
	codes: number[],
	direction: "ltr" | "rtl" | "auto",
	paragraphLevel: number | null,
	levels: string[],
	order: number[],
): boolean {
	const text = String.fromCodePoint(...codes);
	const result = bidi.getEmbeddingLevels(text, direction);
	if (
		paragraphLevel !== null && result.paragraphs[0]?.level !== paragraphLevel
	) {
		return false;
	}
	const removed = new Set<number>();
	let offset = 0;
	for (let k = 0; k < codes.length; k++) {
		if (levels[k] === "x") {
			removed.add(codes[k]);
		} else if (result.levels[offset] !== Number(levels[k])) {
			return false;
		}
		offset += codes[k] > 0xffff ? 2 : 1;
	}
	const mirror = (code: number): number => {
		const single = String.fromCodePoint(code);
		return bidi
			.getReorderedString(single, {
				levels: Uint8Array.of(1, 1),
				paragraphs: [{start: 0, end: single.length - 1, level: 1}],
			})
			.codePointAt(0)!;
	};
	const expected = String.fromCodePoint(
		...order.map((k) => Number(levels[k]) & 1 ? mirror(codes[k]) : codes[k]),
	);
	const visual = String.fromCodePoint(
		...Array.from(
			bidi.getReorderedString(text, result),
			(c) => c.codePointAt(0)!,
		).filter((code) => !removed.has(code)),
	);
	return visual === expected;
}

function numbers(field: string): number[] {
	return field.trim() === "" ? [] : field.trim().split(/\s+/).map(Number);
}

/** BidiCharacterTest.txt: code points; direction; level; levels; order. */
export function runCharacterTest(
	bidi: BidiImplementation,
	file: string,
): ConformanceResult {
	const result: ConformanceResult = {passed: 0, failed: []};
	for (const line of file.split("\n")) {
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const fields = line.split(";");
		const codes = fields[0].trim()
			.split(/\s+/)
			.map((code) => parseInt(code, 16));
		const ok = check(
			bidi,
			codes,
			DIRECTIONS[Number(fields[1])],
			Number(fields[2]),
			fields[3].trim().split(/\s+/),
			numbers(fields[4]),
		);
		if (ok) {
			result.passed++;
		} else {
			result.failed.push(line);
		}
	}
	return result;
}

/**
 * BidiTest.txt: @Levels and @Reorder lines, then class sequences with a
 * bitset of paragraph directions (1 auto, 2 LTR, 4 RTL). A sequence counts
 * once per direction.
 */
export function runClassTest(
	bidi: BidiImplementation,
	file: string,
): ConformanceResult {
	const result: ConformanceResult = {passed: 0, failed: []};
	let levels: string[] = [];
	let order: number[] = [];
	for (const line of file.split("\n")) {
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("@Levels:")) {
			levels = line.slice(8).trim().split(/\s+/);
			continue;
		}
		if (line.startsWith("@Reorder:")) {
			order = numbers(line.slice(9));
			continue;
		}
		if (line.startsWith("@")) {
			continue;
		}
		const [input, bits] = line.split(";");
		const codes = input
			.trim()
			.split(/\s+/)
			.map((name) => REPRESENTATIVES[name]);
		const bitset = parseInt(bits.trim(), 16);
		for (const [
			bit,
			direction,
		] of [[1, "auto"], [2, "ltr"], [4, "rtl"]] as const) {
			if (!(bitset & bit)) {
				continue;
			}
			if (check(bidi, codes, direction, null, levels, order)) {
				result.passed++;
			} else {
				result.failed.push(`${direction}: ${line}`);
			}
		}
	}
	return result;
}
