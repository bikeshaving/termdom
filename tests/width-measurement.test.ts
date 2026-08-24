/**
 * In-frame width measurement.
 *
 * The width tables predict a cluster's advance; the terminal decides it. A
 * frame paints each unmeasured cluster whose width terminals disagree about at
 * a column it computed, so a DSR query appended to the glyph turns that column
 * into a measurement, and the answer corrects the tables for the rest of the
 * session.
 *
 * Every test here uses clusters of its own: the ledger is append-only and
 * lives as long as the process, which is the whole point of it.
 */

import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils.js";
import {TermDOM} from "../src/internal/termdom.js";
import {Screen} from "../src/internal/ansi.js";
import {
	recordClusterAdvance,
	stringWidth,
	type WidthMeasurer,
} from "../src/internal/text.js";

/** A measurer that records what it was offered instead of asking anything. */
function recordingMeasurer(starved = new Set<string>()): {
	probes: Array<{
		cluster: string;
		run: number;
		column: number;
		width: number;
	}>;
	deferred: string[];
	starved: Set<string>;
	measurer: WidthMeasurer;
} {
	const probes: Array<{
		cluster: string;
		run: number;
		column: number;
		width: number;
	}> = [];
	const deferred: string[] = [];
	const asked = new Set<string>();
	return {
		probes,
		deferred,
		starved,
		measurer: {
			probing: () => true,
			clusterWidthsNegotiated: () => false,
			wants: (cluster) => !asked.has(cluster),
			starved: () => starved,
			defer: (cluster) => {
				deferred.push(cluster);
			},
			probe: (cluster, run, column, width) => {
				asked.add(cluster);
				starved.delete(cluster);
				probes.push({cluster, run, column, width});
				return "\x1b[6n";
			},
		},
	};
}

/**
 * A mock terminal whose DSR replies are scripted rather than answered by the
 * headless emulator: the probes are stripped out of the frame before it is fed
 * in (so the emulator never answers them) and `reply` says what comes back.
 * Returns everything written, probes included.
 */
function scriptTerminal(
	terminal: MockProcess,
	reply: (probeIndex: number) => string | null,
): {written: string[]; probeCount: () => number} {
	const stdout = terminal.stdout as unknown as {
		write: (...args: unknown[]) => boolean;
	};
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	const original = stdout.write.bind(stdout);
	const written: string[] = [];
	let probes = 0;

	stdout.write = (...args: unknown[]) => {
		const data = String(args[0]);
		written.push(data);
		if (!data.includes("\x1b[6n")) {
			return original(...args);
		}

		const count = data.split("\x1b[6n").length - 1;
		const replies: string[] = [];
		for (let i = 0; i < count; i++) {
			const answer = reply(probes++);
			if (answer !== null) {
				replies.push(answer);
			}
		}
		if (replies.length > 0) {
			setTimeout(() => stdin.simulateResponse(replies.join("")), 0);
		}

		const rest = data.split("\x1b[6n").join("");
		if (rest) {
			return original(rest, ...args.slice(1));
		}
		const callback = args.find((arg) => typeof arg === "function");
		if (callback) {
			(callback as () => void)();
		}
		return true;
	};

	return {written, probeCount: () => probes};
}

/**
 * One frame through the public surface: clusters drawn at their columns,
 * the measurer riding the frame options, the emitted bytes returned. The
 * emitter is what is under test; the pen is just how cells get there.
 */
function emit(
	rows: number,
	cols: number,
	cells: Array<[number, string]>,
	measurer: WidthMeasurer,
): string {
	const screen = new Screen(rows, cols, "rgb");
	const context = screen.beginFrame({offset: 0, measurer});
	for (const [index, cluster] of cells) {
		context.drawText(cluster, index % cols, Math.floor(index / cols));
	}
	return screen.endFrame();
}

function settle(ms = 60): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a frame asks about each unmeasured uncertain cluster, once", () => {
	const {probes, measurer} = recordingMeasurer();
	const output = emit(
		1,
		20,
		[
			[0, "\u{1F31E}"],
			[2, "a"],
			[3, "\u{1F31E}"],
		],
		measurer,
	);

	expect(probes.length).toBe(1);
	// The run is a frame-internal counter; which run a probe is IN only
	// matters relative to other probes, which the run tests below pin.
	const {cluster, column, width} = probes[0];
	expect({cluster, column, width}).toEqual({
		cluster: "\u{1F31E}",
		column: 0,
		width: 2,
	});
	// The query rides the glyph it is about, in the same frame.
	expect(output).toContain("\u{1F31E}\x1b[6n");
	// ASCII buys nothing: it is one cell on every terminal there is.
	expect(output.indexOf("a\x1b[6n")).toBe(-1);
});

test("the characters every terminal agrees about are never asked about", () => {
	// Alphabets and ideographs: a letter is one cell and a Wide or Fullwidth
	// code point is two, on every terminal there is. Asking would spend a query
	// and a reply per distinct letter to be told what the tables already said.
	const trusted = [
		"\u05d0", // א, Hebrew
		"\u6f22", // 漢, CJK
		"\ud55c", // 한, Hangul syllable
		"\u3131", // ㄱ, Hangul compatibility jamo
		"\u3042", // あ, hiragana
		"\u30ab", // カ, katakana
		"\uff21", // Ａ, fullwidth
		"\uff71", // ｱ, halfwidth katakana
		"\u2009", // thin space, Narrow General Punctuation
		"\u2044", // ⁄, Narrow General Punctuation
	];

	const cells: Array<[number, string]> = [];
	let col = 0;
	for (const cluster of trusted) {
		cells.push([col, cluster]);
		col += stringWidth(cluster);
	}

	const {probes, measurer} = recordingMeasurer();
	const output = emit(1, 200, cells, measurer);

	expect(probes).toEqual([]);
	expect(output).not.toContain("\x1b[6n");
});

test("the characters terminals disagree about are all asked about", () => {
	const uncertain: Array<[string, string]> = [
		["emoji presentation selector", "\u2764\uFE0F"], // ❤️
		["text presentation selector", "\u26C5\uFE0E"], // ⛅︎
		["ZWJ sequence", "\u{1F468}\u200D\u{1F4BB}"], // 👨‍💻
		["regional indicator pair", "\u{1F1EF}\u{1F1F5}"], // 🇯🇵
		["skin-tone modifier", "\u{1F44D}\u{1F3FD}"], // 👍🏽
		["combining mark", "e\u0301"], // é, decomposed
		["degree sign", "\u00b0"], // °, East Asian Width Ambiguous
		["precomposed e-acute", "\u00e9"], // é, Ambiguous Latin letter
		["cyrillic de", "\u0434"], // д, Ambiguous
		["greek lambda", "\u03bb"], // λ, Ambiguous
		["plus-minus sign", "\u00b1"], // ±
		["box drawing", "\u2500"], // ─
		["block element", "\u2588"], // █
		["arrow", "\u2190"], // ←
		["private use", "\ue0b0"], // a powerline glyph
		["default emoji presentation", "\u{1F600}"], // 😀
		["Arabic presentation form", "\ufedf"], // ﻟ, shaped lam
	];

	for (const [name, cluster] of uncertain) {
		const {probes, measurer} = recordingMeasurer();
		emit(1, 40, [[0, cluster]], measurer);
		expect([name, probes.map((probe) => probe.cluster)]).toEqual([
			name,
			[cluster],
		]);
	}
});

test("a cluster at the right margin is left for a frame with room", () => {
	// The last column is where the arithmetic stops working: a glyph that
	// reaches it leaves the cursor there with wrap pending rather than past it,
	// and one reply column then means two different advances.
	const {probes, measurer} = recordingMeasurer();
	emit(
		2,
		10,
		[
			[8, "\u{1F31F}"], // 🌟, ending flush with the margin
			[10, "\u{1F31F}"], // and again, at the start of the next row
		],
		measurer,
	);

	expect(probes.length).toBe(1);
	expect(probes[0].column).toBe(0);
});

test("a cluster the margin turns away is offered to the next frame's train", () => {
	const {probes, deferred, measurer} = recordingMeasurer();
	emit(1, 10, [[8, "\u{1F31F}"]], measurer); // 🌟, flush with the margin

	expect(probes).toEqual([]);
	expect(deferred).toEqual(["\u{1F31F}"]);
});

test("a starved cluster rides a probe train the frame's own content covers", () => {
	const cluster = "\uFEE0"; // ﻠ, shaped lam
	// A row whose content starts at column 4 and runs to the margin: the train
	// goes to column 4, and those columns are painted over as the row emits.
	const cells: Array<[number, string]> = [];
	for (let col = 4; col < 20; col++) {
		cells.push([col, "-"]);
	}
	cells.push([20, "x"]);

	const {probes, measurer} = recordingMeasurer(new Set([cluster]));
	const output = emit(2, 20, cells, measurer);

	expect(probes.length).toBe(1);
	expect(probes[0].cluster).toBe(cluster);
	expect(probes[0].column).toBe(4);
	// Asked before anything is painted, at a column the row then overwrites.
	expect(output.indexOf(`${cluster}\x1b[6n`)).toBe(output.indexOf(cluster));
	expect(output.indexOf(cluster)).toBeLessThan(output.indexOf("-"));
	expect(output).toContain(`\r\x1b[4C${cluster}\x1b[6n\r`);
	// One train, and the frame it rode paints the row it stood on.
	expect(output.split(cluster).length - 1).toBe(1);
});

test("nothing starving costs the frame nothing", () => {
	const cells: Array<[number, string]> = [];
	for (let col = 0; col < 20; col++) {
		cells.push([col, "-"]);
	}
	const {probes, measurer} = recordingMeasurer();
	const output = emit(1, 20, cells, measurer);

	expect(probes).toEqual([]);
	expect(output).not.toContain("\x1b[6n");
});

test("a starved cluster waits for a frame with a cell to hide in", () => {
	// Nothing painted: there is no row whose content could cover a probe, so
	// the train stays behind rather than writing where it would be seen.
	const cluster = "\uFEE1"; // ﻡ, shaped meem, isolated
	const starved = new Set([cluster]);

	const first = recordingMeasurer(starved);
	emit(2, 20, [], first.measurer);
	expect(first.probes).toEqual([]);
	expect(starved.has(cluster)).toBe(true);

	// A row too short to cover the residue is no better.
	const second = recordingMeasurer(starved);
	emit(
		1,
		20,
		[
			[0, "-"],
			[1, "-"],
		],
		second.measurer,
	);
	expect(second.probes).toEqual([]);
});

test("clusters reached by advancing share a run; a cursor move starts a new one", () => {
	const {probes, measurer} = recordingMeasurer();
	emit(
		2,
		40,
		[
			[0, "\u{1F320}"], // 🌠
			[2, "\u{1F321}️"], // 🌡️ immediately after it
			[40, "\u{1F322}️"], // next row: the cursor is placed
		],
		measurer,
	);

	expect(probes.map((probe) => probe.column)).toEqual([0, 2, 0]);
	expect(probes[0].run).toBe(probes[1].run);
	expect(probes[2].run).not.toBe(probes[1].run);
});

test("a gap crossed by cursor-forward keeps the run it was crossing", () => {
	// Stepping over blank cells is a relative move: it starts from wherever the
	// cursor really is, so a glyph that came out narrow leaves the cursor short
	// on the far side of the gap too. Only a carriage return names a column
	// outright, and only that ends a run.
	const {probes, measurer} = recordingMeasurer();
	const output = emit(
		1,
		40,
		[
			[0, "\u{1F33B}"],
			[10, "\u{1F33C}"],
		],
		measurer,
	);

	expect(output).toContain("\x1b[8C");
	expect(probes.map((probe) => probe.column)).toEqual([0, 10]);
	expect(probes[0].run).toBe(probes[1].run);
});

test("the ledger keeps the first answer and only records a correction", () => {
	const cluster = "\u{1F323}️"; // 🌣️
	expect(stringWidth(cluster)).toBe(2);

	expect(recordClusterAdvance(cluster, 1)).toBe(true);
	expect(stringWidth(cluster)).toBe(1);
	expect(stringWidth(`x${cluster}x`)).toBe(3);

	// Append-only: a second answer never overwrites the first.
	expect(recordClusterAdvance(cluster, 2)).toBe(false);

	// A terminal that agrees with the tables records nothing new.
	const agreeing = "\u{1F324}️"; // 🌤️
	expect(recordClusterAdvance(agreeing, stringWidth(agreeing))).toBe(false);
});

test("a terminal that agrees is asked once and nothing repaints", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	// Painted at column 0 and two cells wide: the cursor lands in column 3,
	// 1-based, which is what the tables predicted.
	const script = scriptTerminal(terminal, () => "\x1b[1;3R");
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>\u{1F325}️</div>"; // 🌥️

	await nextFrame(dom);
	await settle();
	const framesAfterReply = script.written.length;
	await settle();

	expect(script.probeCount()).toBe(1);
	expect(stringWidth("\u{1F325}️")).toBe(2);
	// Agreement is not news: no frame follows it.
	expect(script.written.length).toBe(framesAfterReply);

	dom.dispose();
});

test("a disagreement corrects the tables, repaints, and stands for the session", async () => {
	const cluster = "\u{1F326}️"; // 🌦️
	const terminal = new MockProcess({cols: 20, rows: 6});
	// One cell, where the tables said two.
	const script = scriptTerminal(terminal, () => "\x1b[1;2R");
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div><span id="e">${cluster}</span></div>`;

	await nextFrame(dom);
	await settle();

	// The rows painted from the old measurement are painted again, and the
	// repaint asks nothing: the cluster is measured now.
	const painted = script.written.filter((chunk) => chunk.includes(cluster));
	expect(painted.length).toBeGreaterThanOrEqual(2);
	expect(painted[painted.length - 1]).not.toContain("\x1b[6n");

	// Layout answers from the terminal's measurement, not the tables.
	const span = dom.document.getElementById("e")!;
	expect(span.getBoundingClientRect().width).toBe(1);

	// And the question is never asked twice.
	const asked = script.probeCount();
	dom.document.body.innerHTML += `<div>${cluster}</div>`;
	await nextFrame(dom);
	await settle();
	expect(script.probeCount()).toBe(asked);

	dom.dispose();
});

test("every unmeasured glyph in a run carries its own query", async () => {
	// A cluster painted twice before either answer is back is twice in
	// question: the second occurrence displaces the columns after it exactly as
	// the first did, and a run whose glyphs are not all asked about reads the
	// next cluster against a drift it only half knows.
	const repeated = "\u{1F32E}"; // 🌮
	const after = "\u{1F32F}"; // 🌯
	const terminal = new MockProcess({cols: 40, rows: 6});
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	const script = scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div>${repeated}${repeated}${after}</div>`;

	await nextFrame(dom);
	expect(script.probeCount()).toBe(3);

	// The terminal gives the repeated cluster one cell and the last one two, so
	// its cursor sits at columns 1, 2 and 4 as the glyphs go out.
	stdin.simulateResponse("\x1b[1;2R\x1b[1;3R\x1b[1;5R");
	await settle();

	expect(stringWidth(repeated)).toBe(1);
	// Two cells, as the tables said: the drift of BOTH earlier glyphs was
	// accounted for before this reading was taken.
	expect(stringWidth(after)).toBe(2);

	dom.dispose();
});

test("a reading that cannot be believed takes the rest of its run with it", async () => {
	const first = "\u{1F330}"; // 🌰
	const second = "\u{1F331}"; // 🌱
	const terminal = new MockProcess({cols: 40, rows: 6});
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div>${first}${second}</div>`;

	await nextFrame(dom);
	// A column no cluster at column 0 could have produced -- the screen moved
	// under the frame, or something else answered. The drift the second glyph's
	// column depends on is now unknown, so its own reply says nothing either.
	stdin.simulateResponse("\x1b[1;31R\x1b[1;4R");
	await settle();

	expect(stringWidth(first)).toBe(2);

	dom.dispose();
});

test("a reply split across chunks is still a reply", async () => {
	const cluster = "\u{1F332}"; // 🌲
	const terminal = new MockProcess({cols: 20, rows: 6});
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div>${cluster}</div>`;

	await nextFrame(dom);
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		keys.push((event as KeyboardEvent).key);
	});
	// The transport delivers what it has when it has it; a reply arriving in
	// pieces is held, not read as an escape key and a handful of letters.
	stdin.simulateResponse("\x1b[1;");
	await settle();
	stdin.simulateResponse("2R");
	await settle();

	expect(keys.length).toBe(0);

	dom.dispose();
});

test("replies interleaved with typing reach the right side of the demux", async () => {
	const cluster = "\u{1F327}️"; // 🌧️
	const terminal = new MockProcess({cols: 20, rows: 6});
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		keys.push((event as KeyboardEvent).key);
	});
	dom.document.body.innerHTML = `<div>${cluster}</div>`;

	await nextFrame(dom);
	// The reply arrives glued between keystrokes, as a real terminal delivers
	// it when the user is typing over the frame that asked.
	stdin.simulateResponse("jj\x1b[1;2Rkk");
	await settle();

	expect(keys.join("")).toBe("jjkk");

	dom.dispose();
});

test("a burst of replies is matched to its probes in order", async () => {
	const first = "\u{1F328}️"; // 🌨️
	const second = "\u{1F329}️"; // 🌩️
	const terminal = new MockProcess({cols: 40, rows: 6});
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div>${first}${second}</div>`;

	await nextFrame(dom);
	// Both probes rode one row: the first cluster took one cell where two were
	// predicted, so the second one's cursor reply is a column earlier than its
	// own column suggests -- and the drift the first reply establishes is what
	// makes the second reading come out at two.
	stdin.simulateResponse("\x1b[1;2R\x1b[1;4R");
	await settle();

	expect(stringWidth(first)).toBe(1);
	expect(stringWidth(second)).toBe(2);

	dom.dispose();
});

test("right-aligned text against the margin is measured anyway", async () => {
	// The rtl example's case: an Arabic presentation form sits in the last
	// column of a right-aligned line every frame, where its answer would be
	// unreadable. Deferred in place, it would go unmeasured for the session
	// and the box around it would stay one cell out.
	const cluster = "\uFEE0"; // ﻠ, shaped lam
	expect(stringWidth(cluster)).toBe(1);

	const terminal = new MockProcess({cols: 20, rows: 6});
	// The train probes from column 3, where the line starts; two cells where
	// the tables said one puts the cursor in column 6, 1-based.
	const script = scriptTerminal(terminal, () => "\x1b[1;6R");
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"text-align:right\">" +
		`abcdefghijklmnop<span id="e">${cluster}</span></div>`;

	await nextFrame(dom);
	// Past the wait a starved cluster gives the document to paint on its own.
	await settle(800);

	expect(stringWidth(cluster)).toBe(2);
	const span = dom.document.getElementById("e")!;
	expect(span.getBoundingClientRect().width).toBe(2);

	// Asked once, and the frames that follow the correction ask nothing more:
	// the train does not ride again.
	const asked = script.probeCount();
	dom.document.body.innerHTML +=
		`<div style="text-align:right">${cluster}</div>`;
	await nextFrame(dom);
	await settle();
	expect(script.probeCount()).toBe(asked);

	dom.dispose();
});

test("the probe train leaves the screen as the frame's content dictates", async () => {
	const cluster = "\uFEE2"; // ﻢ, shaped meem, final
	const terminal = new MockProcess({cols: 20, rows: 6});
	const script = scriptTerminal(terminal, () => "\x1b[1;5R");
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		`<div style="text-align:right">abcdefghijklmnop${cluster}</div>`;

	await nextFrame(dom);
	await settle(800);

	// The train went out.
	expect(script.written.join("")).toContain(`${cluster}\x1b[6n`);
	// And the emulator, which saw everything but the queries, shows the line
	// the document asked for: the probe wrote where the content lands.
	expect(terminal.getPlainText().split("\n")[0]).toBe(
		`   abcdefghijklmnop${cluster}`,
	);

	dom.dispose();
});

test("a terminal that never answers is asked once and then left alone", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const script = scriptTerminal(terminal, () => null);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>\u{1F32A}️</div>"; // 🌪️

	await nextFrame(dom);
	expect(script.probeCount()).toBe(1);

	// Past the no-reply timeout, probing is off for the session: a cluster the
	// frame has never seen before goes unasked.
	await settle(2100);
	dom.document.body.innerHTML = "<div>\u{1F32B}️</div>"; // 🌫️
	await nextFrame(dom);
	await settle();

	expect(script.probeCount()).toBe(1);

	dom.dispose();
});

test("one unanswered probe does not end the measuring of a terminal that answers", async () => {
	const answered = "\u{1F334}"; // 🌴
	const silent = "\u{1F335}"; // 🌵
	const later = "\u{1F337}"; // 🌷
	const terminal = new MockProcess({cols: 20, rows: 6});
	const script = scriptTerminal(terminal, (index) =>
		index === 1 ? null : "\x1b[1;2R",
	);
	const dom = new TermDOM({transport: terminal.transport});

	dom.document.body.innerHTML = `<div>${answered}</div>`;
	await nextFrame(dom);
	await settle();
	expect(stringWidth(answered)).toBe(1);

	dom.document.body.innerHTML = `<div>${silent}</div>`;
	await nextFrame(dom);
	await settle();

	// The silent probe's own deadline passes: its cluster keeps the tables and
	// leaves the queue, and the session keeps asking, because this terminal has
	// answered before and one unanswered question does not unsay that.
	await settle(2200);
	expect(stringWidth(silent)).toBe(2);

	dom.document.body.innerHTML = `<div>${later}</div>`;
	await nextFrame(dom);
	await settle();

	expect(script.probeCount()).toBe(3);
	expect(stringWidth(later)).toBe(1);

	dom.dispose();
});

test("a terminal that measures in grapheme clusters is not asked at all", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const stdout = terminal.stdout as unknown as {
		write: (...args: unknown[]) => boolean;
	};
	const stdin = terminal.stdin as unknown as {
		simulateResponse: (data: string) => void;
	};
	const original = stdout.write.bind(stdout);
	const written: string[] = [];
	let agreed!: () => void;
	const negotiated = new Promise<void>((resolve) => {
		agreed = resolve;
	});
	stdout.write = (...args: unknown[]) => {
		const data = String(args[0]);
		written.push(data);
		if (data.includes("\x1b[?2027$p")) {
			setTimeout(() => {
				stdin.simulateResponse("\x1b[?2027;1$y");
				agreed();
			}, 0);
			const rest = data.replace("\x1b[?2027h", "").replace("\x1b[?2027$p", "");
			if (rest) {
				return original(rest, ...args.slice(1));
			}
			const callback = args.find((arg) => typeof arg === "function");
			if (callback) {
				(callback as () => void)();
			}
			return true;
		}
		return original(...args);
	};

	const dom = new TermDOM({transport: terminal.transport});
	await nextFrame(dom);
	// The answer, not a guess at how long it takes to arrive.
	await negotiated;
	await settle();
	written.length = 0;
	dom.document.body.innerHTML = "<div>\u{1F32C}️</div>"; // 🌬️
	await nextFrame(dom);
	await settle();

	// Mode 2027 makes the terminal measure the way we do: agreement by
	// construction, nothing to learn.
	expect(written.join("")).not.toContain("\x1b[6n");

	dom.dispose();
});

test("a transport with no terminal behind it is never probed", async () => {
	const chunks: string[] = [];
	const dom = new TermDOM({
		transport: {
			cols: 40,
			rows: 10,
			colorDepth: "rgb",
			readable: new ReadableStream<string>({}, {highWaterMark: 0}),
			writable: new WritableStream<string>({
				write(chunk) {
					chunks.push(chunk);
				},
			}),
			resizes: new ReadableStream<{cols: number; rows: number}>(
				{},
				{highWaterMark: 0},
			),
			ready: Promise.resolve(),
			closed: new Promise(() => {}),
			interactive: false,
			sharesScreen: false,
			close() {},
		},
	});

	dom.document.body.innerHTML = "<div>\u{1F32D}</div>"; // 🌭
	await dom.attach();
	await settle();

	expect(chunks.join("")).not.toContain("\x1b[6n");

	dom.dispose();
});
