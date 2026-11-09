/**
 * The pty embed's emulator against xterm.js. Where the two differ on
 * purpose, the test says so and pins the difference: each one is a place
 * xterm.js departs from xterm, checked against tmux or DEC's manuals.
 */
import {readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import {AGREED, E, random, token} from "./vt-cases.ts";
import {compareWithXterm} from "./vt-oracle.ts";

for (const [name, data] of Object.entries(AGREED)) {
	test(`agrees with xterm.js: ${name}`, async () => {
		expect(await compareWithXterm(data, {scrollback: 10})).toEqual([]);
	});
}

test("replies to CSI 18 t with the size, as xterm does and xterm.js does not", async () => {
	expect(await compareWithXterm(E + "[18t")).toEqual([
		`replies: ours "\\u001b[8;6;20t", xterm ""`,
	]);
});

test("in origin mode a relative move stays in the region, where xterm.js adds its top twice", async () => {
	expect(await compareWithXterm(E + "[2;5r" + E + "[?6h" + E + "[CX")).toEqual([
		`cell 1,1 char: ours "X", xterm " "`,
		`cell 1,2 char: ours " ", xterm "X"`,
		"cursor: ours 2,1, xterm 2,2",
	]);
});

test("DECSC saves origin mode and the shift state, and DECRC with nothing saved resets, as DEC specifies", async () => {
	expect(
		await compareWithXterm(E + "[?6h" + E + "7" + E + "[?6l" + E + "8"),
	).toEqual(
		["originMode: ours true, xterm false"],
	);
	expect(await compareWithXterm(E + "[?6h" + E + "8")).toEqual([
		"originMode: ours false, xterm true",
	]);
	expect(await compareWithXterm(E + "7\x0e" + E + "8" + E + ")0b")).toEqual([
		`cell 0,0 char: ours "b", xterm "␉"`,
	]);
});

test("both screens share the scroll margins and tab stops, as in xterm", async () => {
	expect(
		await compareWithXterm(E + "[1;2r" + E + "[?1049h" + E + "[9BX"),
	).toEqual(
		[
			`cell 0,1 char: ours "X", xterm " "`,
			`cell 0,5 char: ours " ", xterm "X"`,
			"cursor: ours 1,1, xterm 1,5",
		],
	);
	expect(await compareWithXterm(E + "[3g" + E + "[?47h\tX")).toEqual([
		`cell 8,0 char: ours " ", xterm "X"`,
		`cell 19,0 char: ours "X", xterm " "`,
		"cursor: ours 19,0, xterm 9,0",
	]);
});

test("DECRQSS reports the real SGR and cursor shape, where xterm.js reports defaults", async () => {
	expect(await compareWithXterm(E + "[1;31m" + E + "P$qm" + E + "\\")).toEqual([
		`replies: ours "\\u001bP1$r0;1;31m\\u001b\\\\", xterm "\\u001bP1$r0m\\u001b\\\\"`,
	]);
	expect(await compareWithXterm(E + "[4 q" + E + "P$q q" + E + "\\")).toEqual([
		`replies: ours "\\u001bP1$r4 q\\u001b\\\\", xterm "\\u001bP1$r2 q\\u001b\\\\"`,
	]);
});

test("a mark after a sequence joins the character before, where xterm.js gives it a cell of no width", async () => {
	expect(await compareWithXterm("e" + E + "[ḿ")).toEqual([
		`cell 0,0 char: ours "e\u0301", xterm "e"`,
		`cell 1,0 char: ours " ", xterm ""`,
		"cell 1,0 width: ours 1, xterm 0",
		"cursor: ours 1,0, xterm 2,0",
	]);
});

test("a cursor report from past the last column gives the last column, where xterm.js gives one more", async () => {
	expect(await compareWithXterm("abcdefghijklmnopqrst" + E + "[6n")).toEqual([
		`replies: ours "\\u001b[1;20R", xterm "\\u001b[1;21R"`,
	]);
});

test("SD fills in the background color as SU does, where xterm.js uses the default", async () => {
	expect(await compareWithXterm(E + "[42m" + E + "[T")).toEqual(
		Array.from({length: 20}, (_, x) => `cell ${x},0 bg: ours 2, xterm -1`),
	);
});

test("an erase from the last column erases it and ends the wait to wrap, as in xterm and Ghostty, where xterm.js erases nothing", async () => {
	expect(await compareWithXterm("abcdefghijklmnopqrst" + E + "[KX")).toEqual([
		'cell 19,0 char: ours "X", xterm "t"',
		'cell 0,1 char: ours " ", xterm "X"',
		"cursor: ours 19,0, xterm 1,1",
	]);
});

test("47 keeps what the alternate screen held, as in xterm and Ghostty, where xterm.js clears it", async () => {
	expect(
		await compareWithXterm(E + "[?47hkept" + E + "[?47l" + E + "[?47h"),
	).toEqual(
		[
			'cell 0,0 char: ours "k", xterm " "',
			'cell 1,0 char: ours "e", xterm " "',
			'cell 2,0 char: ours "p", xterm " "',
			'cell 3,0 char: ours "t", xterm " "',
		],
	);
});

// Streams that would reach a difference pinned above are left out:
// origin mode is never set, a stream that saves before anything else
// never restores nothing, and there is no ED, EL, RI or switch of
// screens, which the comparison with Ghostty checks.
function reachesException(text: string): boolean {
	const restore = /\x1b8|\x1b\[u|\?1048l/.test(text);
	return (
		(/\x1b[()]|[\x0e\x0f]/.test(text) && restore) ||
		(/\[\d*T/.test(text) && /[;[]4[0-7][;m]|48;/.test(text))
	);
}

test(
	"agrees with xterm.js on 3000 random streams",
	async () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const next = random(seed);
			const tokens = Array.from(
				{length: 5 + Math.floor(next() * 40)},
				() => token(next),
			)
				.filter(
					(each) => !/^\x1b(?:\[\d*[JK]|M|\[\?(?:47|1047|1049)[hl])$/.test(
						each,
					),
				);
			const cols = 8 + Math.floor(next() * 8);
			const rows = 3 + Math.floor(next() * 4);
			if (reachesException(tokens.join(""))) {
				continue;
			}
			tokens.unshift(`${E}7${E}[?47h${E}7${E}[?47l`);
			const differences = await compareWithXterm(tokens.join(""), {cols, rows});
			if (differences.length > 0) {
				let smallest = tokens;
				for (let index = smallest.length - 1; index >= 0; index--) {
					const fewer = smallest.filter((_, other) => other !== index);
					if (
						(await compareWithXterm(fewer.join(""), {cols, rows})).length > 0
					) {
						smallest = fewer;
					}
				}
				expect({
					seed,
					size: `${cols}x${rows}`,
					smallest,
					differences: await compareWithXterm(smallest.join(""), {cols, rows}),
				}).toEqual(null);
			}
		}
	},
	120000,
);

for (const name of ["vim", "nvim", "less", "gitlog", "bash", "tmux"]) {
	test(`agrees with xterm.js through a recorded ${name} session`, async () => {
		const bytes = new Uint8Array(
			readFileSync(new URL(`./fixtures/vt/${name}.bin`, import.meta.url)),
		);
		for (let cut = 1; cut <= 8; cut++) {
			const end = Math.round((bytes.length * cut) / 8);
			expect({
				cut,
				differences: await compareWithXterm(bytes.subarray(0, end), {
					cols: 80,
					rows: 24,
					scrollback: 100,
					sgrReports: "ignore",
				}),
			}).toEqual({cut, differences: []});
		}
	});
}
