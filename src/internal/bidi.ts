/**
 * UAX #9, the Unicode bidirectional algorithm, through rule L2 with L4's
 * mirroring. The algorithm is bidi-js 1.1.0's, its character data replaced
 * with src/generated/biditables.ts, and it reads a string by code point,
 * so a supplementary character takes its own class and its two code units
 * keep their order when reversed.
 *
 * bidi-js: Copyright (c) 2021 Jason Johnston
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import {
	BIDI_BRACKETS,
	BIDI_CLASS_RUNS,
	BIDI_CLASSES,
	BIDI_MIRRORS,
} from "../generated/biditables.ts";

export interface BidiParagraph {
	start: number;
	end: number;
	level: number;
}

/** Resolved levels, one per UTF-16 code unit, and the paragraphs. */
export interface EmbeddingLevels {
	levels: Uint8Array;
	paragraphs: BidiParagraph[];
}

// One bit per class, in BIDI_CLASSES order.
const L = 1 << 0;
const R = 1 << 1;
const EN = 1 << 2;
const ES = 1 << 3;
const ET = 1 << 4;
const AN = 1 << 5;
const CS = 1 << 6;
const B = 1 << 7;
const S = 1 << 8;
const WS = 1 << 9;
const ON = 1 << 10;
const BN = 1 << 11;
const NSM = 1 << 12;
const AL = 1 << 13;
const LRO = 1 << 14;
const RLO = 1 << 15;
const LRE = 1 << 16;
const RLE = 1 << 17;
const PDF = 1 << 18;
const LRI = 1 << 19;
const RLI = 1 << 20;
const FSI = 1 << 21;
const PDI = 1 << 22;

const ISOLATE_INIT = LRI | RLI | FSI;
const STRONG = L | R | AL;
const NEUTRAL_ISOLATE = B | S | WS | ON | FSI | LRI | RLI | PDI;
const BN_LIKE = BN | RLE | LRE | RLO | LRO | PDF;
const TRAILING = S | WS | B | ISOLATE_INIT | PDI | BN_LIKE;
const FORMATTING = RLE | LRE | RLO | LRO | ISOLATE_INIT | PDI | PDF | B;
const MAX_DEPTH = 125;

let runStarts: Uint32Array | undefined;
let runClasses: Uint32Array;
let latin1: Uint32Array;
let mirrorCodes: Uint32Array;
let mirrorOffsets: Int32Array;
let bracketCodes: Uint32Array;
let bracketIds: Int32Array;

function decodeTables(): void {
	if (BIDI_CLASSES.split(" ").length !== 23) {
		throw new Error("bidi tables do not match bidi.ts");
	}
	const starts: number[] = [];
	const classes: number[] = [];
	let next = 0;
	for (const [, letter, length] of BIDI_CLASS_RUNS.matchAll(
		/([A-Z])([0-9a-z]+)/g,
	)) {
		starts.push(next);
		classes.push(1 << (letter.charCodeAt(0) - 65));
		next += parseInt(length, 36);
	}
	runClasses = Uint32Array.from(classes);
	runStarts = Uint32Array.from(starts);
	latin1 = new Uint32Array(256);
	for (let code = 0, run = 0; code < 256; code++) {
		while (run + 1 < starts.length && starts[run + 1] <= code) {
			run++;
		}
		latin1[code] = classes[run];
	}

	const mirrors = BIDI_MIRRORS.split(",");
	mirrorCodes = new Uint32Array(mirrors.length);
	mirrorOffsets = new Int32Array(mirrors.length);
	next = 0;
	mirrors.forEach((entry, i) => {
		const [delta, offset] = entry.split(":");
		next += parseInt(delta, 36);
		mirrorCodes[i] = next;
		mirrorOffsets[i] = parseInt(offset, 36);
	});

	// A bracket's id is its pair's canonical opening bracket, negated for a
	// closing bracket.
	const brackets = BIDI_BRACKETS.split(",");
	bracketCodes = new Uint32Array(brackets.length);
	bracketIds = new Int32Array(brackets.length);
	next = 0;
	brackets.forEach((entry, i) => {
		const open = entry.includes(">");
		const [delta, offset] = entry.split(open ? ">" : "<");
		next += parseInt(delta, 36);
		bracketCodes[i] = next;
		const id = next + parseInt(offset, 36);
		bracketIds[i] = open ? id : -id;
	});
}

function search(codes: Uint32Array, code: number): number {
	let low = 0;
	let high = codes.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (codes[mid] < code) {
			low = mid + 1;
		} else if (codes[mid] > code) {
			high = mid - 1;
		} else {
			return mid;
		}
	}
	return -1;
}

function getClass(code: number): number {
	if (code < 256) {
		return latin1[code];
	}
	const starts = runStarts!;
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= code) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return runClasses[low];
}

function getMirror(code: number): number {
	const index = search(mirrorCodes, code);
	return index === -1 ? code : code + mirrorOffsets[index];
}

// 0 for a character that is not a paired bracket.
function getBracketId(code: number): number {
	const index = search(bracketCodes, code);
	return index === -1 ? 0 : bracketIds[index];
}

function isSurrogatePair(text: string, i: number): boolean {
	const high = text.charCodeAt(i);
	if (high < 0xd800 || high > 0xdbff || i + 1 >= text.length) {
		return false;
	}
	const low = text.charCodeAt(i + 1);
	return low >= 0xdc00 && low <= 0xdfff;
}

interface Status {
	level: number;
	override: number;
	isolate: boolean;
	isolateStart: number;
}

interface IsolatingRunSequence {
	indices: number[];
	sos: number;
	eos: number;
}

/**
 * Resolve embedding levels for a string. `direction` forces the paragraph
 * direction; omitted or "auto", P2 and P3 infer it from the first strong
 * character.
 */
export function getEmbeddingLevels(
	text: string,
	direction?: "ltr" | "rtl" | "auto",
): EmbeddingLevels {
	if (runStarts === undefined) {
		decodeTables();
	}

	const length = text.length;
	const types = new Uint32Array(length);
	for (let i = 0; i < length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 256) {
			types[i] = latin1[unit];
		} else if (isSurrogatePair(text, i)) {
			types[i] = types[i + 1] = getClass(text.codePointAt(i)!);
			i++;
		} else {
			types[i] = getClass(unit);
		}
	}
	const initialTypes = types.slice();

	// Cleared at the start of each paragraph.
	const typeCounts = new Map<number, number>();
	const count = (type: number, by: number): void => {
		typeCounts.set(type, (typeCounts.get(type) ?? 0) + by);
		if (type & NEUTRAL_ISOLATE) {
			typeCounts.set(
				NEUTRAL_ISOLATE,
				(typeCounts.get(NEUTRAL_ISOLATE) ?? 0) + by,
			);
		}
	};
	const changeType = (i: number, type: number): void => {
		count(types[i], -1);
		types[i] = type;
		count(type, 1);
	};

	const levels = new Uint8Array(length);
	const isolationPairs = new Map<number, number>();

	const indexOfMatchingPDI = (isolateStart: number): number => {
		// BD9
		let depth = 1;
		for (let i = isolateStart + 1; i < length; i++) {
			const type = types[i];
			if (type & B) {
				break;
			}
			if (type & PDI) {
				if (--depth === 0) {
					return i;
				}
			} else if (type & ISOLATE_INIT) {
				depth++;
			}
		}
		return -1;
	};

	const determineAutoLevel = (start: number, isFSI: boolean): number => {
		// P2 and P3
		for (let i = start; i < length; i++) {
			const type = types[i];
			if (type & (R | AL)) {
				return 1;
			}
			if (type & (B | L) || (isFSI && type === PDI)) {
				return 0;
			}
			if (type & ISOLATE_INIT) {
				const pdi = indexOfMatchingPDI(i);
				i = pdi === -1 ? length : pdi;
			}
		}
		return 0;
	};

	// P1
	const paragraphs: BidiParagraph[] = [];
	let paragraph: BidiParagraph | null = null;
	for (let i = 0; i < length; i++) {
		if (!paragraph) {
			paragraphs.push(
				paragraph = {
					start: i,
					end: length - 1,
					level: direction === "rtl"
						? 1
						: direction === "ltr" ? 0 : determineAutoLevel(i, false),
				},
			);
		}
		if (types[i] & B) {
			paragraph.end = i;
			paragraph = null;
		}
	}

	const nextEven = (n: number) => n + (n & 1 ? 1 : 2);
	const nextOdd = (n: number) => n + (n & 1 ? 2 : 1);

	for (const paragraph of paragraphs) {
		const stack: Status[] = [
			{level: paragraph.level, override: 0, isolate: false, isolateStart: -1},
		];
		let top: Status;
		let overflowIsolates = 0;
		let overflowEmbeddings = 0;
		let validIsolates = 0;
		typeCounts.clear();

		// X1 through X8
		for (let i = paragraph.start; i <= paragraph.end; i++) {
			let type = types[i];
			top = stack[stack.length - 1];
			count(type, 1);

			if (type & FORMATTING) {
				if (type & (RLE | LRE | RLO | LRO)) {
					// X2 through X5
					levels[i] = top.level;
					const level = (type & (RLE | RLO) ? nextOdd : nextEven)(top.level);
					if (level <= MAX_DEPTH && !overflowIsolates && !overflowEmbeddings) {
						stack.push({
							level,
							override: type & RLO ? R : type & LRO ? L : 0,
							isolate: false,
							isolateStart: -1,
						});
					} else if (!overflowIsolates) {
						overflowEmbeddings++;
					}
				} else if (type & ISOLATE_INIT) {
					// X5a through X5c
					if (type & FSI) {
						type = determineAutoLevel(i + 1, true) === 1 ? RLI : LRI;
					}
					levels[i] = top.level;
					if (top.override) {
						changeType(i, top.override);
					}
					const level = (type === RLI ? nextOdd : nextEven)(top.level);
					if (level <= MAX_DEPTH && !overflowIsolates && !overflowEmbeddings) {
						validIsolates++;
						stack.push({level, override: 0, isolate: true, isolateStart: i});
					} else {
						overflowIsolates++;
					}
				} else if (type & PDI) {
					// X6a
					if (overflowIsolates > 0) {
						overflowIsolates--;
					} else if (validIsolates > 0) {
						overflowEmbeddings = 0;
						while (!stack[stack.length - 1].isolate) {
							stack.pop();
						}
						const start = stack[stack.length - 1].isolateStart;
						isolationPairs.set(start, i);
						isolationPairs.set(i, start);
						stack.pop();
						validIsolates--;
					}
					top = stack[stack.length - 1];
					levels[i] = top.level;
					if (top.override) {
						changeType(i, top.override);
					}
				} else if (type & PDF) {
					// X7
					if (overflowIsolates === 0) {
						if (overflowEmbeddings > 0) {
							overflowEmbeddings--;
						} else if (!top.isolate && stack.length > 1) {
							stack.pop();
							top = stack[stack.length - 1];
						}
					}
					levels[i] = top.level;
				} else {
					// X8
					levels[i] = paragraph.level;
				}
			} else {
				// X6. BN keeps its class under an override (5.2).
				levels[i] = top.level;
				if (top.override && type !== BN) {
					changeType(i, top.override);
				}
			}
		}

		// X9 keeps the removed characters in place (5.2): BN_LIKE skips
		// them from here on. X10 and BD13 build the isolating run sequences.
		const levelRuns: Array<{
			start: number;
			end: number;
			level: number;
			startsWithPDI: boolean;
			endsWithIsolate: boolean;
		}> = [];
		for (let i = paragraph.start; i <= paragraph.end; i++) {
			const type = types[i];
			if (type & BN_LIKE) {
				continue;
			}
			const level = levels[i];
			const isIsolate = (type & ISOLATE_INIT) !== 0;
			const current = levelRuns[levelRuns.length - 1];
			if (current && level === current.level) {
				current.end = i;
				current.endsWithIsolate = isIsolate;
			} else {
				levelRuns.push({
					start: i,
					end: i,
					level,
					startsWithPDI: type === PDI,
					endsWithIsolate: isIsolate,
				});
			}
		}

		const sequences: IsolatingRunSequence[] = [];
		for (let runIndex = 0; runIndex < levelRuns.length; runIndex++) {
			const run = levelRuns[runIndex];
			if (run.startsWithPDI && isolationPairs.has(run.start)) {
				continue;
			}
			const runs = [run];
			let current = run;
			let pdi: number | undefined;
			while (
				current.endsWithIsolate &&
				(pdi = isolationPairs.get(current.end)) !== undefined
			) {
				let found = false;
				for (let i = runIndex + 1; i < levelRuns.length; i++) {
					if (levelRuns[i].start === pdi) {
						runs.push(current = levelRuns[i]);
						found = true;
						break;
					}
				}
				if (!found) {
					break;
				}
			}
			const indices: number[] = [];
			for (const {start, end} of runs) {
				for (let i = start; i <= end; i++) {
					indices.push(i);
				}
			}
			const firstLevel = levels[indices[0]];
			let previousLevel = paragraph.level;
			for (let i = indices[0] - 1; i >= 0; i--) {
				if (!(types[i] & BN_LIKE)) {
					previousLevel = levels[i];
					break;
				}
			}
			const last = indices[indices.length - 1];
			const lastLevel = levels[last];
			let nextLevel = paragraph.level;
			if (!(types[last] & ISOLATE_INIT)) {
				for (let i = last + 1; i <= paragraph.end; i++) {
					if (!(types[i] & BN_LIKE)) {
						nextLevel = levels[i];
						break;
					}
				}
			}
			sequences.push({
				indices,
				sos: Math.max(previousLevel, firstLevel) % 2 ? R : L,
				eos: Math.max(nextLevel, lastLevel) % 2 ? R : L,
			});
		}

		for (const {indices, sos, eos} of sequences) {
			// The levels of one sequence are equal, and stay untouched here.
			const embedding = levels[indices[0]] & 1 ? R : L;

			// W1
			if (typeCounts.get(NSM)) {
				for (let si = 0; si < indices.length; si++) {
					const i = indices[si];
					if (types[i] & NSM) {
						let previous = sos;
						for (let sj = si - 1; sj >= 0; sj--) {
							if (!(types[indices[sj]] & BN_LIKE)) {
								previous = types[indices[sj]];
								break;
							}
						}
						changeType(i, previous & (ISOLATE_INIT | PDI) ? ON : previous);
					}
				}
			}

			// W2
			if (typeCounts.get(EN)) {
				for (let si = 0; si < indices.length; si++) {
					const i = indices[si];
					if (types[i] & EN) {
						for (let sj = si - 1; sj >= -1; sj--) {
							const previous = sj === -1 ? sos : types[indices[sj]];
							if (previous & STRONG) {
								if (previous === AL) {
									changeType(i, AN);
								}
								break;
							}
						}
					}
				}
			}

			// W3
			if (typeCounts.get(AL)) {
				for (const i of indices) {
					if (types[i] & AL) {
						changeType(i, R);
					}
				}
			}

			// W4
			if (typeCounts.get(ES) || typeCounts.get(CS)) {
				for (let si = 1; si < indices.length - 1; si++) {
					const i = indices[si];
					if (types[i] & (ES | CS)) {
						let previous = 0;
						let next = 0;
						for (let sj = si - 1; sj >= 0; sj--) {
							previous = types[indices[sj]];
							if (!(previous & BN_LIKE)) {
								break;
							}
						}
						for (let sj = si + 1; sj < indices.length; sj++) {
							next = types[indices[sj]];
							if (!(next & BN_LIKE)) {
								break;
							}
						}
						if (
							previous === next &&
							(types[i] === ES ? previous === EN : previous & (EN | AN))
						) {
							changeType(i, previous);
						}
					}
				}
			}

			// W5
			if (typeCounts.get(EN)) {
				for (let si = 0; si < indices.length; si++) {
					const i = indices[si];
					if (types[i] & EN) {
						for (
							let sj = si - 1;
							sj >= 0 && types[indices[sj]] & (ET | BN_LIKE);
							sj--
						) {
							changeType(indices[sj], EN);
						}
						for (
							si++;
							si < indices.length && types[indices[si]] & (ET | BN_LIKE | EN);
							si++
						) {
							if (types[indices[si]] !== EN) {
								changeType(indices[si], EN);
							}
						}
					}
				}
			}

			// W6, with adjacent BNs (5.2)
			if (typeCounts.get(ET) || typeCounts.get(ES) || typeCounts.get(CS)) {
				for (let si = 0; si < indices.length; si++) {
					const i = indices[si];
					if (types[i] & (ET | ES | CS)) {
						changeType(i, ON);
						for (let sj = si - 1;
							sj >= 0 && types[indices[sj]] & BN_LIKE;
							sj--) {
							changeType(indices[sj], ON);
						}
						for (
							let sj = si + 1;
							sj < indices.length && types[indices[sj]] & BN_LIKE;
							sj++
						) {
							changeType(indices[sj], ON);
						}
					}
				}
			}

			// W7
			if (typeCounts.get(EN)) {
				let previousStrong = sos;
				for (const i of indices) {
					const type = types[i];
					if (type & EN) {
						if (previousStrong === L) {
							changeType(i, L);
						}
					} else if (type & STRONG) {
						previousStrong = type;
					}
				}
			}

			if (!typeCounts.get(NEUTRAL_ISOLATE)) {
				continue;
			}

			// N0. EN and AN count as R.
			const RIGHT = R | EN | AN;
			const STRONG_N = RIGHT | L;

			// BD16
			const pairs: Array<[number, number]> = [];
			const openers: Array<{id: number; index: number}> = [];
			for (let si = 0; si < indices.length; si++) {
				if (!(types[indices[si]] & NEUTRAL_ISOLATE)) {
					continue;
				}
				const id = getBracketId(text.charCodeAt(indices[si]));
				if (id > 0) {
					if (openers.length === 63) {
						break;
					}
					openers.push({id, index: si});
				} else if (id < 0) {
					for (let k = openers.length - 1; k >= 0; k--) {
						if (openers[k].id === -id) {
							pairs.push([openers[k].index, si]);
							openers.length = k;
							break;
						}
					}
				}
			}
			pairs.sort((a, b) => a[0] - b[0]);

			for (const [open, close] of pairs) {
				let foundStrong = false;
				let useType = 0;
				for (let si = open + 1; si < close; si++) {
					const type = types[indices[si]];
					if (type & STRONG_N) {
						foundStrong = true;
						const side = type & RIGHT ? R : L;
						if (side === embedding) {
							useType = side;
							break;
						}
					}
				}
				if (foundStrong && !useType) {
					useType = sos;
					for (let si = open - 1; si >= 0; si--) {
						const type = types[indices[si]];
						if (type & STRONG_N) {
							const side = type & RIGHT ? R : L;
							useType = side !== embedding ? side : embedding;
							break;
						}
					}
				}
				if (useType) {
					types[indices[open]] = types[indices[close]] = useType;
					// NSMs after a bracket that changed take its type.
					if (useType !== embedding) {
						for (const after of [open, close]) {
							for (let si = after + 1; si < indices.length; si++) {
								if (!(types[indices[si]] & BN_LIKE)) {
									if (initialTypes[indices[si]] & NSM) {
										types[indices[si]] = useType;
									}
									break;
								}
							}
						}
					}
				}
			}

			// N1 and N2
			for (let si = 0; si < indices.length; si++) {
				if (!(types[indices[si]] & NEUTRAL_ISOLATE)) {
					continue;
				}
				let runStart = si;
				let runEnd = si;
				let previous = sos;
				for (let sj = si - 1; sj >= 0; sj--) {
					if (types[indices[sj]] & BN_LIKE) {
						runStart = sj;
					} else {
						previous = types[indices[sj]] & RIGHT ? R : L;
						break;
					}
				}
				let next = eos;
				for (let sj = si + 1; sj < indices.length; sj++) {
					if (types[indices[sj]] & (NEUTRAL_ISOLATE | BN_LIKE)) {
						runEnd = sj;
					} else {
						next = types[indices[sj]] & RIGHT ? R : L;
						break;
					}
				}
				for (let sj = runStart; sj <= runEnd; sj++) {
					types[indices[sj]] = previous === next ? previous : embedding;
				}
				si = runEnd;
			}
		}

		for (let i = paragraph.start; i <= paragraph.end; i++) {
			const level = levels[i];
			const type = types[i];
			if (level & 1) {
				// I2
				if (type & (L | EN | AN)) {
					levels[i]++;
				}
			} else if (type & R) {
				// I1
				levels[i]++;
			} else if (type & (AN | EN)) {
				levels[i] += 2;
			}

			// 5.2: a removed character takes the level before it.
			if (type & BN_LIKE) {
				levels[i] = i === 0 ? paragraph.level : levels[i - 1];
			}

			// L1, with the paragraph as one line.
			if (i === paragraph.end || initialTypes[i] & (S | B)) {
				for (let j = i; j >= 0 && initialTypes[j] & TRAILING; j--) {
					levels[j] = paragraph.level;
				}
			}
		}
	}

	return {levels, paragraphs};
}

/**
 * The string in visual order (L2), with each character at an odd level
 * replaced by its mirror (L4).
 */
export function getReorderedString(
	text: string,
	embedding: EmbeddingLevels,
): string {
	const {levels} = embedding;
	const order: number[] = [];
	for (let i = 0; i < text.length; i++) {
		order.push(i);
	}
	for (const {start, end, level: base} of embedding.paragraphs) {
		let highest = base;
		let lowestOdd = Infinity;
		for (let i = start; i <= end; i++) {
			highest = Math.max(highest, levels[i]);
			lowestOdd = Math.min(lowestOdd, levels[i] | 1);
		}
		for (let level = highest; level >= lowestOdd; level--) {
			for (let i = start; i <= end; i++) {
				if (levels[i] < level) {
					continue;
				}
				let j = i;
				while (j < end && levels[j + 1] >= level) {
					j++;
				}
				for (let a = i, b = j; a < b; a++, b--) {
					const swap = order[a];
					order[a] = order[b];
					order[b] = swap;
				}
				i = j;
			}
		}
	}

	let out = "";
	for (let k = 0; k < order.length; k++) {
		let index = order[k];
		if (
			index > 0 &&
			order[k + 1] === index - 1 &&
			isSurrogatePair(text, index - 1)
		) {
			index--;
			k++;
		}
		const code = text.codePointAt(index)!;
		out += String.fromCodePoint(levels[index] & 1 ? getMirror(code) : code);
		if (code > 0xffff && order[k + 1] === index + 1) {
			k++;
		}
	}
	return out;
}
