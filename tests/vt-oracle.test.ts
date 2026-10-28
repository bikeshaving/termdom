/**
 * The pty embed's emulator against xterm.js. Where the two differ on
 * purpose, the test says so and pins the difference: each one is a place
 * xterm.js departs from xterm, checked against tmux or DEC's manuals.
 */
import {readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import {compareWithXterm} from "./vt-oracle.ts";

const E = "\x1b";

const AGREED: Record<string, string> = {
	"text and CRLF": "hello\r\nworld",
	wrapping: "abcdefghijklmnopqrstuvwxyz0123",
	"CR from past the last column": "abcdefghijklmnopqrst\rX",
	"BS from past the last column": "abcdefghijklmnopqrst\bX",
	"CUP from past the last column": "abcdefghijklmnopqrst" + E + "[1;1HX",
	"EL from past the last column": "abcdefghijklmnopqrst" + E + "[K",
	"autowrap off": E + "[?7labcdefghijklmnopqrstuvwxyz",
	scrolling: "1\n2\n3\n4\n5\n6\n7\n8",
	"LF alone": "a\nb\nc",
	tabs: "a\tb\tc",
	"tab stops set and cleared": E + "[3g" + E + "[5G" + E + "H\r\tX",
	"CHT and CBT": "\t\t" + E + "[Z" + "X" + E + "[2IY",
	"cursor movement":
		E + "[3;5HA" + E + "[2AB" + E + "[3CC" + E + "[DD" + E + "[ED" + E + "[FF",
	"cursor clamped": E + "[99;99HX" + E + "[99AY" + E + "[99DZ",
	"HPA, VPA, HPR and VPR": E + "[5`A" + E + "[3dB" + E + "[2aC" + E + "[1eD",
	"CUD stops at the bottom margin from above it": E + "[2;3r" + E + "[3BX",
	"VPR passes the bottom margin": E + "[1;2r" + E + "[2eX",
	"ED 0": "aaaaa\r\nbbbbb\r\nccccc" + E + "[2;3H" + E + "[J",
	"ED 1": "aaaaa\r\nbbbbb\r\nccccc" + E + "[2;3H" + E + "[1J",
	"ED 2": "aaaaa\r\nbbbbb" + E + "[2J",
	"EL 0, 1 and 2":
		"abcdefgh" +
		E +
		"[4G" +
		E +
		"[K\r\nabcdefgh" +
		E +
		"[4G" +
		E +
		"[1K\r\nabcdefgh" +
		E +
		"[2K",
	ECH: "abcdefgh" + E + "[3G" + E + "[3X",
	"ICH and DCH":
		"abcdefgh" + E + "[3G" + E + "[2@\r\nabcdefgh" + E + "[3G" + E + "[2P",
	"IL and DL": "1\r\n2\r\n3\r\n4" + E + "[2H" + E + "[L" + E + "[3H" + E + "[M",
	"SU and SD": "1\r\n2\r\n3\r\n4" + E + "[2S" + E + "[T",
	"scroll region": E + "[2;4r" + E + "[4H" + "\n\n\nX",
	"reverse index in a region": E + "[2;4r" + E + "[2H" + E + "M" + E + "MX",
	"IND and NEL": "a" + E + "Db" + E + "Ec",
	REP: "a" + E + "[3b",
	"REP of a combining character": "é" + E + "[2b",
	"SGR attributes": E + "[1;2;3;4;5;7;8;9;53mX" + E + "[mY",
	"SGR resets": E + "[1;3;4;5;7;8;9m" + E + "[22;23;24;25;27;28;29mA",
	"SGR colors": E + "[31;42mA" + E + "[91;102mB" + E + "[39;49mC",
	"SGR 256 colors": E + "[38;5;123;48;5;45mA" + E + "[38:5:200mB",
	"SGR RGB with semicolons": E + "[38;2;1;2;3;48;2;4;5;6mA",
	"SGR RGB with colons": E + "[38:2::1:2:3mA" + E + "[38:2:1:2:3:4mB",
	"SGR underline styles":
		E + "[4:3mA" + E + "[4:0mB" + E + "[21mC" + E + "[24mD",
	"SGR empty parameter": E + "[1;;3mA",
	"erasing in the background color": E + "[44m" + E + "[2J" + E + "[KX",
	"insert mode": "abcdef" + E + "[3G" + E + "[4hXY" + E + "[4lZ",
	"DECSC and DECRC":
		E + "[3;3H" + E + "[1m" + E + "7" + E + "[H" + E + "[m" + E + "8X",
	"SCOSC and SCORC": E + "[3;3H" + E + "[s" + E + "[H" + E + "[uX",
	"DECRC keeps autowrap":
		E + "7" + E + "[?7l" + E + "8abcdefghijklmnopqrstuvwxyz",
	"alternate screens":
		"main" +
		E +
		"[?1049halt" +
		E +
		"[?1049lX" +
		E +
		"[?47hB" +
		E +
		"[?47l" +
		E +
		"[?1047hC" +
		E +
		"[?1047lD",
	"alternate screen cleared in the background color":
		E + "[42m" + E + "[?1049h",
	"DEC line drawing": E + "(0lqqk" + E + "(B x",
	"SO and SI": E + ")0" + "\x0elqk\x0f x",
	modes:
		E +
		"[?1h" +
		E +
		"[?2004h" +
		E +
		"[?1004h" +
		E +
		"[?1002h" +
		E +
		"[?25l" +
		E +
		"[?2026h",
	"mouse modes": E + "[?1003h" + E + "[?1006h",
	RIS: "abc" + E + "[?1h" + E + "c",
	DECSTR: "abc" + E + "[1m" + E + "[?25l" + E + "[!pX",
	DECALN: E + "#8",
	titles: E + "]0;one\x07" + E + "]2;two" + E + "\\" + E + "]1;icon\x07",
	"OSC 8 links": E + "]8;;http://example.com\x07link" + E + "]8;;\x07 after",
	"DA1 and DA2": E + "[c" + E + "[>c",
	DSR: E + "[5n" + E + "[3;4H" + E + "[6n" + E + "[?6n",
	DECRQM: E + "[?2004$p" + E + "[4$p" + E + "[?2026$p" + E + "[?9999$p",
	"DECRQSS margins and unknown":
		E +
		"[2;4r" +
		E +
		"Pr" +
		E +
		"\\" +
		E +
		"P$qr" +
		E +
		"\\" +
		E +
		"P$qx" +
		E +
		"\\",
	"wide characters": "中文字",
	"a wide character at the last column": "abcdefghijklmnopqrs中",
	"overwriting half a wide character": "中文" + E + "[1;2HX",
	"a wide character after BS": E + "[1;42m😀\ba",
	"combining marks": "éx",
	"ZWJ sequences": "👨‍💻x",
	"8-bit CSI": "a\u009b31mb",
	"CAN inside a sequence": E + "[3\x18X",
	BEL: "a\x07b",
	"a control inside CSI": E + "[2\r;3HX",
	"RI at the top": E + "MX",
	"unknown private mode": E + "[?9999hX",
	"keypad modes": E + "=" + E + ">",
	LNM: E + "[20ha\nb",
};

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

function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function token(next: () => number): string {
	const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
	const n = () => pick([0, 1, 1, 2, 3, 5, 8, 12, 30, 99]);
	switch (Math.floor(next() * 16)) {
		case 0:
		case 1:
		case 2:
			return pick(["a", "b", "xyz", "hello", "0123456789"]);
		case 3:
			return pick(["中", "文字", "é", "😀", "é"]);
		case 4:
			return pick(["\r", "\n", "\b", "\t", "\r\n", "\x0b", "\x0c"]);
		case 5:
			return `${E}[${n()};${n()}H`;
		case 6:
			return `${E}[${next() < 0.3 ? "" : n()}${pick([..."ABCDEFGIZ`ade"])}`;
		case 7:
			return `${E}[${pick(["", "0", "1", "2"])}${pick(["J", "K"])}`;
		case 8:
			return `${E}[${n()}${pick([..."@PXLMSTb"])}`;
		case 9:
			return `${E}[${n()};${n()}r`;
		case 10:
			return `${E}[${pick(["?7", "4", "?1049", "?47", "?1047", "?1048", "?25", "20"])}${pick(
				["h", "l"],
			)}`;
		case 11:
			return `${E}[${Array.from({length: 1 + Math.floor(next() * 3)}, () => pick(
				["0", "1", "4", "7", "31", "42", "93", "38;5;100", "48;2;1;2;3", "39", "49", "22", "24", "27"],
			)).join(";")}m`;
		case 12:
			return pick([
				`${E}7`,
				`${E}8`,
				`${E}[s`,
				`${E}[u`,
				`${E}D`,
				`${E}E`,
				`${E}M`,
				`${E}H`,
			]);
		case 13:
			return pick([`${E}(0`, `${E}(B`, "\x0e", "\x0f", `${E})0`]);
		case 14:
			return `${E}[${n()}${pick(["g", "I"])}${next() < 0.5 ? `${E}H` : ""}`;
		default:
			return `${E}[${n()}${pick([..."ABCD"])}`;
	}
}

// Streams that would reach a difference pinned above are left out:
// origin mode is never set, and a stream that saves before anything else
// never restores nothing.
function reachesException(text: string): boolean {
	const alternate = /\?(47|1047|1049)[hl]/.test(text);
	const restore = /\x1b8|\x1b\[u|\?(1048|1049)l/.test(text);
	return (
		(/\[\d*;\d*r/.test(text) && alternate) ||
		(/\x1b[()]|[\x0e\x0f]/.test(text) && restore) ||
		(/\[\d*g|\x1bH/.test(text) && alternate) ||
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
