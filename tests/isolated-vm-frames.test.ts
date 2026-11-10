/**
 * Frames in isolated-vm's isolates, end to end: the page loads the
 * frame's document, the frame lays it out, runs its scripts and paints it
 * in an isolate of its own, and the page draws it, hands it keys and
 * trades messages with it. A frame that runs forever is stopped alone.
 * isolated-vm loads on Node only.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {createIsolatedVMFrames} from "../src/internal/isolatedvm.ts";
import {inputDispatched, MockProcess, nextFrame, until} from "./test-utils.ts";

const onNode =
	(globalThis as {Bun?: unknown}).Bun === undefined &&
	(globalThis as {Deno?: unknown}).Deno === undefined;
const nodeTest = onNode ? test : test.skip;

function rows(terminal: MockProcess, count: number): string[] {
	const buffer = (terminal as any).terminal.buffer.active;
	return Array.from(
		{length: count},
		(_, row) => buffer.getLine(row).translateToString(true).trimEnd(),
	);
}

function servePages(dom: TermDOM, pages: Record<string, string>): void {
	dom.addEventListener("fetch", (event: any) => {
		const page = pages[event.request.url];
		if (page !== undefined) {
			event.respondWith(
				new Response(page, {headers: {"content-type": "text/html"}}),
			);
		}
	});
}

async function drawn(
	dom: TermDOM,
	terminal: MockProcess,
	text: string,
): Promise<string[]> {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		await nextFrame(dom);
		if (rows(terminal, 12).some((row) => row.includes(text))) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return rows(terminal, 12);
}

const FRAME = "display: block; border: 1px solid; width: 30ch; height: 5px";

nodeTest(
	"a frame's document is laid out and painted in its own isolate",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({
			transport: terminal.transport,
			colorDepth: "rgb",
			isolatedFrames: "auto",
		});
		servePages(dom, {
			"https://frame.example/": "<p style='margin: 0'>from the isolate</p>",
		});
		dom.document.body.innerHTML =
			`<p>page</p><iframe src="https://frame.example/" style="${FRAME}"></iframe>`;
		const screen = await drawn(dom, terminal, "from the isolate");
		expect(screen.slice(0, 3)).toEqual([
			"page",
			"┌────────────────────────────┐",
			"│from the isolate            │",
		]);
		await dom.dispose();
	},
	60000,
);

nodeTest(
	"a frame's scripts run there, and it trades messages with the page",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({
			transport: terminal.transport,
			url: "https://page.example/",
			scripting: "enabled",
			isolatedFrames: "auto",
		});
		servePages(dom, {
			"https://frame.example/":
				"<p id=out style='margin: 0'>waiting</p><script>" +
				"addEventListener('message', (event) => {" +
				"document.getElementById('out').textContent = event.data + ' from ' + event.origin;" +
				"parent.postMessage('got ' + event.data, '*');" +
				"});" +
				"parent.postMessage('ready', 'https://page.example');" +
				"</script>",
		});
		const received: string[] = [];
		dom.window.addEventListener("message", (event: MessageEvent) => {
			received.push(event.data);
		});
		dom.document.body.innerHTML =
			`<iframe src="https://frame.example/" style="${FRAME}"></iframe>`;
		const frame = dom.document.querySelector("iframe")!;
		await dom.attach();
		await until(() => received.includes("ready"));
		expect(received).toEqual(["ready"]);
		frame.contentWindow!.postMessage("ping", "https://frame.example");
		await until(() => received.includes("got ping"));
		const screen = await drawn(dom, terminal, "ping from");
		expect(screen.slice(1, 3)).toEqual([
			"│ping from https://          │",
			"│page.example                │",
		]);
		await dom.dispose();
	},
	60000,
);

nodeTest(
	"keys typed into a focused frame reach its field",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({
			transport: terminal.transport,
			isolatedFrames: "auto",
		});
		servePages(dom, {
			"https://frame.example/":
				"<input autofocus style='border: 0; margin: 0; padding: 0'>",
		});
		dom.document.body.innerHTML =
			`<iframe src="https://frame.example/" style="${FRAME}"></iframe>`;
		await dom.attach();
		await drawn(dom, terminal, "┌");
		dom.document.querySelector("iframe")!.focus();
		await nextFrame(dom);
		terminal.stdin.simulateResponse("typed");
		await inputDispatched();
		const screen = await drawn(dom, terminal, "typed");
		expect(screen[1]).toMatch(/^│typed/);
		await dom.dispose();
	},
	60000,
);

nodeTest(
	"a frame that runs forever is stopped, and the page goes on",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 12});
		const dom = new TermDOM({
			transport: terminal.transport,
			scripting: "enabled",
			isolatedFrames: await createIsolatedVMFrames({taskTimeout: 200}),
		});
		servePages(dom, {
			"https://spin.example/": "<p>spin</p><script>for (;;) {}</script>",
			"https://calm.example/": "<p style='margin: 0'>calm</p>",
		});
		dom.document.body.innerHTML =
			`<iframe src="https://spin.example/" style="${FRAME}"></iframe>` +
			`<iframe src="https://calm.example/" style="${FRAME}"></iframe>`;
		const screen = await drawn(dom, terminal, "calm");
		expect(screen).toContain("│calm                        │");
		dom.document.body.append("after");
		const later = await drawn(dom, terminal, "after");
		expect(later.some((row) => row.includes("after"))).toBe(true);
		await dom.dispose();
	},
	60000,
);
