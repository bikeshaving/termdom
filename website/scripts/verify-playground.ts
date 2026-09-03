/**
 * Load the built site in a real browser and check that the sandboxed
 * ES-module runner actually runs the examples: the playground page's
 * default program paints, switching programs paints the next one, and the
 * homepage embeds hydrate and paint. Console errors fail the run.
 *
 *   node scripts/verify-playground.ts [origin]
 */
import {chromium} from "playwright";
import {createServer} from "node:http";
import {createReadStream, existsSync, statSync} from "node:fs";
import {extname, join, normalize} from "node:path";
import {fileURLToPath} from "node:url";

const MIME: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
};

/**
 * Serve dist/public from this process. An external single-threaded server
 * queues the sandbox's asset requests behind the browser's kept-alive
 * connections and the checks time out on the queue, not the pages.
 */
function serveSite(): Promise<string> {
	const root = fileURLToPath(new URL("../dist/public", import.meta.url));
	const server = createServer((req, res) => {
		const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
		let file = join(root, path);
		if (existsSync(file) && statSync(file).isDirectory()) {
			file = join(file, "index.html");
		}
		if (!file.startsWith(root) || !existsSync(file)) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
		});
		createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as {port: number};
			server.unref();
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

const ORIGIN = process.argv[2] ?? (await serveSite());
let failures = 0;

function report(ok: boolean, name: string, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
}

const browser = await chromium.launch();
let page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
	if (msg.type() === "error") errors.push(msg.text());
});

/** All terminal text on the page, joined. */
// Reads textContent of the row containers: innerText answers for layout,
// and the emulator's renderer keeps glyph text innerText considers hidden.
// The rows render some spaces as no-break spaces, so the text is normalized
// before any needle is looked for.
const terminalText = async () =>
	(
		await page.evaluate(() =>
			Array.from(document.querySelectorAll(".xterm-rows"))
				.map((el) => el.textContent ?? "")
				.join("\n"),
		)
	).replace(/\u00a0/g, " ");

async function waitForText(needle: string, timeout = 30000): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await terminalText()).includes(needle)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// The playground page opens on the gallery: a card per example, the first
// of them running small. Opening a card is the workbench with that program.
await page.goto(`${ORIGIN}/playground/`, {waitUntil: "load"});
await page.waitForSelector("[data-card]");
const cards = await page.evaluate(() => document.querySelectorAll("[data-card]").length);
report(cards >= 20, "gallery: a card per runnable example", `${cards} cards`);
report(await waitForText("Hello"), "gallery: the first card runs its program");
await page.click('[data-card="hello-world"]');
await page.waitForSelector("select");
report(await waitForText("Hello"), "playground: opening a card runs it in the workbench");

// Switching examples runs the next program, and nothing of the previous
// one survives the reset -- a dead realm's queued writes must not drain
// onto the next program's screen.
await page.selectOption("select", "flexbox");
report(await waitForText("TermDOM flexbox"), "playground: switching to flexbox runs it");
await new Promise((r) => setTimeout(r, 1000));
report(
	!(await terminalText()).includes("HTML Terminal"),
	"playground: previous program's frame is gone after the switch",
);

// The editor shows the program whole: import, construction, attach, and
// the TypeScript as written -- bar-chart's casts stand in for types.
await page.selectOption("select", "bar-chart");
report(await waitForText("Requests per region", 15000), "playground: bar-chart runs");
const editor = await page.evaluate(
	() => (document.querySelector("content-area") as HTMLElement)?.innerText ?? "",
);
report(editor.includes('import {TermDOM} from "@b9g/termdom"'), "editor shows the import");
report(editor.includes("new TermDOM"), "editor shows the construction");
report(editor.includes("term.attach()"), "editor shows the attach");
report(editor.includes("as HTMLElement"), "editor shows the types, verbatim");

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

// Hacker News paints its masthead and says it is loading before the API
// answers, so the check holds offline; the stories themselves need the
// network and are not this suite's gate.
await page.selectOption("select", "hacker-news");
report(await waitForText("Hacker News", 15000), "playground: hacker-news paints its masthead");
report(await waitForText("loading the front page", 5000), "playground: hacker-news says it is loading");

// The rest of the roster: chat paints its composer, fuzzy-finder lists and
// previews the virtual files, and markdown renders its sample through
// marked and Prism, both from the CDN.
await page.selectOption("select", "chat");
report(await waitForText("ch.at", 15000), "playground: chat paints");
await page.selectOption("select", "fuzzy-finder");
report(await waitForText("type to filter", 15000), "playground: fuzzy-finder paints");
report(await waitForText("01-getting-started.md", 5000), "playground: fuzzy-finder lists the seeded files");
// The shell reads the filesystem the page seeded: the examples directory
// lists these programs, and cat prints one of them.
// The address follows the picker, and a shared address opens what it
// names: an example by id, or a program encoded into the hash.
report((await page.evaluate(() => location.hash)) === "#e=fuzzy-finder", "share: the hash names the picked example");
await page.goto(`${ORIGIN}/playground/#e=flexbox`);
await page.waitForSelector(".xterm");
report(await waitForText("TermDOM flexbox", 15000), "share: #e= opens the named example");
const sharedProgram = [
	'import {TermDOM} from "@b9g/termdom";',
	"const term = new TermDOM();",
	"term.attach();",
	'term.document.body.textContent = "shared program painted";',
].join("\n");
const encoded = Buffer.from(sharedProgram).toString("base64url");
await page.goto(`${ORIGIN}/playground/#c=r${encoded}`);
await page.reload({waitUntil: "load"});
await page.waitForSelector(".xterm");
report(await waitForText("shared program painted", 15000), "share: #c= runs the encoded program on a fresh load");
await page.goto(`${ORIGIN}/playground/#e=shell`);
await page.waitForSelector("select");
report(await waitForText("termdom shell", 15000), "playground: shell paints its banner");
// The emulator's textarea takes the keys. A click on the pane would also
// be a click in the program, on empty screen, which moves its focus off
// the prompt.
await page.locator(".xterm-helper-textarea").first().focus();
await page.keyboard.type("ls examples");
await page.keyboard.press("Enter");
report(await waitForText("hello-world.ts", 5000), "playground: ls lists the seeded examples");
await page.keyboard.type("cat examples/hello-world.ts");
await page.keyboard.press("Enter");
report(await waitForText("Hello, terminal", 5000), "playground: cat prints a seeded example");
await page.selectOption("select", "markdown");
report(await waitForText("Markdown in the Terminal", 15000), "playground: markdown renders through marked and Prism");

// The fenced code blocks sit below the fold, so the pager pages down to
// them; their token classes must arrive coloured, not as plain text.
await page.locator(".xterm").first().click();
let atCode = false;
for (let i = 0; i < 8 && !atCode; i++) {
	await page.keyboard.press("f");
	atCode = await waitForText("greet", 2000);
}
report(atCode, "playground: markdown pages down to its code block");
const codeColours = await page.evaluate(
	() =>
		new Set(
			Array.from(document.querySelectorAll(".xterm-rows span"))
				.map((el) => (el as HTMLElement).style.color)
				.filter(Boolean),
		).size,
);
report(codeColours >= 5, "playground: markdown's code block keeps its token colours", `${codeColours} colours`);

// Prism highlights the sample, its theme colours the token classes, and a
// number key swaps the language. The colour count is the check that matters:
// a screen of one colour means the theme reached nothing.
await page.selectOption("select", "prism");
report(await waitForText("interface Point", 15000), "playground: prism highlights its TypeScript sample");
const colours = await page.evaluate(
	() =>
		new Set(
			Array.from(document.querySelectorAll(".xterm-rows span"))
				.map((el) => (el as HTMLElement).style.color)
				.filter(Boolean),
		).size,
);
report(colours >= 5, "playground: prism paints the token classes in distinct colours", `${colours} colours`);
await page.locator(".xterm").first().click();
await page.keyboard.press("2");
report(await waitForText(".token.keyword", 5000), "playground: prism switches language on a number key");

// The homepage embeds hydrate as they come near and paint their programs.
// The first one is above the fold, so it is checked where a reader meets
// it -- before any scrolling, which would carry it away faster than the
// observer that mounts it.
// A fresh page, as a first visit is: the playground page above has been
// through a dozen sandbox boots by now.
await page.close();
page = await browser.newPage();
await page.goto(`${ORIGIN}/`, {waitUntil: "load"});
// The emulator renders only terminals inside the viewport, so the check
// scrolls to the embed the way a reader would reach it.
await page.locator("[data-playground]").first().scrollIntoViewIfNeeded();
report(await waitForText("Hello, terminal"), "home: hello-world embed paints");

// The walk down the page mirrors a reader scrolling: each embed comes into
// view in turn, the observer fires, and its program boots. A walk by page
// fractions can jump over an embed without it ever intersecting.
const embeds = page.locator("[data-playground]");
for (let i = 0, n = await embeds.count(); i < n; i++) {
	await embeds.nth(i).scrollIntoViewIfNeeded();
	await new Promise((r) => setTimeout(r, 1000));
}
report(await waitForText("Requests per region"), "home: bar-chart embed paints");
report(await waitForText("TermDOM flexbox"), "home: flexbox embed paints");
report(await waitForText("New profile"), "home: form embed paints");
report(await waitForText("interface Point", 15000), "home: prism embed highlights its sample");

const fatal = errors.filter((e) => !e.includes("favicon"));
report(fatal.length === 0, "no console errors", fatal.slice(0, 3).join(" | "));

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
