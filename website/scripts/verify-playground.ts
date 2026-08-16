/**
 * Load the built site in a real browser and check that the sandboxed
 * ES-module runner actually runs the examples: the playground page's
 * default program paints, switching programs paints the next one, and the
 * homepage embeds hydrate and paint. Console errors fail the run.
 *
 *   node scripts/verify-playground.ts [origin]
 */
import {chromium} from "playwright";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8632";
let failures = 0;

function report(ok: boolean, name: string, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
	if (msg.type() === "error") errors.push(msg.text());
});

/** All terminal text on the page, joined. */
const terminalText = () =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll(".xterm"))
			.map((el) => (el as HTMLElement).innerText)
			.join("\n"),
	);

async function waitForText(needle: string, timeout = 15000): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await terminalText()).includes(needle)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// The playground page: the first example runs on load.
await page.goto(`${ORIGIN}/playground/`, {waitUntil: "load"});
report(await waitForText("Hello"), "playground: default example paints");

// Switching examples runs the next program, and nothing of the previous
// one survives the reset -- a dead realm's queued writes must not drain
// onto the next program's screen.
await page.selectOption("select", "flexbox");
report(await waitForText("masthead"), "playground: switching to flexbox runs it");
await new Promise((r) => setTimeout(r, 1000));
report(
	!(await terminalText()).includes("HTML Terminal"),
	"playground: previous program's frame is gone after the switch",
);

// The editor shows the program whole: import, construction, attach.
const editor = await page.evaluate(
	() => (document.querySelector("content-area") as HTMLElement)?.innerText ?? "",
);
report(editor.includes('import {TermDOM} from "@b9g/termdom"'), "editor shows the import");
report(editor.includes("new TermDOM"), "editor shows the construction");
report(editor.includes("term.attach()"), "editor shows the attach");
report(editor.includes("index: number"), "editor shows the types, verbatim");

// The crank examples run through the import map: todomvc renders its
// header, and solitaire -- entered through its own main guard against the
// sandbox's argv -- paints the new-game menu.
await page.selectOption("select", "todomvc");
report(await waitForText("todos"), "playground: todomvc renders through mapped crank");
await page.selectOption("select", "solitaire");
report(await waitForText("one card", 20000), "playground: solitaire boots through its main guard");

// Weather runs with the network allowed: its search prompt paints, and a
// searched city fetches Open-Meteo and charts it (skipped offline -- the
// prompt is the gate this suite owns).
await page.selectOption("select", "weather");
report(await waitForText("city", 15000), "playground: weather paints its search");

// The homepage embeds hydrate as they come near and paint their programs.
// The walk down the page mirrors a reader scrolling: each stop lets the
// intersection observer fire and the programs boot.
await page.goto(`${ORIGIN}/`, {waitUntil: "load"});
for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
	await page.evaluate(
		(f) => window.scrollTo(0, document.body.scrollHeight * f),
		fraction,
	);
	await new Promise((r) => setTimeout(r, 1000));
}
report(await waitForText("Installing"), "home: progress-bar embed paints");
report(await waitForText("workspace/termdom"), "home: tree embed reads the virtual filesystem");
report(await waitForText("New profile"), "home: form embed paints");

// The tree embed answers keys. The click lands on whatever row is under
// it and selects it -- the engine dispatches real clicks -- so g first
// puts the selection at the top, then j moves to examples/ and Enter
// opens it.
const tree = page.locator(".xterm").nth(2);
await tree.click();
await page.keyboard.press("g");
await page.keyboard.press("j");
await page.keyboard.press("Enter");
report(await waitForText("solitaire.ts", 5000), "home: tree embed expands on Enter");

const fatal = errors.filter((e) => !e.includes("favicon"));
report(fatal.length === 0, "no console errors", fatal.slice(0, 3).join(" | "));

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
