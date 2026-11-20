/**
 * Frames whose document is in another isolate.
 *
 * Where frames are isolated, an iframe whose src is an http: or https: URL
 * loads its document under the page's policy and fetch listeners and
 * starts it through the isolator. The page draws the cells the frame
 * sends, checked as untrusted, hands it keys and the mouse while it has
 * them, and reaches it only through postMessage, as a window of another
 * origin. The isolator here stands in for an isolate: it records what
 * the page sends and plays what a frame would send.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {toCellColor} from "../src/internal/cssvalues.ts";
import {CellGrid, exportGrid} from "../src/internal/framebuffer.ts";
import type {
	FrameInit,
	FrameIsolator,
	FrameMessage,
	HostMessage,
} from "../src/internal/isolateprotocol.ts";
import {_} from "../src/internal/slots.ts";
import {
	captureRawOutput,
	inputDispatched,
	MockProcess,
	nextFrame,
	scriptReplies,
	until,
} from "./test-utils.ts";

interface FakeFrame {
	init: FrameInit;
	sent: HostMessage[];
	post(message: FrameMessage): void;
	disposed: boolean;
}

function fakeIsolator(): {
	frames: FakeFrame[];
	isolate: (
		init: FrameInit,
		receive: (message: FrameMessage) => void,
	) => {send(message: HostMessage): void; dispose(): void};
} {
	const frames: FakeFrame[] = [];
	return {
		frames,
		isolate: (init, receive) => {
			const frame: FakeFrame = {init, sent: [], post: receive, disposed: false};
			frames.push(frame);
			return {
				send: (message) => {
					frame.sent.push(message);
				},
				dispose: () => {
					frame.disposed = true;
				},
			};
		},
	};
}

function useIsolator(dom: TermDOM, isolate: FrameIsolator): void {
	(_(dom.document as never) as {extra: {isolateFrame: FrameIsolator}})
		.extra.isolateFrame = isolate;
}

function paintText(lines: string[], cols: number): FrameMessage {
	const grid = new CellGrid(lines.length, cols);
	lines.forEach((line, row) => {
		[...line].forEach((char, col) => grid.setCell(row * cols + col, char));
	});
	return {type: "paint", cells: exportGrid(grid), caret: null};
}

function rows(terminal: MockProcess, count: number): string[] {
	const buffer = (terminal as any).terminal.buffer.active;
	return Array.from(
		{length: count},
		(_, row) => buffer.getLine(row).translateToString(true).trimEnd(),
	);
}

async function settle(dom: TermDOM): Promise<void> {
	await nextFrame(dom);
	await nextFrame(dom);
}

function answerPages(dom: TermDOM, pages: Record<string, string>): string[] {
	const asked: string[] = [];
	dom.addEventListener("fetch", (event: any) => {
		asked.push(event.request.url);
		const page = pages[event.request.url];
		if (page !== undefined) {
			event.respondWith(
				new Response(page, {headers: {"content-type": "text/html"}}),
			);
		}
	});
	return asked;
}

const FRAME_STYLE =
	"display: block; border: 1px solid; width: 14ch; height: 5px";

test("a frame's document loads through the page and starts in the isolator", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({
		transport: terminal.transport,
		url: "https://page.example/",
	});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/a": "<p>framed</p>"});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/a" style="${FRAME_STYLE}"></iframe>`;
	const frame = dom.document.querySelector("iframe")!;
	let loads = 0;
	frame.addEventListener("load", () => loads++);
	await settle(dom);
	await until(() => frames.length === 1);
	expect(frames[0].init).toMatchObject({
		url: "https://frame.example/a",
		html: "<p>framed</p>",
		cols: 12,
		rows: 3,
		scripting: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(loads).toBe(0);
	frames[0].post({type: "load"});
	expect(loads).toBe(1);
	dom.dispose();
});

test("the cells a frame paints are drawn in its box, without control characters", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	frames[0].post(paintText(["inside", "a\x1b[2Jb"], 12));
	await settle(dom);
	expect(rows(terminal, 5)).toEqual([
		"┌────────────┐",
		"│inside      │",
		"│a [2Jb      │",
		"│            │",
		"└────────────┘",
	]);
	dom.dispose();
});

test("a frame's cells claim no columns their text does not take", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	const message = paintText(["abc"], 12) as Extract<
		FrameMessage,
		{type: "paint"}
	>;
	message.cells.attrs[0] |= 0x1f << 9;
	message.cells.cluster[1] = 0x110000;
	message.cells.graphemes.push([0x8000_0001, "\x07"]);
	message.cells.cluster[2] = 0x8000_0001;
	frames[0].post(message);
	await settle(dom);
	expect(rows(terminal, 2)[1]).toBe("│a           │");
	dom.dispose();
});

test("a click focuses the frame, and its keys and mouse go there in its own cells", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await dom.attach();
	await settle(dom);
	await until(() => frames.length === 1);
	const frame = dom.document.querySelector("iframe")!;
	let parentKeys = 0;
	dom.document.addEventListener("keypress", () => parentKeys++);
	// The frame's third column on its second row, inside the border.
	terminal.stdin.simulateResponse("\x1b[<0;4;3M\x1b[<0;4;3m");
	await inputDispatched();
	await settle(dom);
	expect(dom.document.activeElement).toBe(frame);
	terminal.stdin.simulateResponse("x");
	await inputDispatched();
	const items = frames[0].sent
		.filter((message) => message.type === "input")
		.map((message) => message.item);
	expect(items).toContainEqual({
		kind: "mouse",
		button: 0,
		col: 2,
		row: 1,
		release: false,
		ticks: 1,
	});
	expect(items).toContainEqual({kind: "focus", focused: true});
	expect(items).toContainEqual([
		expect.objectContaining({kind: "key", key: "x"}),
	]);
	expect(parentKeys).toBe(0);
	dom.dispose();
});

test("the page and the frame reach each other only through messages", async () => {
	const {frames, isolate} = fakeIsolator();
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 8}).transport,
		url: "https://page.example/",
	});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	const frame = dom.document.querySelector("iframe")!;
	await settle(dom);
	await until(() => frames.length === 1);
	expect(frame.contentDocument).toBe(null);
	expect(() => (frame.contentWindow as any).document).toThrow();
	frame.contentWindow!.postMessage({hello: 1}, "https://frame.example");
	expect(frames[0].sent).toContainEqual({
		type: "message",
		data: {hello: 1},
		origin: "https://page.example",
		targetOrigin: "https://frame.example",
	});
	const received: any[] = [];
	dom.window.addEventListener("message", (event: MessageEvent) => {
		received.push([
			event.data,
			event.origin,
			event.source === frame.contentWindow,
		]);
	});
	frames[0].post({
		type: "message",
		data: "elsewhere",
		targetOrigin: "https://other.example",
	});
	frames[0].post({type: "message", data: "back", targetOrigin: "*"});
	await until(() => received.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(received).toEqual([["back", "https://frame.example", true]]);
	dom.dispose();
});

test("a frame's loads go through the page's fetch listeners, without forbidden headers", async () => {
	const {frames, isolate} = fakeIsolator();
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 8}).transport,
	});
	useIsolator(dom, isolate);
	const headers: Array<[string, string]> = [];
	dom.addEventListener("fetch", (event: any) => {
		if (event.request.url === "https://frame.example/") {
			event.respondWith(new Response(""));
		} else if (event.request.url === "https://frame.example/data.json") {
			event.request.headers.forEach((value: string, name: string) => {
				headers.push([name, value]);
			});
			event.respondWith(new Response("{}", {status: 201}));
		}
	});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	frames[0].post({
		type: "fetch",
		id: 1,
		request: {
			url: "https://frame.example/data.json",
			method: "GET",
			headers: [["x-asked", "yes"], ["cookie", "stolen=1"]],
			body: null,
			redirect: "follow",
			destination: "",
			referrer: "",
		},
	});
	frames[0].post({
		type: "fetch",
		id: 2,
		request: {
			url: "file:///etc/passwd",
			method: "GET",
			headers: [],
			body: null,
			redirect: "follow",
			destination: "",
			referrer: "",
		},
	});
	await until(() => frames[0].sent.length >= 2);
	expect(headers).toEqual([["x-asked", "yes"]]);
	const response = frames[0].sent.find(
		(message) => message.type === "response",
	);
	expect(response).toMatchObject({type: "response", id: 1});
	expect(new TextDecoder().decode((response as any).response.body)).toBe("{}");
	expect((response as any).response.status).toBe(201);
	expect(frames[0].sent).toContainEqual({
		type: "fetchError",
		id: 2,
		message: "Failed to fetch",
	});
	dom.dispose();
});

test("a frame-src policy keeps a frame's document from loading", async () => {
	const {frames, isolate} = fakeIsolator();
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 8}).transport,
		csp: "frame-src https://allowed.example",
	});
	useIsolator(dom, isolate);
	const asked = answerPages(dom, {
		"https://allowed.example/": "<p>allowed</p>",
		"https://blocked.example/": "<p>blocked</p>",
	});
	dom.document.body.innerHTML =
		`<iframe src="https://allowed.example/"></iframe><iframe src="https://blocked.example/"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 2);
	expect(asked).toEqual(["https://allowed.example/"]);
	expect(
		frames
			.map((frame) => [frame.init.url, frame.init.html.includes("<p>")])
			.sort(),
	).toEqual([
		["https://allowed.example/", true],
		["https://blocked.example/", false],
	]);
	dom.dispose();
});

test("a srcdoc frame stays in the page's heap, and a removed frame's isolate goes", async () => {
	const {frames, isolate} = fakeIsolator();
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 8}).transport,
	});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe srcdoc="<p id=here>here</p>"></iframe><iframe src="https://frame.example/"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	const [local, isolated] = dom.document.querySelectorAll("iframe");
	expect(local.contentDocument!.getElementById("here")).not.toBe(null);
	isolated.remove();
	expect(frames[0].disposed).toBe(true);
	dom.dispose();
});

// A frame's red image, 2 by 1 cells, of 16 by 16 pixels, and the cells
// that show it under id 7 at the frame's top left.
function postRedImage(frame: FakeFrame, cols: number): void {
	const pixels = new Uint8ClampedArray(16 * 16 * 4);
	for (let index = 0; index < pixels.length; index += 4) {
		pixels.set([255, 0, 0, 255], index);
	}
	frame.post({
		type: "images",
		added: [{id: 7, width: 16, height: 16, cols: 2, rows: 1, pixels}],
		dropped: [],
	});
	const grid = new CellGrid(1, cols);
	grid.setPlaceholder(0, 0, 0, {fg: toCellColor(7)});
	grid.setPlaceholder(1, 0, 1, {fg: toCellColor(7)});
	grid.setPlaceholder(2, 0, 0, {fg: toCellColor(8)});
	frame.post({type: "paint", cells: exportGrid(grid), caret: null});
}

test("a frame's images are drawn in half blocks where the terminal has no graphics", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({
		transport: terminal.transport,
		colorDepth: "rgb",
		images: "cells",
	});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	expect(frames[0].init.images).toBe("kitty");
	postRedImage(frames[0], 12);
	await settle(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	const line = buffer.getLine(1);
	const backgrounds = [1, 2, 3].map((col) => {
		const cell = line.getCell(col);
		return cell.isBgRGB() ? cell.getBgColor() : null;
	});
	expect(backgrounds).toEqual([0xff0000, 0xff0000, null]);
	dom.dispose();
});

test("a frame's images are sent in the kitty protocol where the terminal draws it", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 6});
	scriptReplies(terminal, [{ask: "\x1b[16t", reply: "\x1b[6;16;8t"}]);
	const output = captureRawOutput(terminal);
	const dom = new TermDOM({
		transport: terminal.transport,
		colorDepth: "rgb",
		images: "kitty",
	});
	useIsolator(dom, isolate);
	answerPages(dom, {"https://frame.example/": ""});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	postRedImage(frames[0], 12);
	await settle(dom);
	const uploads = output().match(/\x1b_G[^;\x1b]*/g) ?? [];
	expect(uploads.length).toBe(1);
	expect(uploads[0]).toContain("c=2,r=1");
	dom.dispose();
});

test("a frame goes to the document its own navigation names", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	useIsolator(dom, isolate);
	const asked = answerPages(dom, {
		"https://frame.example/": "",
		"https://frame.example/b/next": "<p>next</p>",
	});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	frames[0].post({type: "navigate", target: "self", url: "file:///etc/passwd"});
	frames[0].post({
		type: "history",
		url: "https://bank.example/",
		replace: false,
	});
	frames[0].post({type: "history", url: "/b/here", replace: false});
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(frames[0].disposed).toBe(false);
	frames[0].post({type: "navigate", target: "self", url: "next"});
	await until(() => frames.length === 2);
	expect(frames[0].disposed).toBe(true);
	expect(frames[1].init.html).toBe("<p>next</p>");
	expect(asked).toEqual([
		"https://frame.example/",
		"https://frame.example/b/next",
	]);
	dom.dispose();
});

test("a form a frame posts loads its next document with a POST", async () => {
	const {frames, isolate} = fakeIsolator();
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	useIsolator(dom, isolate);
	const posted: Array<{method: string; type: string | null; body: string}> = [];
	dom.addEventListener("fetch", (event: any) => {
		const request: Request = event.request;
		if (request.method === "POST") {
			event.respondWith(
				request.text().then((body) => {
					posted.push({
						method: request.method,
						type: request.headers.get("content-type"),
						body,
					});
					return new Response("<p>thanks</p>");
				}),
			);
		} else {
			event.respondWith(new Response(""));
		}
	});
	dom.document.body.innerHTML =
		`<iframe src="https://frame.example/" style="${FRAME_STYLE}"></iframe>`;
	await settle(dom);
	await until(() => frames.length === 1);
	frames[0].post({
		type: "navigate",
		target: "self",
		url: "https://frame.example/send",
		method: "post",
		body: new TextEncoder().encode("q=tea"),
		contentType: "application/x-www-form-urlencoded\r\nx-evil: 1",
	});
	await until(() => frames.length === 2);
	expect(posted).toEqual([
		{
			method: "POST",
			type: "application/x-www-form-urlencodedx-evil: 1",
			body: "q=tea",
		},
	]);
	expect(frames[1].init.html).toBe("<p>thanks</p>");
	dom.dispose();
});
