/**
 * The pty embed's emulator against Ghostty. Where the two differ, the
 * emulator follows xterm, and the test pins the difference.
 */
import {readdirSync, readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {compareWithGhostty} from "./ghostty-oracle.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.ts";
import {AGREED, E, random, token} from "./vt-cases.ts";

const PINNED = new Set([
	"REP of a combining character",
	"alternate screen cleared in the background color",
	"DECSTR",
	"OSC 8 links",
	"a wide character after BS",
	"8-bit CSI",
]);

// Where the emulator follows xterm and Ghostty, and xterm.js differs.
const WITH_XTERM: Record<string, string> = {
	"an erase from the last column": "abcdefghijklmnopqrst" + E + "[KX",
	"47 keeps what the alternate screen held":
		E + "[?47hkept" + E + "[?47l" + E + "[?47h",
	"1047 clears the alternate screen as it leaves":
		E + "[?1047hgone" + E + "[?1047l" + E + "[?47h",
	"1049 clears the alternate screen each time it enters":
		E + "[?1049hgone" + E + "[?1049h",
	"a wait to wrap kept across screens": "abcdefghijklmnopqrst" + E + "[?47hX",
	"a wait to wrap kept by DECSC": "abcdefghijklmnopqrst" + E + "7" + E + "8X",
	"a wait to wrap kept by RI at the top": "abcdefghijklmnopqrst" + E + "MX",
	"a wait to wrap ended by RI below the top":
		"\nabcdefghijklmnopqrst" + E + "MX",
};

for (const [name, data] of Object.entries(WITH_XTERM)) {
	test(`agrees with Ghostty: ${name}`, () => {
		expect(compareWithGhostty(data, {scrollback: 10})).toEqual([]);
	});
}

for (const [name, data] of Object.entries(AGREED)) {
	if (!PINNED.has(name)) {
		test(`agrees with Ghostty: ${name}`, () => {
			expect(compareWithGhostty(data, {scrollback: 10})).toEqual([]);
		});
	}
}

test("REP repeats a combining mark with its base, where Ghostty repeats the base alone", () => {
	expect(compareWithGhostty(AGREED["REP of a combining character"])).toEqual([
		'cell 1,0 char: ours "e\u0301", ghostty "e"',
		'cell 2,0 char: ours "e\u0301", ghostty "e"',
	]);
});

test("the alternate screen clears in the background color, as in xterm, where Ghostty clears in the default", () => {
	const differences = compareWithGhostty(
		AGREED["alternate screen cleared in the background color"],
	);
	expect(differences.length).toBe(120);
	expect(new Set(differences.map((line) => line.replace(/\d+,\d+/, "x,y"))))
		.toEqual(new Set(["cell x,y bg: ours #00cd00, ghostty #040506"]));
});

test("DECSTR resets the SGR and shows the cursor, as DEC specifies, where Ghostty keeps both", () => {
	expect(compareWithGhostty(AGREED.DECSTR)).toEqual([
		'cell 3,0 attrs: ours "", ghostty "bold"',
		"cursorVisible: ours true, ghostty false",
	]);
});

test("a link is underlined, where Ghostty leaves the underline to its renderer", () => {
	expect(compareWithGhostty(AGREED["OSC 8 links"])).toEqual(
		[0, 1, 2, 3].map((x) => `cell ${x},0 attrs: ours "underline", ghostty ""`),
	);
});

test("the half of a wide character left behind keeps the attributes, where Ghostty clears them", () => {
	expect(compareWithGhostty(AGREED["a wide character after BS"])).toEqual([
		'cell 0,0 attrs: ours "bold", ghostty ""',
	]);
});

test("an 8-bit CSI written as UTF-8 is a CSI, as in xterm.js, where Ghostty ignores it", () => {
	expect(compareWithGhostty(AGREED["8-bit CSI"])).toContain(
		"cursor: ours 2,0, ghostty 6,0",
	);
});

test("a 0 count is 1, as in xterm, where Ghostty does nothing", () => {
	expect(compareWithGhostty("abc" + E + "[0S")).toEqual([
		'cell 0,0 char: ours " ", ghostty "a"',
		'cell 1,0 char: ours " ", ghostty "b"',
		'cell 2,0 char: ours " ", ghostty "c"',
	]);
	expect(compareWithGhostty(E + "[0I")).toEqual([
		"cursor: ours 8,0, ghostty 0,0",
	]);
});

test("REP repeats only the character printed last, as in xterm.js, where Ghostty repeats past other sequences", () => {
	expect(compareWithGhostty("a" + E + "[22m" + E + "[2b")).toEqual([
		'cell 1,0 char: ours " ", ghostty "a"',
		'cell 2,0 char: ours " ", ghostty "a"',
		"cursor: ours 1,0, ghostty 3,0",
	]);
});

test("the DEC line drawing set leaves wide characters alone, where Ghostty blanks them", () => {
	expect(compareWithGhostty(E + "(0中")).toEqual([
		'cell 0,0 char: ours "中", ghostty " "',
	]);
});

test("CBT from the last column does nothing, as in xterm.js, where Ghostty moves the cursor and still wraps the next character", () => {
	expect(compareWithGhostty("ab0123456789" + E + "[2Z", {cols: 12}))
		.toEqual(["cursor: ours 11,0, ghostty 0,0"]);
});

test("a combining mark after the last column joins the character there, where Ghostty drops it", () => {
	expect(compareWithGhostty(E + "[1;30Hé", {cols: 9, rows: 5})).toEqual([
		'cell 8,0 char: ours "e\u0301", ghostty "e"',
	]);
});

// The tokens that would reach a difference pinned above are left out:
// a count of 0, REP, CBT and combining marks always, wide characters in a
// stream with a DEC set, an SGR or an erase, and alternate screens in a
// stream with a background color.
function withoutExceptions(tokens: string[]): string[] {
	const kept = tokens.filter(
		(each) => !/\x1b\[(?:[\d;]*;)?0[@A-Za-z`;]|\x1b\[\d*[bZ]|\u0301/.test(each),
	);
	const text = kept.join("");
	const wide = /\x1b[()]0|\x0e|\x1b\[[\d;]*[mKJ]/.test(text);
	const background = /[;[](?:4[0-7]|48)[;m]/.test(text);
	return kept.filter(
		(each) =>
			!(wide && /[^\x00-\x7f]/.test(each)) &&
			!(background && /\?(?:47|1047|1049)h/.test(each)),
	);
}

test(
	"agrees with Ghostty on 3000 random streams",
	() => {
		for (let seed = 1; seed <= 3000; seed++) {
			const next = random(seed);
			const tokens = withoutExceptions(
				Array.from({length: 5 + Math.floor(next() * 40)}, () => token(next)),
			);
			const cols = 8 + Math.floor(next() * 8);
			const rows = 3 + Math.floor(next() * 4);
			tokens.unshift(`${E}7${E}[?47h${E}7${E}[?47l`);
			if (compareWithGhostty(tokens.join(""), {cols, rows}).length > 0) {
				let smallest = tokens;
				for (let index = smallest.length - 1; index >= 0; index--) {
					const fewer = smallest.filter((_, other) => other !== index);
					if (compareWithGhostty(fewer.join(""), {cols, rows}).length > 0) {
						smallest = fewer;
					}
				}
				expect({
					seed,
					size: `${cols}x${rows}`,
					smallest,
					differences: compareWithGhostty(smallest.join(""), {cols, rows}),
				}).toEqual(null);
			}
		}
	},
	120000,
);

for (const name of ["vim", "nvim", "less", "gitlog", "bash", "tmux"]) {
	test(`agrees with Ghostty through a recorded ${name} session`, () => {
		const bytes = new Uint8Array(
			readFileSync(new URL(`./fixtures/vt/${name}.bin`, import.meta.url)),
		);
		for (let cut = 1; cut <= 8; cut++) {
			const end = Math.round((bytes.length * cut) / 8);
			expect({
				cut,
				differences: compareWithGhostty(bytes.subarray(0, end), {
					cols: 80,
					rows: 24,
					scrollback: 100,
				}),
			}).toEqual({cut, differences: []});
		}
	});
}

const EMAILS = new URL("./fixtures/email/", import.meta.url);

for (const name of readdirSync(EMAILS).filter((file) =>
	file.endsWith(".html"),
)) {
	test(`agrees with Ghostty on TermDOM's own frames of ${name}`, async () => {
		const cols = 100;
		const rows = 40;
		const terminal = new MockProcess({cols, rows, colorDepth: "rgb"});
		const raw = captureRawOutput(terminal, {forward: false});
		const dom = new TermDOM({
			transport: terminal.transport,
			colorDepth: "rgb",
			cellSize: {width: 7, height: 15},
		});
		const {document} = dom;
		const parsed = new dom.window.DOMParser().parseFromString(
			readFileSync(new URL(name, EMAILS), "utf8"),
			"text/html",
		);
		for (const style of parsed.querySelectorAll("style")) {
			document.head.append(document.adoptNode(style));
		}
		document.body.append(
			...[...parsed.body.childNodes].map((node) => document.adoptNode(node)),
		);
		await nextFrame(dom);
		for (let step = 0; step < 3; step++) {
			dom.window.scrollBy(0, 300);
			await nextFrame(dom);
		}
		const bytes = raw();
		await dom.dispose();
		expect(compareWithGhostty(bytes, {cols, rows})).toEqual([]);
	});
}
