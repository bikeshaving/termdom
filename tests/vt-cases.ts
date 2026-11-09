/**
 * Byte streams the pty embed's emulator is checked with, against
 * xterm.js and against Ghostty.
 */
export const E = "\x1b";

/** Byte streams the emulator handles as xterm.js does. */
export const AGREED: Record<string, string> = {
	"text and CRLF": "hello\r\nworld",
	wrapping: "abcdefghijklmnopqrstuvwxyz0123",
	"CR from past the last column": "abcdefghijklmnopqrst\rX",
	"BS from past the last column": "abcdefghijklmnopqrst\bX",
	"CUP from past the last column": "abcdefghijklmnopqrst" + E + "[1;1HX",
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

/** A seeded generator of numbers from 0 to 1. */
export function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

/** One piece of a random stream: text, a control or a sequence. */
export function token(next: () => number): string {
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
