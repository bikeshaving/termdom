/**
 * The emulator behind <embed type="application/x-pty">, fed the
 * sequences programs write and checked cell by cell.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	BOLD,
	DEFAULT_COLOR,
	DOUBLE_UNDERLINE,
	INVERSE,
	RGB_COLOR,
	Terminal,
	UNDERLINE,
} from "../src/internal/vt.ts";

function create(cols = 10, rows = 4): {term: Terminal; replies: string[]} {
	const replies: string[] = [];
	const term = new Terminal(cols, rows, (data) => replies.push(data));
	return {term, replies};
}

function screen(term: Terminal): string[] {
	return term.lines.map((line) => line.chars
		.map((char, col) => line.widths[col] === 0 ? "" : char || " ")
		.join("")
		.trimEnd(),
	);
}

test("text prints, and CR and LF move the cursor", () => {
	const {term} = create();
	term.write("ab\r\ncd");
	expect(screen(term)).toEqual(["ab", "cd", "", ""]);
	expect([term.x, term.y]).toEqual([2, 1]);
});

test("bytes split inside a UTF-8 character still decode", () => {
	const {term} = create();
	const bytes = new TextEncoder().encode("é→");
	term.write(bytes.subarray(0, 1));
	term.write(bytes.subarray(1, 3));
	term.write(bytes.subarray(3));
	expect(screen(term)[0]).toBe("é→");
});

test("the last column waits to wrap until the next character", () => {
	const {term} = create(4, 3);
	term.write("abcd");
	expect([term.x, term.y, term.wrapPending]).toEqual([3, 0, true]);
	term.write("e");
	expect(screen(term)).toEqual(["abcd", "e", ""]);
	term.write("\x1b[?7l\x1b[2;1Hwxyz!");
	expect(screen(term)[1]).toBe("wxy!");
});

test("the screen scrolls at the bottom", () => {
	const {term} = create(4, 3);
	term.write("1\r\n2\r\n3\r\n4");
	expect(screen(term)).toEqual(["2", "3", "4"]);
});

test("wide characters take two cells and wrap whole", () => {
	const {term} = create(5, 2);
	term.write("ab漢");
	expect(term.lines[0].widths.slice(0, 4)).toEqual(
		new Uint8Array([1, 1, 2, 0]),
	);
	term.write("字");
	expect(screen(term)).toEqual(["ab漢", "字"]);
	term.write("\x1b[1;4Hx");
	expect(screen(term)[0]).toBe("ab x");
});

test("combining marks join the character before them", () => {
	const {term} = create();
	term.write("éx");
	expect(term.lines[0].chars.slice(0, 2)).toEqual(["é", "x"]);
});

test("cursor movement is clamped to the screen", () => {
	const {term} = create(10, 5);
	term.write("\x1b[3;4H");
	expect([term.x, term.y]).toEqual([3, 2]);
	term.write("\x1b[10A\x1b[100C");
	expect([term.x, term.y]).toEqual([9, 0]);
	term.write("\x1b[2B\x1b[3D\x1b[7G\x1b[4d");
	expect([term.x, term.y]).toEqual([6, 3]);
});

test("ED and EL erase parts of the screen", () => {
	const {term} = create(5, 3);
	term.write("aaaaa\r\nbbbbb\r\nccccc\x1b[2;3H\x1b[K");
	expect(screen(term)).toEqual(["aaaaa", "bb", "ccccc"]);
	term.write("\x1b[1K");
	expect(screen(term)[1]).toBe("");
	term.write("\x1b[J");
	expect(screen(term)).toEqual(["aaaaa", "", ""]);
	term.write("\x1b[2J");
	expect(screen(term)).toEqual(["", "", ""]);
});

test("erasing fills with the current background", () => {
	const {term} = create(4, 2);
	term.write("\x1b[44m\x1b[2J");
	expect(term.lines[1].bg[3]).toBe(4);
});

test("SGR sets attributes and colors in every form", () => {
	const {term} = create(20, 2);
	term.write("\x1b[1;4;31;42ma\x1b[0m");
	term.write("\x1b[38;5;200;48;2;1;2;3mb");
	term.write("\x1b[38:2::10:20:30mc\x1b[4:2;7md\x1b[24;27;39;49me");
	const line = term.lines[0];
	expect(line.attrs[0]).toBe(BOLD | UNDERLINE);
	expect([line.fg[0], line.bg[0]]).toEqual([1, 2]);
	expect([line.fg[1], line.bg[1]]).toEqual([200, RGB_COLOR | 0x010203]);
	expect(line.fg[2]).toBe(RGB_COLOR | 0x0a141e);
	expect(line.attrs[3]).toBe(DOUBLE_UNDERLINE | INVERSE);
	expect([line.attrs[4], line.fg[4], line.bg[4]]).toEqual([
		0,
		DEFAULT_COLOR,
		DEFAULT_COLOR,
	]);
});

test("a scroll region keeps the lines outside it", () => {
	const {term} = create(4, 5);
	term.write("top\r\n1\r\n2\r\n3\r\nbot");
	term.write("\x1b[2;4r\x1b[4;1H\n");
	expect(screen(term)).toEqual(["top", "2", "3", "", "bot"]);
	term.write("\x1b[2;1H\x1bM");
	expect(screen(term)).toEqual(["top", "", "2", "3", "bot"]);
});

test("IL and DL insert and delete lines within the region", () => {
	const {term} = create(4, 4);
	term.write("a\r\nb\r\nc\r\nd\x1b[2;1H\x1b[L");
	expect(screen(term)).toEqual(["a", "", "b", "c"]);
	term.write("\x1b[2M");
	expect(screen(term)).toEqual(["a", "c", "", ""]);
});

test("ICH, DCH and ECH edit within the line", () => {
	const {term} = create(6, 1);
	term.write("abcdef\x1b[1;2H\x1b[2@");
	expect(screen(term)[0]).toBe("a  bcd");
	term.write("\x1b[3P");
	expect(screen(term)[0]).toBe("acd");
	term.write("\x1b[1;1H\x1b[2X");
	expect(screen(term)[0]).toBe("  d");
});

test("insert mode pushes text right", () => {
	const {term} = create(6, 1);
	term.write("abc\x1b[1;1H\x1b[4hX\x1b[4lY");
	expect(screen(term)[0]).toBe("XYbc");
});

test("tabs stop every eight columns and can be set and cleared", () => {
	const {term} = create(20, 1);
	term.write("\tx");
	expect(term.x).toBe(9);
	term.write("\x1b[3g\x1b[1;4H\x1bH\r\t");
	expect(term.x).toBe(3);
	term.write("\x1b[Z");
	expect(term.x).toBe(0);
});

test("the alternate screen keeps the main screen and the cursor", () => {
	const {term} = create(6, 2);
	term.write("shell\x1b[?1049h");
	expect(screen(term)).toEqual(["", ""]);
	term.write("\x1b[2;2Hvim");
	term.write("\x1b[?1049l");
	expect(screen(term)).toEqual(["shell", ""]);
	expect([term.x, term.y]).toEqual([5, 0]);
});

test("DECSC and DECRC restore the cursor and its style", () => {
	const {term} = create();
	term.write("\x1b[2;3H\x1b[1m\x1b7\x1b[0m\x1b[H\x1b8x");
	expect(term.lines[1].attrs[2]).toBe(BOLD);
	expect([term.x, term.y]).toEqual([3, 1]);
});

test("line drawing comes from the DEC graphics set", () => {
	const {term} = create();
	term.write("\x1b(0lqk\x1b(Bq");
	expect(screen(term)[0]).toBe("┌─┐q");
	term.write("\r\n\x1b)0\x0eq\x0fq");
	expect(screen(term)[1]).toBe("─q");
});

test("modes the keys and the cursor depend on are tracked", () => {
	const {term} = create();
	term.write("\x1b[?1h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h");
	expect(term.applicationCursor).toBe(true);
	expect(term.cursorVisible).toBe(false);
	expect(term.bracketedPaste).toBe(true);
	expect([term.mouseTracking, term.mouseEncoding]).toEqual([1000, 1006]);
	term.write("\x1b[?1l\x1b[?25h");
	expect(term.applicationCursor).toBe(false);
	expect(term.cursorVisible).toBe(true);
});

test("questions about the terminal are answered", () => {
	const {term, replies} = create(10, 5);
	term.write("\x1b[3;4H\x1b[6n\x1b[5n\x1b[c\x1b[>c\x1b[18t\x1b[?25$p");
	expect(replies).toEqual([
		"\x1b[3;4R",
		"\x1b[0n",
		"\x1b[?1;2c",
		"\x1b[>0;276;0c",
		"\x1b[8;5;10t",
		"\x1b[?25;1$y",
	]);
});

test("OSC, DCS and unknown sequences draw nothing", () => {
	const {term} = create(20, 1);
	term.write("\x1b]0;title\x07a\x1b]2;x\x1b\\b\x1bPq#0\x1b\\c\x1b[?9999hd");
	expect(screen(term)[0]).toBe("abcd");
});

test("resizing keeps the cursor's row on screen", () => {
	const {term} = create(6, 4);
	term.write("1\r\n2\r\n3\r\n4");
	term.resize(3, 2);
	expect(screen(term)).toEqual(["3", "4"]);
	expect([term.x, term.y]).toEqual([1, 1]);
	term.resize(8, 3);
	expect(screen(term)).toEqual(["3", "4", ""]);
	term.write("\x1b[3;8Hz");
	expect(term.lines[2].chars[7]).toBe("z");
});

test("resizing drops a wide character it cuts in half", () => {
	const {term} = create(4, 1);
	term.write("ab漢");
	term.resize(3, 1);
	expect(screen(term)[0]).toBe("ab");
});

test("DECSCUSR sets the cursor's shape, and a full reset clears it", () => {
	const {term} = create();
	expect(term.cursorShape).toBe(0);
	term.write("\x1b[6 q");
	expect(term.cursorShape).toBe(6);
	term.write("\x1b[9 q");
	expect(term.cursorShape).toBe(0);
	term.write("\x1b[2 q\x1bc");
	expect(term.cursorShape).toBe(0);
});

function historyText(term: Terminal): string[] {
	return term.history.map((line) => line.chars.join("").trimEnd());
}

test("lines that scroll off the top go into history, up to the limit", () => {
	const {term} = create(10, 2);
	term.write("a\r\nb\r\nc\r\nd");
	expect(historyText(term)).toEqual([]);
	term.setHistoryLimit(2);
	term.write("\r\ne\r\nf\r\ng");
	expect(historyText(term)).toEqual(["d", "e"]);
	expect(screen(term)).toEqual(["f", "g"]);
	term.setHistoryLimit(1);
	expect(historyText(term)).toEqual(["e"]);
	term.write("\x1b[3J");
	expect(historyText(term)).toEqual([]);
});

test("the alternate screen and a scroll region keep no history", () => {
	const {term} = create(10, 3);
	term.setHistoryLimit(10);
	term.write("\x1b[?1049h1\r\n2\r\n3\r\n4\x1b[?1049l");
	term.write("\x1b[2;3r\x1b[3;1Hx\r\ny\r\nz\x1b[r");
	expect(historyText(term)).toEqual([]);
});

test("rows a resize pushes off the top go into history", () => {
	const {term} = create(10, 4);
	term.setHistoryLimit(10);
	term.write("a\r\nb\r\nc\r\nd");
	term.resize(10, 2);
	expect(historyText(term)).toEqual(["a", "b"]);
	expect(screen(term)).toEqual(["c", "d"]);
});

test("a resize on the alternate screen keeps the shell's last rows", () => {
	const {term} = create(10, 4);
	term.setHistoryLimit(10);
	term.write("a\r\nb\r\nc\r\n$ \x1b[?1049hvim");
	term.resize(10, 2);
	term.write("\x1b[?1049l");
	expect(historyText(term)).toEqual(["a", "b"]);
	expect(screen(term)).toEqual(["c", "$"]);
});

test("a character that would grow past a one-column screen joins nothing", () => {
	const {term} = create(1, 3);
	term.write("a‍😀b");
	for (const line of term.lines) {
		expect([line.chars.length, line.widths.length]).toEqual([1, 1]);
	}
	expect(screen(term)).toEqual(["a\u200d", "b", ""]);
});

test("a resize forgets the character REP and joining marks would use", () => {
	const {term} = create(10, 2);
	term.write("\x1b[9Gx");
	term.resize(4, 2);
	expect(() => term.write("\x1b[b́")).not.toThrow();
	expect(term.lines[0].chars.length).toBe(4);
});
