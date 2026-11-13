import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

const OPEN = (id: number, url: string) => `\x1b]8;id=${id};${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

function makeApp(
	html: string,
	cols = 40,
): {terminal: MockProcess; written: () => string; dom: TermDOM} {
	const terminal = new MockProcess({cols, rows: 6});
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	return {terminal, written, dom};
}

test("a link's text is wrapped in an OSC 8 hyperlink", async () => {
	const {written, dom} =
		makeApp("see <a href=\"https://example.com/docs\">the docs</a> now");
	await nextFrame(dom);
	const output = written();
	expect(output).toContain(OPEN(1, "https://example.com/docs"));
	const open = output.indexOf(OPEN(1, "https://example.com/docs"));
	const close = output.indexOf(CLOSE, open);
	expect(close).toBeGreaterThan(open);
	expect(output.slice(open, close)).toContain("the docs");
	expect(output.slice(open, close)).not.toContain("now");
	dom.dispose();
});

test("a link wrapped across lines keeps one id", async () => {
	const {written, dom} = makeApp(
		"<a href=\"https://example.com/\">one two three four five six</a>",
		12,
	);
	await nextFrame(dom);
	const output = written();
	const opens = output.match(/\x1b\]8;id=(\d+);/g) ?? [];
	expect(opens.length).toBeGreaterThanOrEqual(2);
	expect(new Set(opens).size).toBe(1);
	dom.dispose();
});

test("a placeholder anchor, a fragment and a relative URL link nothing", async () => {
	const {written, dom} = makeApp(
		"<a>plain</a> <a href=\"#top\">frag</a> <a href=\"page.html\">rel</a>",
	);
	await nextFrame(dom);
	expect(written()).not.toContain("\x1b]8;");
	dom.dispose();
});

test("a relative URL resolves against the document URL", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({
		transport: terminal.transport,
		url: "https://example.com/a/b.html",
	});
	dom.document.body.innerHTML = "<a href=\"../c.html\">c</a>";
	await nextFrame(dom);
	expect(written()).toContain(OPEN(1, "https://example.com/c.html"));
	dom.dispose();
});

test("changing only the href repaints the link", async () => {
	const {written, dom} = makeApp("<a href=\"https://example.com/1\">x</a>");
	await nextFrame(dom);
	const start = written().length;
	dom.document.querySelector("a")!.setAttribute(
		"href",
		"https://example.com/2",
	);
	await nextFrame(dom);
	expect(written().slice(start)).toContain(OPEN(2, "https://example.com/2"));
	dom.dispose();
});

test("the document printed on exit keeps its links", async () => {
	const {written, dom} =
		makeApp("<div>a</div><div><a href=\"https://example.com/\">link</a></div>");
	await nextFrame(dom);
	const start = written().length;
	await dom.dispose();
	const printed = written().slice(start);
	expect(printed).toContain(OPEN(1, "https://example.com/"));
	expect(printed).toContain(CLOSE);
});
