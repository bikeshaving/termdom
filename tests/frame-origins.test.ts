/**
 * Frames and their origins.
 *
 * A frame showing srcdoc or about:blank has the origin of the document
 * that made it. A sandbox without allow-same-origin gives the frame an
 * opaque origin of its own, and windows of two origins hold each other
 * by HTML's cross-origin WindowProxy, which lets through only what HTML
 * lists. postMessage carries messages between them, and a frame may send
 * its parent to another page through the parent's location.
 */
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {getDrawnFrameDocument} from "../src/internal/dom.ts";
import {MockProcess, until} from "./test-utils.ts";

function created(): TermDOM {
	return new TermDOM({
		transport: new MockProcess().transport,
		url: "https://example.com/inbox",
	});
}

function addFrame(
	dom: TermDOM,
	attributes: Record<string, string> = {},
): HTMLIFrameElement {
	const iframe = dom.document.createElement("iframe");
	iframe.setAttribute("srcdoc", "<p>hi</p>");
	for (const [name, value] of Object.entries(attributes)) {
		iframe.setAttribute(name, value);
	}
	dom.document.body.append(iframe);
	return iframe;
}

// The frame's own window, as its own code holds it, which a frame of
// another origin does not hand to its parent.
function inside(iframe: HTMLIFrameElement): any {
	void iframe.contentWindow;
	return (getDrawnFrameDocument(iframe as any) as any).defaultView;
}

function errorName(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return (error as Error).name;
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a srcdoc frame and an about:blank one have their parent's origin", () => {
	const dom = created();
	const srcdoc = addFrame(dom);
	const blank = dom.document.createElement("iframe");
	dom.document.body.append(blank);
	for (const iframe of [srcdoc, blank]) {
		const frame = iframe.contentWindow as any;
		expect(frame.origin).toBe("https://example.com");
		expect(iframe.contentDocument).not.toBe(null);
		expect(frame.document).toBe(iframe.contentDocument);
		expect(frame.parent).toBe(dom.window);
		expect(frame.frameElement).toBe(iframe);
	}
	dom.dispose();
});

test("a sandbox with allow-same-origin keeps the parent's origin", () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-same-origin allow-scripts"});
	const frame = iframe.contentWindow as any;
	expect(frame.origin).toBe("https://example.com");
	expect(iframe.contentDocument).not.toBe(null);
	expect(frame.getSelection()).not.toBe(null);
	expect(inside(iframe).parent).toBe(dom.window);
	dom.dispose();
});

test("a sandboxed frame has an opaque origin and no document to its parent", () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-scripts", name: "box"});
	const frame = iframe.contentWindow as any;
	expect(iframe.contentDocument).toBe(null);
	expect(iframe.getSVGDocument()).toBe(null);
	expect(inside(iframe).origin).toBe("null");
	expect(frame).toBe(iframe.contentWindow);
	expect(frame).not.toBe(inside(iframe));
	expect((dom.window as any)[0]).toBe(frame);
	expect(dom.window.frames[0]).toBe(frame);
	expect((dom.window as any).box).toBe(frame);
	dom.dispose();
});

test("a cross-origin window lets through only what HTML lists", () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: ""});
	const frame = iframe.contentWindow as any;
	expect(frame.window).toBe(frame);
	expect(frame.self).toBe(frame);
	expect(frame.frames).toBe(frame);
	expect(frame.parent).toBe(dom.window);
	expect(frame.top).toBe(dom.window);
	expect(frame.opener).toBe(null);
	expect(frame.closed).toBe(false);
	expect(frame.length).toBe(0);
	expect(typeof frame.postMessage).toBe("function");
	expect(frame.postMessage).toBe(frame.postMessage);
	expect(frame.location).toBe(frame.location);
	expect(frame.then).toBe(undefined);
	expect(Object.getPrototypeOf(frame)).toBe(null);
	for (const read of [
		() => frame.document,
		() => frame.getSelection(),
		() => frame.origin,
		() => frame.name,
		() => frame[0],
		() => "document" in frame,
		() => frame.location.href,
		() => frame.location.reload(),
	]) {
		expect(errorName(read)).toBe("SecurityError");
	}
	expect(
		errorName(() => {
			frame.name = "x";
		}),
	).toBe("SecurityError");
	expect(errorName(() => Object.defineProperty(frame, "x", {value: 1})))
		.toBe("SecurityError");
	expect(typeof frame.location.replace).toBe("function");
	dom.dispose();
});

test("a sandboxed frame holds its parent as a window of another origin", () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-scripts"});
	const frame = inside(iframe);
	expect(frame.parent).not.toBe(dom.window);
	expect(frame.parent).toBe(frame.parent);
	expect(frame.top).toBe(frame.parent);
	expect(frame.frameElement).toBe(null);
	expect(errorName(() => frame.parent.document)).toBe("SecurityError");
	expect(frame.parent.frames[0]).toBe(frame);
	dom.dispose();
});

test("a frame of a sandboxed frame is sandboxed too", () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-scripts"});
	const frame = inside(iframe);
	const inner = frame.document.createElement("iframe");
	inner.setAttribute("sandbox", "allow-same-origin");
	frame.document.body.append(inner);
	expect(inner.contentDocument).toBe(null);
	expect(errorName(() => inner.contentWindow.origin)).toBe("SecurityError");
	const plain = frame.document.createElement("iframe");
	frame.document.body.append(plain);
	expect(plain.contentDocument).toBe(null);
	dom.dispose();
});

test("messages cross between a page and its sandboxed frame", async () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-scripts"});
	const outer = iframe.contentWindow as any;
	const frame = inside(iframe);
	const heard: unknown[] = [];
	dom.window.addEventListener("message", (event) => {
		heard.push(["page", event.data, event.origin, event.source === outer]);
		(event.source as any).postMessage("pong", "*");
	});
	frame.addEventListener("message", (event: MessageEvent) => {
		heard.push([
			"frame",
			event.data,
			event.origin,
			event.source === frame.parent,
		]);
	});
	frame.parent.postMessage("ping", "*");
	expect(heard).toEqual([]);
	await until(() => heard.length === 2);
	expect(heard).toEqual([
		["page", "ping", "null", true],
		["frame", "pong", "https://example.com", true],
	]);
	dom.dispose();
});

test("a message lands only at the origin its poster names", async () => {
	const dom = created();
	const iframe = addFrame(dom, {sandbox: "allow-scripts"});
	const frame = inside(iframe);
	const heard: string[] = [];
	frame.addEventListener("message", (event: MessageEvent) => {
		heard.push(`frame ${event.data}`);
	});
	dom.window.addEventListener("message", (event) => {
		heard.push(`page ${event.data}`);
	});
	const outer = iframe.contentWindow as any;
	outer.postMessage("named", "https://example.com");
	outer.postMessage("own", "/");
	outer.postMessage("any", "*");
	frame.parent.postMessage("to the page", "https://example.com");
	frame.parent.postMessage("to another", "https://elsewhere.example");
	frame.parent.postMessage("to its own", "/");
	expect(errorName(() => outer.postMessage("x", "not a url")))
		.toBe("SyntaxError");
	await tick();
	await tick();
	expect(heard.sort()).toEqual(["frame any", "page to the page"]);
	dom.dispose();
});

test("a frame sends its parent to another page through its location", async () => {
	const dom = created();
	const iframe = dom.document.createElement("iframe");
	iframe.setAttribute("src", "/post3.html");
	dom.document.body.append(iframe);
	const frame = iframe.contentWindow as any;
	const destinations: string[] = [];
	dom.window.navigation.addEventListener("navigate", (event) => {
		destinations.push(event.destination.url);
		event.preventDefault();
	});
	frame.addEventListener("message", (event: MessageEvent) => {
		if (event.source === frame.parent) {
			frame.parent.window.location.href = event.data.slice(4);
		}
	});
	frame.postMessage("ddg:https://example.org/result", dom.window.origin);
	await until(() => destinations.length > 0);
	expect(destinations).toEqual(["https://example.org/result"]);
	dom.dispose();
});

test("a navigation of the parent no listener takes still fails", () => {
	const dom = created();
	const frame = addFrame(dom).contentWindow as any;
	expect(
		errorName(() => {
			frame.parent.location.href = "https://example.org/";
		}),
	).toBe("NotSupportedError");
	dom.dispose();
});

test("a sandbox lets a frame navigate its top window only where it says so", () => {
	const dom = created();
	const destinations: string[] = [];
	dom.window.navigation.addEventListener("navigate", (event) => {
		destinations.push(event.destination.url);
		event.preventDefault();
	});
	const barred = inside(addFrame(dom, {sandbox: "allow-scripts"}));
	expect(
		errorName(() => {
			barred.parent.location.href = "https://example.org/barred";
		}),
	).toBe("SecurityError");
	const allowed = inside(addFrame(dom, {sandbox: "allow-top-navigation"}));
	allowed.parent.location.href = "https://example.org/href";
	allowed.parent.location = "https://example.org/location";
	allowed.top.location.replace("https://example.org/replace");
	expect(destinations).toEqual([
		"https://example.org/href",
		"https://example.org/location",
		"https://example.org/replace",
	]);
	dom.dispose();
});

const bun = (globalThis as {Bun?: unknown}).Bun === undefined
	? null
	: process.execPath;

// Where the runtime has no node:vm, as in isolated-vm, a frame's window
// is built in the engine's realm, and is a whole window still.
(bun === null ? test.skip : test)(
	"without node:vm, a frame has a window that posts and navigates",
	async () => {
		const script = fileURLToPath(
			new URL("./frames-without-vm.ts", import.meta.url),
		);
		const output = await new Promise<string>((resolve) => {
			const child = spawn(bun!, [script], {stdio: ["ignore", "pipe", "pipe"]});
			let text = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				text += chunk;
			});
			child.stderr.pipe(process.stderr);
			child.on("close", () => resolve(text));
		});
		expect(JSON.parse(output)).toEqual({
			realms: false,
			postMessage: "function",
			parent: true,
			top: true,
			frameElement: true,
			location: "about:blank",
			origin: "https://duckduckgo.com",
			sandboxedDocument: null,
			heard: ["ddg:https://example.org/result", "https://duckduckgo.com", true],
			navigated: "https://example.org/result",
		});
	},
);
