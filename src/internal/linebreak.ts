/**
 * UAX #14, the Unicode line breaking algorithm, rules LB1 through LB31 at
 * Unicode 17 with no tailoring, over src/generated/linebreaktables.ts.
 */

import {
	LINEBREAK_CLASSES,
	LINEBREAK_KINDS,
	LINEBREAK_RUN_KINDS,
	LINEBREAK_RUN_LENGTHS,
} from "../generated/linebreaktables.ts";

const CLASS_NAMES =
	"BK CR LF NL SP ZW ZWJ CM WJ GL CB CL CP EX SY OP QU QU_Pi QU_Pf IS NS " +
	"B2 BA HH HY BB IN NU PR PO AL HL ID EB EM JL JV JT H2 H3 RI AK AP AS VF VI";

const BK = 0;
const CR = 1;
const LF = 2;
const NL = 3;
const SP = 4;
const ZW = 5;
const ZWJ = 6;
const CM = 7;
const WJ = 8;
const GL = 9;
const CB = 10;
const CL = 11;
const CP = 12;
const EX = 13;
const SY = 14;
const OP = 15;
const QU = 16;
const QU_PI = 17;
const QU_PF = 18;
const IS = 19;
const NS = 20;
const B2 = 21;
const BA = 22;
const HH = 23;
const HY = 24;
const BB = 25;
const IN = 26;
const NU = 27;
const PR = 28;
const PO = 29;
const AL = 30;
const HL = 31;
const ID = 32;
const EB = 33;
const EM = 34;
const JL = 35;
const JV = 36;
const JT = 37;
const H2 = 38;
const H3 = 39;
const RI = 40;
const AK = 41;
const AP = 42;
const AS = 43;
const VF = 44;
const VI = 45;
const SOT = 62;
const EOT = 63;

const CLASS = 63;
const WIDE = 64;
const PICTOGRAPHIC = 128;
const DOTTED_CIRCLE = 0x25cc;

const NONE = 0;
const BREAK = 1;
const REQUIRED = 2;

let runStarts: Uint32Array | undefined;
let runKinds: Uint8Array;
let latin1: Uint8Array;
let blockRuns: Uint16Array;

function decodeTables(): void {
	if (LINEBREAK_CLASSES !== CLASS_NAMES) {
		throw new Error("line break tables do not match linebreak.ts");
	}
	const names = CLASS_NAMES.split(" ");
	const kinds = LINEBREAK_KINDS.split(" ").map((kind) => {
		const [name, flags = ""] = kind.split("+");
		return (
			names.indexOf(name) |
			(flags.includes("W") ? WIDE : 0) |
			(flags.includes("P") ? PICTOGRAPHIC : 0)
		);
	});
	const count = LINEBREAK_RUN_KINDS.length;
	const starts = new Uint32Array(count);
	runKinds = new Uint8Array(count);
	let next = 0;
	let at = 0;
	for (let i = 0; i < count; i++) {
		const letter = LINEBREAK_RUN_KINDS.charCodeAt(i);
		starts[i] = next;
		runKinds[i] = kinds[letter >= 97
			? letter - 71
			: letter >= 65 ? letter - 65 : letter + 4];
		let length = 0;
		for (; at < LINEBREAK_RUN_LENGTHS.length; at++) {
			const digit = LINEBREAK_RUN_LENGTHS.charCodeAt(at);
			if (digit === 44) {
				at++;
				break;
			}
			length = length * 36 + (digit >= 97 ? digit - 87 : digit - 48);
		}
		next += length;
	}
	if (next !== 0x110000) {
		throw new Error("line break tables do not cover the code space");
	}
	latin1 = new Uint8Array(256);
	for (let code = 0, run = 0; code < 256; code++) {
		while (starts[run + 1] <= code) {
			run++;
		}
		latin1[code] = runKinds[run];
	}
	blockRuns = new Uint16Array((0x110000 >> 10) + 1);
	for (let block = 0, run = 0; block < blockRuns.length; block++) {
		while (run + 1 < count && starts[run + 1] <= block << 10) {
			run++;
		}
		blockRuns[block] = run;
	}
	runStarts = starts;
}

function kindOf(code: number): number {
	if (code < 256) {
		return latin1[code];
	}
	const starts = runStarts!;
	let low = blockRuns[code >> 10];
	let high = blockRuns[(code >> 10) + 1];
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= code) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return runKinds[low];
}

function isQuote(cls: number): boolean {
	return cls >= QU && cls <= QU_PF;
}

function isHangul(cls: number): boolean {
	return cls >= JL && cls <= H3;
}

function isHardBreak(cls: number): boolean {
	return cls <= NL;
}

interface State {
	prev: number;
	prevCode: number;
	prevZWJ: boolean;
	before: number;
	beforeCode: number;
	base: number;
	baseBefore: number;
	regional: number;
	numeric: boolean;
	numericClose: boolean;
}

let peekEnd = 0;

// The kind of the item at `at`, a character and the combining marks and
// joiners rule LB9 attaches to it, or EOT past the end. Sets peekEnd to
// the item's end.
function peekItem(text: string, at: number): number {
	if (at >= text.length) {
		return EOT;
	}
	const code = text.codePointAt(at)!;
	let next = at + (code > 0xffff ? 2 : 1);
	let kind = kindOf(code);
	const cls = kind & CLASS;
	if (cls === CM || cls === ZWJ) {
		kind = AL;
	}
	if (cls > ZW) {
		while (next < text.length) {
			const mark = text.codePointAt(next)!;
			const markClass = kindOf(mark) & CLASS;
			if (markClass !== CM && markClass !== ZWJ) {
				break;
			}
			next += mark > 0xffff ? 2 : 1;
		}
	}
	peekEnd = next;
	return kind;
}

function advance(state: State, kind: number, code: number, zwj: boolean): void {
	const cls = kind & CLASS;
	if (cls !== SP) {
		state.base = kind;
		state.baseBefore = state.prev;
	}
	state.regional = cls === RI ? state.regional + 1 : 0;
	state.numericClose = (cls === CL || cls === CP) && state.numeric;
	state.numeric = cls === NU || ((cls === SY || cls === IS) && state.numeric);
	state.before = state.prev;
	state.beforeCode = state.prevCode;
	state.prev = kind;
	state.prevCode = code;
	state.prevZWJ = zwj;
}

/**
 * Calls visit with each break opportunity of text in order: its UTF-16
 * offset, the text's length last, and whether the break is mandatory.
 */
export function forEachLineBreak(
	text: string,
	visit: (position: number, required: boolean) => void,
): void {
	const length = text.length;
	if (length === 0) {
		return;
	}
	if (runStarts === undefined) {
		decodeTables();
	}
	const state: State = {
		prev: SOT,
		prevCode: -1,
		prevZWJ: false,
		before: SOT,
		beforeCode: -1,
		base: SOT,
		baseBefore: SOT,
		regional: 0,
		numeric: false,
		numericClose: false,
	};
	let at = 0;
	let code = text.codePointAt(0)!;
	let kind = kindOf(code);
	while (kind !== -1) {
		const start = at;
		const first = code;
		let item = kind;
		let cls = kind & CLASS;
		let zwj = cls === ZWJ;
		if (cls === CM || cls === ZWJ) {
			item = AL;
			cls = AL;
		}
		at += code > 0xffff ? 2 : 1;
		kind = -1;
		while (at < length) {
			code = text.codePointAt(at)!;
			kind = kindOf(code);
			const mark = kind & CLASS;
			if (cls <= ZW || (mark !== CM && mark !== ZWJ)) {
				break;
			}
			zwj = mark === ZWJ;
			at += code > 0xffff ? 2 : 1;
			kind = -1;
		}
		if (start > 0) {
			const pc = state.prev & CLASS;
			if (!((pc === AL || pc === HL) && (cls === AL || cls === HL))) {
				const decision = decide(state, text, item, first, at);
				if (decision !== NONE) {
					visit(start, decision === REQUIRED);
				}
			}
		}
		advance(state, item, first, zwj);
	}
	visit(length, isHardBreak(state.prev & CLASS));
}

// Whether to break between the previous item and `next`, the item whose
// first code point is nextCode and that ends at nextEnd, by rules LB4
// through LB31 in order.
function decide(
	state: State,
	text: string,
	next: number,
	nextCode: number,
	nextEnd: number,
): number {
	const prev = state.prev;
	const pc = prev & CLASS;
	const nc = next & CLASS;
	// LB4, LB5
	if (pc === BK || pc === LF || pc === NL) {
		return REQUIRED;
	}
	if (pc === CR) {
		return nc === LF ? NONE : REQUIRED;
	}
	// LB6, LB7
	if (isHardBreak(nc) || nc === SP || nc === ZW) {
		return NONE;
	}
	// LB8
	const bc = state.base & CLASS;
	if (bc === ZW) {
		return BREAK;
	}
	// LB8a
	if (state.prevZWJ) {
		return NONE;
	}
	// LB11, LB12, LB12a
	if (nc === WJ || pc === WJ || pc === GL) {
		return NONE;
	}
	if (nc === GL && pc !== SP && pc !== BA && pc !== HY && pc !== HH) {
		return NONE;
	}
	// LB13, LB14
	if (nc === CL || nc === CP || nc === EX || nc === SY || bc === OP) {
		return NONE;
	}
	// LB15a
	if (bc === QU_PI) {
		const bb = state.baseBefore & CLASS;
		if (
			bb === SOT ||
			isHardBreak(bb) ||
			bb === OP ||
			isQuote(bb) ||
			bb === GL ||
			bb === SP ||
			bb === ZW
		) {
			return NONE;
		}
	}
	// LB15b
	if (nc === QU_PF) {
		const after = peekItem(text, nextEnd) & CLASS;
		if (
			after === EOT ||
			after <= ZW ||
			after === GL ||
			after === WJ ||
			after === CL ||
			after === CP ||
			after === EX ||
			after === IS ||
			after === SY ||
			isQuote(after)
		) {
			return NONE;
		}
	}
	// LB15c, LB15d
	if (nc === IS) {
		return pc === SP && (peekItem(text, nextEnd) & CLASS) === NU ? BREAK : NONE;
	}
	// LB16, LB17
	if ((bc === CL || bc === CP) && nc === NS) {
		return NONE;
	}
	if (bc === B2 && nc === B2) {
		return NONE;
	}
	// LB18
	if (pc === SP) {
		return BREAK;
	}
	// LB19
	if (nc === QU || nc === QU_PF || pc === QU || pc === QU_PI) {
		return NONE;
	}
	// LB19a
	if (isQuote(nc) && (!(prev & WIDE) || !(peekItem(text, nextEnd) & WIDE))) {
		return NONE;
	}
	if (isQuote(pc) && (!(next & WIDE) || !(state.before & WIDE))) {
		return NONE;
	}
	// LB20
	if (nc === CB || pc === CB) {
		return BREAK;
	}
	if (pc === HY || pc === HH) {
		const b = state.before & CLASS;
		// LB20a
		if (
			(nc === AL || nc === HL) &&
			(b === SOT ||
				isHardBreak(b) ||
				b === SP ||
				b === ZW ||
				b === CB ||
				b === GL)
		) {
			return NONE;
		}
		// LB21a
		if (b === HL && nc !== HL) {
			return NONE;
		}
	}
	// LB21
	if (nc === BA || nc === HH || nc === HY || nc === NS || pc === BB) {
		return NONE;
	}
	// LB21b, LB22
	if ((pc === SY && nc === HL) || nc === IN) {
		return NONE;
	}
	// LB23, LB23a, LB24
	if (pc === AL || pc === HL) {
		if (nc === NU || nc === PR || nc === PO) {
			return NONE;
		}
	} else if (pc === PR || pc === PO) {
		if (nc === AL || nc === HL) {
			return NONE;
		}
	}
	if (pc === NU && (nc === AL || nc === HL)) {
		return NONE;
	}
	if (pc === PR && (nc === ID || nc === EB || nc === EM)) {
		return NONE;
	}
	if ((pc === ID || pc === EB || pc === EM) && nc === PO) {
		return NONE;
	}
	// LB25
	if (nc === PO || nc === PR) {
		if (state.numeric || state.numericClose) {
			return NONE;
		}
	} else if (nc === NU) {
		if (state.numeric || pc === PO || pc === PR || pc === HY || pc === IS) {
			return NONE;
		}
	} else if (nc === OP && (pc === PO || pc === PR)) {
		const after = peekItem(text, nextEnd) & CLASS;
		if (
			after === NU || (after === IS && (peekItem(text, peekEnd) & CLASS) === NU)
		) {
			return NONE;
		}
	}
	// LB26, LB27
	if (isHangul(pc)) {
		if (
			nc === PO ||
			(pc === JL && (nc === JL || nc === JV || nc === H2 || nc === H3)) ||
			((pc === JV || pc === H2) && (nc === JV || nc === JT)) ||
			((pc === JT || pc === H3) && nc === JT)
		) {
			return NONE;
		}
	} else if (pc === PR && isHangul(nc)) {
		return NONE;
	}
	// LB28a
	const prevAksara = pc === AK || pc === AS || state.prevCode === DOTTED_CIRCLE;
	const nextAksara = nc === AK || nc === AS || nextCode === DOTTED_CIRCLE;
	if (pc === AP && nextAksara) {
		return NONE;
	}
	if (prevAksara && (nc === VF || nc === VI)) {
		return NONE;
	}
	if (
		pc === VI &&
		nc !== AS &&
		nextAksara &&
		((state.before & CLASS) === AK ||
			(state.before & CLASS) === AS ||
			state.beforeCode === DOTTED_CIRCLE)
	) {
		return NONE;
	}
	if (prevAksara && nextAksara && (peekItem(text, nextEnd) & CLASS) === VF) {
		return NONE;
	}
	// LB29
	if (pc === IS && (nc === AL || nc === HL)) {
		return NONE;
	}
	// LB30
	if ((pc === AL || pc === HL || pc === NU) && nc === OP && !(next & WIDE)) {
		return NONE;
	}
	if (pc === CP && !(prev & WIDE) && (nc === AL || nc === HL || nc === NU)) {
		return NONE;
	}
	// LB30a
	if (pc === RI && nc === RI && state.regional % 2 === 1) {
		return NONE;
	}
	// LB30b
	if (nc === EM && (pc === EB || (prev & PICTOGRAPHIC) !== 0)) {
		return NONE;
	}
	return BREAK;
}
