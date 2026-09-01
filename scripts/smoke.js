/**
 * Cross-runtime smoke test: renders a document with the *compiled* library
 * and checks the result.
 *
 * termdom is developed under Bun, where Bun.stringWidth does the width
 * work. On Node and Deno that falls back to the pure-JS implementations in
 * src/internal/runtime.ts, and nothing in `bun test` ever executes that
 * path -- so a regression there is invisible to the entire suite and
 * misrenders text on every runtime except the one we develop on.
 *
 * The public surface is TermDOM alone, so everything is exercised THROUGH
 * the DOM: widths via layout geometry (the fallback drives every cell
 * position), colors via the ANSI a render emits to a fake process.
 *
 *   bun run build && node scripts/smoke.mjs
 *   bun run build && deno run -A --node-modules-dir=manual scripts/smoke.mjs
 */
import {TermDOM, transportFromProcess} from "../dist/index.js";

const runtime =
	typeof Deno !== "undefined"
		? "Deno"
		: typeof Bun !== "undefined"
			? "Bun"
			: "Node";
const failures = [];

function check(label, actual, expected) {
	const ok = actual === expected;
	if (!ok) {
		failures.push(`${label}: got ${actual}, want ${expected}`);
	}
	console.log(
		`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(28)} ${String(actual).padStart(6)}`,
	);
}

console.log(`\ntermdom smoke test on ${runtime}\n`);

// Widths, measured through layout: each string sits in an inline-block
// whose width IS the string's cell width. Kana, CJK punctuation and
// grapheme clusters are what a naive fallback gets wrong.
const layoutProc = {
	env: {},
	stdout: {write: () => true, isTTY: false, columns: 60, rows: 10},
	stdin: undefined,
	on() {},
	removeListener() {},
	exit(code) {
		throw new Error(`exit(${code})`);
	},
};
const term = new TermDOM({transport: transportFromProcess(layoutProc)});
const {document} = term;
const widthCases = [
	["ascii", "hello", 5],
	["cjk ideographs", "中文字", 6],
	["hiragana", "こんにちは", 10],
	["cjk punctuation", "、。「」", 8],
	["emoji", "🚀", 2],
	["emoji zwj family", "👨‍👩‍👧", 2],
	["regional indicator flag", "🇯🇵", 2],
	["combining accent", "é", 1],
];
document.body.innerHTML = widthCases
	.map(
		([, text], i) =>
			`<div><span id="w${i}" style="display:inline-block">${text}</span></div>`,
	)
	.join("");
// No attach() and no frame await: this instance never touches the terminal,
// and getBoundingClientRect flushes layout synchronously on its own.

console.log("string width (via layout):");
widthCases.forEach(([label, , cells], i) => {
	check(
		label,
		document.getElementById(`w${i}`).getBoundingClientRect().width,
		cells,
	);
});

// Colors, checked in the ANSI a real render emits: the color fallback
// parses these on non-Bun runtimes, and truecolor SGR carries the result
// verbatim.
let out = "";
const proc = {
	env: {COLORTERM: "truecolor", TERM: "xterm-256color"},
	stdout: {
		write(chunk, enc, cb) {
			out += String(chunk);
			const done = typeof enc === "function" ? enc : cb;
			if (typeof done === "function") {
				done();
			}
			return true;
		},
		isTTY: false,
		columns: 60,
		rows: 10,
	},
	stdin: undefined,
	on() {},
	off() {},
	removeListener() {},
};
const colorTerm = new TermDOM({transport: transportFromProcess(proc)});
colorTerm.attach();
colorTerm.document.body.innerHTML =
	"<div style=\"color:#ff8000\">hex</div>" +
	"<div style=\"color:#f80\">short</div>" +
	"<div style=\"color:red\">named</div>" +
	"<div style=\"color:rgb(0, 128, 255)\">rgb</div>";
await new Promise((r) => colorTerm.window.requestAnimationFrame(() => r()));
colorTerm.dispose();

console.log("\ncolor parsing (via rendered SGR):");
check("hex", out.includes("38;2;255;128;0"), true);
check("shorthand hex", out.includes("38;2;255;136;0"), true);
check("named", out.includes("38;2;255;0;0"), true);
check("rgb()", out.includes("38;2;0;128;255"), true);

// Layout: a flex row whose middle item grows. The three items must tile
// the 40 columns exactly -- no gap, no overlap.
document.body.innerHTML = `
	<div style="display:flex; flex-direction:row; width:40ch">
		<div style="width:4ch">left</div>
		<div style="flex:1">MIDDLE</div>
		<div style="width:5ch">right</div>
	</div>`;
// Same as the width section: geometry reads flush layout synchronously.

const boxes = [...document.querySelectorAll("div div")].map((el) =>
	el.getBoundingClientRect(),
);
console.log("\nflex layout (40 columns):");
check("left width", boxes[0].width, 4);
check("middle grew", boxes[1].width, 31);
check("right x", boxes[2].left, 35);
check(
	"items tile exactly",
	boxes[0].width + boxes[1].width + boxes[2].width,
	40,
);

if (failures.length > 0) {
	console.error(`\n${failures.length} failure(s) on ${runtime}:`);
	for (const failure of failures) {
		console.error(`  ${failure}`);
	}
	process.exit(1);
}

console.log(`\nAll checks passed on ${runtime}.\n`);
