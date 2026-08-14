import {test} from "@b9g/libuild/test";
import {appendFileSync} from "fs";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
const OUT =
	"/private/tmp/claude-501/-Users-brian-Projects-termdom/3e3c4ad6-acd5-4fcd-8993-5e62e9f8bd57/scratchpad/work/out.txt";
const log = (...a: unknown[]) =>
	appendFileSync(OUT, a.map(String).join(" ") + "\n");
test("probe", async () => {
	appendFileSync(OUT, "\n--- probe3 ---\n");
	const t = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: t.transport});
	dom.document.body.innerHTML = `<div id=g style="display:grid;grid-template-columns:repeat(3,8px);grid-auto-rows:1px"><i>a</i><i>b</i><i>c</i><i>d</i></div>`;
	await nextFrame(dom);
	const item = dom.document.querySelectorAll("i")[0] as HTMLElement;
	item.style.gridColumn = "2 / 4";
	item.style.gridRow = "2";
	await nextFrame(dom);
	log("attr:", item.getAttribute("style"));
	log("cssText:", item.style.cssText);
	log("innerHTML:", dom.document.body.innerHTML);
	log("screen:", JSON.stringify(t.getVisibleText().split("\n").slice(0, 3)));
});
