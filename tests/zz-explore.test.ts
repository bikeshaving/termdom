import {test} from "@b9g/libuild/test";
import {inspect} from "util";
import {appendFileSync} from "fs";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, stripControlCodes, nextFrame} from "./test-utils.js";

const OUT = "/private/tmp/claude-501/-Users-brian-Projects-termdom/3e3c4ad6-acd5-4fcd-8993-5e62e9f8bd57/scratchpad/work/out.txt";
const log = (...a: unknown[]) =>
	appendFileSync(OUT, a.map((x) => (typeof x === "string" ? x : inspect(x, {depth: 6, breakLength: 200}))).join(" ") + "\n");

async function probe(name: string, html: string, cols = 30, rows = 10) {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const boxes = Array.from(dom.document.querySelectorAll("i")).map((el) => {
		const r = el.getBoundingClientRect();
		return `${el.textContent}@${r.left},${r.top} ${r.width}x${r.height}`;
	});
	const root = dom.document.querySelector("#g");
	const style = root ? dom.window.getComputedStyle(root) : null;
	log(
		"## " + name,
		"\n  cols:", style?.getPropertyValue("grid-template-columns"),
		" rows:", style?.getPropertyValue("grid-template-rows"),
		"\n  ", boxes.join("  "),
		"\n  ", JSON.stringify(stripControlCodes(terminal.getStaticANSI()).split("\n").map((l) => l.replace(/\s+$/, "")).filter((l,i)=>i<rows)),
	);
}

const G = (extra: string) => `display:grid;${extra}`;

test("explore", async () => {
	appendFileSync(OUT, "\n===== explore =====\n");
	await probe("minmax", `<div id=g style="${G("grid-template-columns: minmax(4px, 8px) minmax(2px, 1fr)")}"><i>a</i><i>b</i></div>`);
	await probe("fit-content", `<div id=g style="${G("grid-template-columns: fit-content(4px) auto")}"><i>aaaaaaaa</i><i>b</i></div>`);
	await probe("min/max-content", `<div id=g style="${G("grid-template-columns: min-content max-content")}"><i>aa bb</i><i>cc dd</i></div>`);
	await probe("auto-fill", `<div id=g style="${G("grid-template-columns: repeat(auto-fill, 7px)")}"><i>a</i><i>b</i></div>`);
	await probe("auto-fit", `<div id=g style="${G("grid-template-columns: repeat(auto-fit, 7px)")}"><i>a</i><i>b</i></div>`);
	await probe("negative line", `<div id=g style="${G("grid-template-columns: 5px 5px 5px")}"><i style="grid-column: 2 / -1">a</i></div>`);
	await probe("named lines", `<div id=g style="${G("grid-template-columns: [s] 5px [m] 5px [e] 5px")}"><i style="grid-column: m / e">a</i></div>`);
	await probe("span name", `<div id=g style="${G("grid-template-columns: [c] 5px [c] 5px [c] 5px")}"><i style="grid-column: 1 / span 2 c">a</i></div>`);
	await probe("areas", `<div id=g style='${G(`grid-template-areas: "h h" "s m"; grid-template-columns: 6px 6px`)}'><i style="grid-area:m">m</i><i style="grid-area:h">h</i><i style="grid-area:s">s</i></div>`);
	await probe("dense", `<div id=g style="${G("grid-template-columns: repeat(3, 4px); grid-auto-flow: row dense")}"><i style='grid-column: span 2'>a</i><i>b</i><i>c</i></div>`);
	await probe("sparse", `<div id=g style="${G("grid-template-columns: repeat(3, 4px)")}"><i style='grid-column: span 2'>a</i><i>b</i><i>c</i></div>`);
	await probe("flow column", `<div id=g style="${G("grid-template-rows: 1px 1px; grid-auto-flow: column; grid-auto-columns: 4px")}"><i>a</i><i>b</i><i>c</i></div>`);
	await probe("justify-items", `<div id=g style="${G("grid-template-columns: 8px; justify-items: center")}"><i>ab</i></div>`);
	await probe("justify-self end", `<div id=g style="${G("grid-template-columns: 8px")}"><i style="justify-self:end">ab</i></div>`);
	await probe("align-content center", `<div id=g style="${G("grid-template-rows: 1px 1px; height: 6px; align-content: center")}"><i>a</i><i>b</i></div>`);
	await probe("justify-content space-between", `<div id=g style="${G("grid-template-columns: 4px 4px; justify-content: space-between")}"><i>a</i><i>b</i></div>`);
	await probe("gap", `<div id=g style="${G("grid-template-columns: 1fr 1fr; gap: 1px 2px")}"><i>a</i><i>b</i><i>c</i><i>d</i></div>`);
	await probe("implicit rows", `<div id=g style="${G("grid-template-columns: 4px 4px; grid-auto-rows: 2px")}"><i>a</i><i>b</i><i>c</i></div>`);
	await probe("order", `<div id=g style="${G("grid-template-columns: 4px 4px")}"><i style="order:2">a</i><i>b</i></div>`);
	await probe("abspos placed", `<div id=g style="${G("grid-template-columns: 5px 5px 5px; position: relative; height: 3px")}"><i>x</i><i style="position:absolute; grid-column: 2 / 4; grid-row: 1">p</i></div>`);
	await probe("percent track", `<div id=g style="${G("grid-template-columns: 50% 50%; width: 20px")}"><i>a</i><i>b</i></div>`);
	await probe("auto stretch item", `<div id=g style="${G("grid-template-columns: 10px; height: 4px")}"><i style="background:red">a</i></div>`);
	await probe("baseline", `<div id=g style="${G("grid-template-columns: 6px 6px; align-items: baseline")}"><i style="padding-top:2px">a</i><i>b</i></div>`);
	await probe("auto margins", `<div id=g style="${G("grid-template-columns: 9px")}"><i style="margin:auto; width:3px">a</i></div>`);
	await probe("grid shorthand", `<div id=g style="${G("grid: 2px 2px / 4px 4px")}"><i>a</i><i>b</i><i>c</i></div>`);
	await probe("grid auto-flow shorthand", `<div id=g style="${G("grid: auto-flow 2px / 4px 4px")}"><i>a</i><i>b</i><i>c</i></div>`);
	await probe("min-content probe a", `<div id=g style="${G("grid-template-columns: min-content")}"><i>aa bb</i></div>`);
	await probe("min-content probe b", `<div id=g style="${G("grid-template-columns: min-content")}"><i>aaa b</i></div>`);
	await probe("min-content probe c", `<div id=g style="${G("grid-template-columns: min-content min-content")}"><i>aa bb</i><i>x</i></div>`);
	await probe("dense backfill", `<div id=g style="${G("grid-template-columns: repeat(3, 4px)")}"><i style='grid-column: 2 / 4'>a</i><i style='grid-column: span 2'>b</i><i>c</i></div>`);
	await probe("dense backfill dense", `<div id=g style="${G("grid-template-columns: repeat(3, 4px); grid-auto-flow: row dense")}"><i style='grid-column: 2 / 4'>a</i><i style='grid-column: span 2'>b</i><i>c</i></div>`);
	await probe("baseline shim", `<div id=g style="${G("grid-template-columns: 6px 6px; align-items: baseline")}"><i style="padding-top:2px">a</i><i>b<br>c</i></div>`);
	await probe("abspos placed", `<div id=g style="${G("grid-template-columns: 5px 5px 5px; position: relative; height: 3px")}"><i>x</i><i style="position:absolute; grid-column: 2 / 4; grid-row: 1">p</i></div>`);
	await probe("subgrid refused", `<div id=g style="${G("grid-template-columns: subgrid")}"><i>a</i><i>b</i></div>`);
});
