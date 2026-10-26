/**
 * A frame's realm.
 *
 * A browser gives each frame a JavaScript realm of its own: its own
 * Object, Array and Function, and its own copy of every interface, so an
 * array or a node made in a frame is not `instanceof` the parent's, and
 * the parent's is not the frame's. The frame's window is that realm's
 * global object. Where the runtime has node:vm, TermDOM does the same;
 * where it has none, a frame shares its parent's realm, as these tests
 * check too.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {canCreateRealms} from "../src/internal/realms.ts";
import {MockProcess} from "./test-utils.ts";

const realms = canCreateRealms();
const withRealms = realms ? test : test.skip;

function setup(srcdoc = ""): {
	dom: TermDOM;
	top: any;
	frame: any;
	document: any;
	iframe: HTMLIFrameElement;
} {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const iframe = dom.document.createElement("iframe");
	iframe.setAttribute("srcdoc", srcdoc);
	dom.document.body.append(iframe);
	return {
		dom,
		top: dom.window,
		frame: iframe.contentWindow,
		document: iframe.contentDocument,
		iframe,
	};
}

withRealms(
	"a frame's window is its own realm's global, showing its document",
	() => {
		const {dom, top, frame, document} = setup("<p>hi</p>");
		expect(frame).not.toBe(top);
		expect(frame.document).toBe(document);
		expect(document.defaultView).toBe(frame);
		expect(frame.eval("globalThis")).toBe(frame);
		expect(frame.eval("document")).toBe(document);
		dom.dispose();
	},
);

withRealms("a frame has its own intrinsics", () => {
	const {dom, frame} = setup();
	expect(frame.Array).not.toBe(Array);
	expect(frame.Object).not.toBe(Object);
	expect(frame.eval("[]") instanceof Array).toBe(false);
	expect(frame.eval("[]") instanceof frame.Array).toBe(true);
	dom.dispose();
});

withRealms(
	"a frame has its own interface objects and prototypes, with its own members",
	() => {
		const {dom, top, frame} = setup();
		for (const name of [
			"Node",
			"Element",
			"HTMLDivElement",
			"Event",
			"Document",
		]) {
			expect(frame[name]).not.toBe(top[name]);
			expect(frame[name].prototype).not.toBe(top[name].prototype);
		}
		expect(frame.Node.prototype.appendChild)
			.not.toBe(top.Node.prototype.appendChild);
		expect(Object.getPrototypeOf(frame.Node.prototype.appendChild))
			.toBe(frame.Function.prototype);
		expect(Object.getPrototypeOf(frame.EventTarget.prototype))
			.toBe(frame.Object.prototype);
		expect(Object.getPrototypeOf(frame.HTMLDivElement)).toBe(frame.HTMLElement);
		dom.dispose();
	},
);

withRealms(
	"what a frame makes is the frame's, and what the parent makes is the parent's",
	() => {
		const {dom, top, frame, document} = setup("<p id=parsed>hi</p>");
		const parsed = document.getElementById("parsed");
		expect(parsed instanceof frame.HTMLParagraphElement).toBe(true);
		expect(parsed instanceof top.HTMLParagraphElement).toBe(false);
		expect(document instanceof frame.Document).toBe(true);
		expect(document instanceof top.Document).toBe(false);

		// The method a parent finds on the frame's document is the frame's.
		const made = document.createElement("div");
		expect(made instanceof frame.HTMLDivElement).toBe(true);
		expect(made instanceof top.HTMLDivElement).toBe(false);

		const own = dom.document.createElement("div");
		expect(own instanceof top.HTMLDivElement).toBe(true);
		expect(own instanceof frame.HTMLDivElement).toBe(false);

		const event = new frame.Event("x");
		expect(event instanceof frame.Event).toBe(true);
		expect(event instanceof top.Event).toBe(false);
		expect(Object.prototype.toString.call(made)).toBe(
			"[object HTMLDivElement]",
		);
		dom.dispose();
	},
);

withRealms(
	"a bare constructor makes its node in its own realm's document",
	() => {
		const {dom, top, frame, document} = setup();
		expect(new frame.Text("t").ownerDocument).toBe(document);
		expect(new top.Text("t").ownerDocument).toBe(dom.document);
		dom.dispose();
	},
);

withRealms("a node keeps its realm when it moves to another document", () => {
	const {dom, top, frame, document} = setup();
	const div = document.createElement("div");
	div.textContent = "moved";
	dom.document.body.append(div);
	expect(div.ownerDocument).toBe(dom.document);
	expect(div instanceof frame.HTMLDivElement).toBe(true);
	expect(div instanceof top.HTMLDivElement).toBe(false);
	expect(dom.document.body.lastChild).toBe(div);
	expect(top.getComputedStyle(div).display).toBe("block");
	dom.dispose();
});

withRealms(
	"a page's subclass of a frame's interface makes the frame's objects",
	() => {
		const {dom, frame} = setup();
		const Custom = frame.eval(
			"(class Custom extends Event { constructor() { super('custom'); } })",
		);
		const event = new Custom();
		expect(event instanceof Custom).toBe(true);
		expect(event instanceof frame.Event).toBe(true);
		expect(event.type).toBe("custom");
		dom.dispose();
	},
);

withRealms("a frame's timers run in its realm", async () => {
	const {dom, frame} = setup();
	const made = await new Promise<any>((resolve) => {
		frame.setTimeout(() => resolve(new frame.Text("later")), 0);
	});
	expect(made instanceof frame.Text).toBe(true);
	expect(made.ownerDocument).toBe(frame.document);
	dom.dispose();
});

withRealms("a frame's handler attributes stay inert", async () => {
	const {dom, document} = setup(
		"<details open ontoggle=\"globalThis.__frameHandlerRan = true\"></details>",
	);
	const flags = globalThis as {__frameHandlerRan?: boolean};
	flags.__frameHandlerRan = false;
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(flags.__frameHandlerRan).toBe(false);
	expect(document.querySelector("details").ontoggle).toBe(null);
	dom.dispose();
});

(realms ? test.skip : test)(
	"without node:vm, a frame shares its parent's realm",
	() => {
		const {dom, top, document} = setup("<p id=parsed>hi</p>");
		expect(
			document.getElementById("parsed") instanceof top.HTMLParagraphElement,
		)
			.toBe(true);
		dom.dispose();
	},
);

withRealms("a frame's window knows the frames it is in", () => {
	const {dom, top, frame, iframe} = setup();
	expect(frame.parent).toBe(top);
	expect(frame.top).toBe(top);
	expect(frame.frameElement).toBe(iframe);
	expect(top.length).toBe(1);
	expect(top[0]).toBe(frame);
	expect(top.parent).toBe(top);
	expect(top.frameElement).toBe(null);
	iframe.remove();
	expect(top.length).toBe(0);
	expect(top[0]).toBe(undefined);
	expect(frame.parent).toBe(frame);
	dom.dispose();
});

withRealms("a frame of a frame has both above it", () => {
	const {dom, top, frame} = setup();
	const inner = frame.document.createElement("iframe");
	frame.document.body.append(inner);
	expect(inner.contentWindow.parent).toBe(frame);
	expect(inner.contentWindow.top).toBe(top);
	expect(frame[0]).toBe(inner.contentWindow);
	dom.dispose();
});

withRealms(
	"a frame showing srcdoc has the origin of the window it is in",
	() => {
		const dom = new TermDOM({
			transport: new MockProcess().transport,
			url: "https://example.com/inbox",
		});
		const iframe = dom.document.createElement("iframe");
		iframe.setAttribute("srcdoc", "<p>hi</p>");
		dom.document.body.append(iframe);
		expect((iframe.contentWindow as any).origin).toBe("https://example.com");
		dom.dispose();
	},
);

withRealms(
	"a message is cloned into the realm it lands in, from the window that posted it",
	async () => {
		const {dom, top, frame} = setup();
		const heard = new Promise<any>((resolve) => {
			frame.addEventListener("message", resolve, {once: true});
		});
		frame.postMessage({list: [1, 2], when: new Date(0)}, "*");
		const event = await heard;
		expect(event.source).toBe(top);
		expect(event instanceof frame.MessageEvent).toBe(true);
		expect(event.data instanceof frame.Object).toBe(true);
		expect(event.data.list instanceof frame.Array).toBe(true);
		expect(event.data.when instanceof frame.Date).toBe(true);
		expect(event.data.list).toEqual([1, 2]);
		dom.dispose();
	},
);

withRealms(
	"a frame's code posts to its parent as the frame, and hears the reply",
	async () => {
		const {dom, top, frame} = setup();
		const replies: any[] = [];
		top.addEventListener("message", (event: any) => {
			replies.push([event.source === frame, event.data]);
			if (event.data === "ping") {
				event.source.postMessage("pong", "*");
			}
		});
		const heard = new Promise<any>((resolve) => {
			frame.eval(
				"addEventListener('message', (event) => { globalThis.heard = event.data; })",
			);
			frame.eval("setTimeout(() => parent.postMessage('ping', '*'), 0)");
			setTimeout(() => resolve(frame.heard), 50);
		});
		expect(await heard).toBe("pong");
		expect(replies).toEqual([[true, "ping"]]);
		dom.dispose();
	},
);

withRealms("a message for another origin does not land", async () => {
	const {dom, frame} = setup();
	let heard = false;
	frame.addEventListener("message", () => {
		heard = true;
	});
	frame.postMessage("secret", "https://elsewhere.example");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(heard).toBe(false);
	expect(() => frame.postMessage("x", "not a url")).toThrow();
	dom.dispose();
});

withRealms(
	"a frame's fetch is held to the policy and offered to the fetch listeners",
	async () => {
		const dom = new TermDOM({
			transport: new MockProcess().transport,
			csp: "connect-src https://allowed.example",
		});
		const seen: string[] = [];
		dom.addEventListener("fetch", (event) => {
			seen.push(event.request.url);
			event.respondWith(new Response("answered"));
		});
		const iframe = dom.document.createElement("iframe");
		dom.document.body.append(iframe);
		const frame = iframe.contentWindow as any;
		const response = await frame.fetch("https://allowed.example/data");
		expect(await response.text()).toBe("answered");
		await expect(frame.fetch("https://blocked.example/data")).rejects.toThrow();
		expect(seen).toEqual(["https://allowed.example/data"]);
		dom.dispose();
	},
);
