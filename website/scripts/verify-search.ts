/**
 * Check that the sidebar search shows the answer to the query the reader
 * typed last. Pagefind is replaced with a stub whose first search takes a
 * second and a half and whose second answers at once, so a result that
 * arrives out of order is the whole point of the run.
 *
 *   bun run scripts/verify-search.ts [origin]
 */
import {chromium} from "playwright";

import {serveSite} from "./serve-site.ts";

const SLOW_TITLE = "STALE RESULT";
const FRESH_TITLE = "FRESH RESULT";

const stub = `
const result = (title) => ({
	results: [
		{
			data: async () => ({
				url: "/guides/getting-started/",
				meta: {title},
				excerpt: title,
			}),
		},
	],
});

export async function search(query) {
	if (query === "slow") {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		return result(${JSON.stringify(SLOW_TITLE)});
	}
	return result(${JSON.stringify(FRESH_TITLE)});
}
`;

const ORIGIN = process.argv[2] ?? (await serveSite());
let failures = 0;

function report(ok: boolean, name: string, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("**/pagefind/pagefind.js", (route) =>
	route.fulfill({contentType: "text/javascript", body: stub}),
);

await page.goto(`${ORIGIN}/guides/getting-started/`, {waitUntil: "load"});
await page.waitForSelector("#search-root input");

const resultsText = () =>
	page.evaluate(
		() =>
			Array.from(document.querySelectorAll("#search-root a"))
				.map((el) => el.textContent ?? "")
				.join("\n"),
	);

await page.fill("#search-root input", "slow");
await page.waitForTimeout(400);
await page.fill("#search-root input", "quick");
await page.waitForFunction(
	(title) => (document.querySelector("#search-root")?.textContent ?? "").includes(title),
	FRESH_TITLE,
	{timeout: 10000},
);
report(true, "search shows the newest query's results");

// The slow query answers here. Its results belong to a query nobody is
// looking at any more.
await page.waitForTimeout(2000);
const settled = await resultsText();
report(
	settled.includes(FRESH_TITLE) && !settled.includes(SLOW_TITLE),
	"a slow earlier query does not overwrite them",
	settled.replace(/\s+/g, " ").trim(),
);

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
