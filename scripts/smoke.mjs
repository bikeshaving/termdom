/**
 * Cross-runtime smoke test: renders a document with the *compiled* library and
 * checks the result.
 *
 * termdom is developed under Bun, where Bun.stringWidth and Bun.color do the
 * work. On Node and Deno those fall back to the pure-JS implementations in
 * src/runtime.ts, and nothing in `bun test` ever executes that path -- so a
 * regression there is invisible to the entire suite and misrenders text on
 * every runtime except the one we develop on.
 *
 * This runs against dist/, because that is what a consumer actually loads:
 * neither Node nor Deno maps a ".js" specifier onto a ".ts" source file the way
 * Bun does, so the examples cannot be run from source off-Bun.
 *
 *   bun run build && node scripts/smoke.mjs
 *   bun run build && deno run -A --node-modules-dir=manual scripts/smoke.mjs
 */
import {TermDOM} from "../dist/index.js";
import {stringWidth, cssColorToNumber, isBun, isDeno} from "../dist/runtime.js";

const runtime = isDeno ? "Deno" : isBun ? "Bun" : "Node";
const failures = [];

function check(label, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures.push(`${label}: got ${actual}, want ${expected}`);
	console.log(
		`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(28)} ${String(actual).padStart(6)}`,
	);
}

console.log(`\ntermdom smoke test on ${runtime}\n`);

// The width fallbacks. Kana, CJK punctuation and grapheme clusters are the ones
// a naive implementation gets wrong, and width drives every line break and cell
// position, so being wrong here misaligns the whole screen.
console.log("string width:");
check("ascii", stringWidth("hello"), 5);
check("cjk ideographs", stringWidth("中文字"), 6);
check("hiragana", stringWidth("こんにちは"), 10);
check("cjk punctuation", stringWidth("、。「」"), 8);
check("emoji", stringWidth("🚀"), 2);
check("emoji zwj family", stringWidth("👨‍👩‍👧"), 2);
check("regional indicator flag", stringWidth("🇯🇵"), 2);
check("combining accent", stringWidth("é"), 1);

console.log("\ncolor parsing:");
check("hex", cssColorToNumber("#ff8000"), 0xff8000);
check("shorthand hex", cssColorToNumber("#f80"), 0xff8800);
check("named", cssColorToNumber("red"), 0xff0000);
check("rgb()", cssColorToNumber("rgb(0, 128, 255)"), 0x0080ff);

// Layout: a flex row whose middle item grows. The three items must tile the 40
// columns exactly -- no gap, no overlap -- which is the whole point of rounding
// edges rather than sizes.
const term = new TermDOM({width: 40, height: 6, detectCursor: false});
const {document} = term;
document.body.innerHTML = `
	<div style="display:flex; flex-direction:row; width:40ch">
		<div style="width:4ch">left</div>
		<div style="flex:1">MIDDLE</div>
		<div style="width:5ch">right</div>
	</div>`;
term.render();

const items = [...document.querySelectorAll("div div")];
const boxes = items.map((el) => el.getBoundingClientRect());

console.log("\nflex layout (40 columns):");
check("left width", boxes[0].width, 4);
check("left x", boxes[0].left, 0);
check("middle grew", boxes[1].width, 31);
check("middle x", boxes[1].left, 4);
check("right width", boxes[2].width, 5);
check("right x", boxes[2].left, 35);
check(
	"items tile exactly",
	boxes[0].width + boxes[1].width + boxes[2].width,
	40,
);

if (failures.length > 0) {
	console.error(`\n${failures.length} failure(s) on ${runtime}:`);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`\nAll checks passed on ${runtime}.\n`);
