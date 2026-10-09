/**
 * What a document's markup loads is first checked against its Content
 * Security Policy. What the policy allows goes to the TermDOM as a
 * "fetch" event, as a Service Worker hears it, and to the network when no
 * listener answers. A redirect is checked against the policy again and
 * followed on the network.
 */
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

import {expect, test} from "@b9g/libuild/test";

import {ExtendableEvent, FetchEvent, TermDOM} from "../src/index.ts";
import {encodePNG} from "../src/internal/images.ts";
import {MockProcess, until} from "./test-utils.ts";

const PNG = encodePNG({
	width: 2,
	height: 2,
	data: new Uint8ClampedArray(16).fill(255),
}) as Uint8Array<ArrayBuffer>;

function create(
	options: {html?: string; url?: string; csp?: string} = {},
): TermDOM {
	return new TermDOM({
		transport: new MockProcess({cols: 40, rows: 12}).transport,
		...options,
	});
}

async function settled(image: HTMLImageElement): Promise<string> {
	await until(() => image.complete);
	return image.naturalWidth > 0 ? "loaded" : "broken";
}

interface Server {
	origin: string;
	port: number;
	// Each request the server heard, as "METHOD /path".
	heard: string[];
	close(): Promise<void>;
}

// A server that answers /redirect?to=URL with a 302 to it, /hop/N with a
// 302 to /hop/N-1 until /hop/0, and any other path with the PNG.
async function serve(): Promise<Server> {
	const heard: string[] = [];
	const server = createServer((request, response) => {
		heard.push(`${request.method} ${request.url}`);
		const url = new URL(request.url!, "http://localhost");
		if (url.pathname === "/redirect") {
			response.writeHead(302, {location: url.searchParams.get("to")!});
			response.end();
			return;
		}
		const hop = /^\/hop\/(\d+)$/.exec(url.pathname);
		if (hop !== null && hop[1] !== "0") {
			response.writeHead(302, {location: `/hop/${Number(hop[1]) - 1}`});
			response.end();
			return;
		}
		response.writeHead(200, {"content-type": "image/png"});
		response.end(PNG);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const {port} = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		port,
		heard,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		}),
	};
}

test("a policy that allows nothing blocks markup, and the block is reported", async () => {
	const dom = create({csp: "default-src 'none'"});
	let heard = 0;
	dom.addEventListener("fetch", () => {
		heard++;
	});
	const violations: Array<Partial<SecurityPolicyViolationEvent>> = [];
	dom.document.addEventListener("securitypolicyviolation", (event) => {
		violations.push(event as SecurityPolicyViolationEvent);
	});
	dom.document.body.innerHTML =
		"<img src=\"https://example.com/a.png#top\" alt=\"logo\">" +
		"<img src=\"data:image/png;base64,AAAA\">";
	const images = [...dom.document.querySelectorAll("img")];
	expect(await Promise.all(images.map(settled))).toEqual(["broken", "broken"]);
	expect(heard).toBe(0);
	expect(violations).toHaveLength(2);
	const [violation] = violations;
	expect(violation.target).toBe(images[0]);
	// A report carries no fragment, and only the scheme of a URL that is
	// not HTTP(S).
	expect([
		violation.blockedURI,
		violations[1].blockedURI,
		violation.effectiveDirective,
		violation.originalPolicy,
		violation.disposition,
		violation.isTrusted,
	]).toEqual([
		"https://example.com/a.png",
		"data",
		"default-src",
		"default-src 'none'",
		"enforce",
		true,
	]);
	dom.dispose();
});

test("a listener answers what the policy allows, as a Service Worker does", async () => {
	const dom = create({csp: "img-src cid:"});
	const seen: FetchEvent[] = [];
	dom.addEventListener("fetch", (event) => {
		seen.push(event);
		event.respondWith(new Response(PNG));
	});
	dom.document.body.innerHTML =
		"<img id=a src=\"cid:logo@example.com\"><img id=b src=\"https://example.com/b.png\">";
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["loaded", "broken"]);
	expect(seen).toHaveLength(1);
	const [event] = seen;
	expect(event).toBeInstanceOf(FetchEvent);
	expect(event).toBeInstanceOf(ExtendableEvent);
	expect([
		event.type,
		event.cancelable,
		event.request.url,
		event.request.destination,
		event.clientId,
		event.resultingClientId,
		event.replacesClientId,
	]).toEqual(["fetch", true, "cid:logo@example.com", "image", "", "", ""]);
	expect(event.request.headers.get("accept")).toContain("image/png");
	expect(await event.preloadResponse).toBeUndefined();
	expect(await event.handled).toBeUndefined();
	dom.dispose();
});

test("an allowed request no listener answers goes to the network", async () => {
	const server = await serve();
	const dom = create({csp: `img-src ${server.origin}`});
	let heard = 0;
	dom.addEventListener("fetch", () => {
		heard++;
	});
	dom.document.body.innerHTML = `<img src="${server.origin}/a.png">`;
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	expect(heard).toBe(1);
	expect(server.heard).toEqual(["GET /a.png"]);
	dom.dispose();
	await server.close();

	const data = create({csp: "img-src data:"});
	data.document.body.innerHTML =
		`<img src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}">`;
	expect(await settled(data.document.querySelector("img")!)).toBe("loaded");
	data.dispose();
});

test("a redirect is checked against the policy again, and reported as the URL asked for", async () => {
	const server = await serve();
	const elsewhere = `http://localhost:${server.port}/tracker.png`;
	const dom = create({csp: `img-src ${server.origin}`});
	const violations: SecurityPolicyViolationEvent[] = [];
	dom.document.addEventListener("securitypolicyviolation", (event) => {
		violations.push(event as SecurityPolicyViolationEvent);
	});
	const away = `${server.origin}/redirect?to=${encodeURIComponent(elsewhere)}`;
	const home = `${server.origin}/redirect?to=%2Fhome.png`;
	dom.document.body.innerHTML = `<img id=a src="${away}"><img id=b src="${home}">`;
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["broken", "loaded"]);
	expect(server.heard).not.toContain("GET /tracker.png");
	expect(server.heard).toContain("GET /home.png");
	expect(violations.map((violation) => violation.blockedURI)).toEqual([away]);
	dom.dispose();
	await server.close();
});

test("a redirect goes only to another HTTP(S) URL", async () => {
	const server = await serve();
	const folder = mkdtempSync(join(tmpdir(), "termdom-redirect-"));
	try {
		writeFileSync(join(folder, "secret.png"), PNG);
		const file = pathToFileURL(join(folder, "secret.png")).href;
		const data = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
		const dom = create({
			url: pathToFileURL(`${folder}/`).href,
			csp: `img-src file: data: cid: ${server.origin}`,
		});
		// The file loads when the page asks for it, through the listener,
		// which a redirect never reaches.
		const answered: string[] = [];
		dom.addEventListener("fetch", (event) => {
			if (event.request.url.startsWith("file:")) {
				answered.push(event.request.url);
				event.respondWith(new Response(PNG));
			}
		});
		const to = (target: string) =>
			`${server.origin}/redirect?to=${encodeURIComponent(target)}`;
		dom.document.body.innerHTML =
			`<img src="${to(file)}"><img src="${to(data)}"><img src="${to("cid:a")}">` +
			`<img src="${file}">`;
		const images = [...dom.document.querySelectorAll("img")];
		expect(await Promise.all(images.map(settled)))
			.toEqual(["broken", "broken", "broken", "loaded"]);
		expect(answered).toEqual([file]);
		dom.dispose();
	} finally {
		await server.close();
		rmSync(folder, {recursive: true});
	}
});

test("twenty redirects are followed, and a twenty-first fails", async () => {
	const server = await serve();
	const dom = create({csp: `img-src ${server.origin}`});
	dom.document.body.innerHTML =
		`<img id=a src="${server.origin}/hop/20"><img id=b src="${server.origin}/hop/21">`;
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["loaded", "broken"]);
	dom.dispose();
	await server.close();
});

test("a listener that passes the load on is checked where the load ended up", async () => {
	const server = await serve();
	const elsewhere = `http://localhost:${server.port}/secret.png`;
	const dom = create({csp: `img-src ${server.origin}`});
	dom.addEventListener("fetch", (event) => {
		event.respondWith(fetch(event.request));
	});
	const violations: SecurityPolicyViolationEvent[] = [];
	dom.document.addEventListener("securitypolicyviolation", (event) => {
		violations.push(event as SecurityPolicyViolationEvent);
	});
	const away = `${server.origin}/redirect?to=${encodeURIComponent(elsewhere)}`;
	dom.document.body.innerHTML =
		`<img id=a src="${away}"><img id=b src="${server.origin}/b.png">`;
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["broken", "loaded"]);
	expect(violations.map((violation) => violation.blockedURI)).toEqual([away]);
	dom.dispose();
	await server.close();
});

test("an answer still pending ends when the source changes or the TermDOM is disposed", async () => {
	const dom = create({csp: "img-src https:"});
	const handled: Array<Promise<undefined>> = [];
	dom.addEventListener("fetch", (event) => {
		handled.push(event.handled);
		event.respondWith(new Promise<Response>(() => {}));
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	const image = dom.document.querySelector("img")!;
	await until(() => handled.length === 1);
	image.src = "https://example.com/b.png";
	await until(() => handled.length === 2);
	const first = await handled[0].then(() => "resolved", (error: DOMException) =>
		error.name);
	expect(first).toBe("NetworkError");
	void dom.dispose();
	expect(await settled(image)).toBe("broken");
	const second = await handled[1].then(
		() => "resolved",
		(error: DOMException) =>
			error.name,
	);
	expect(second).toBe("NetworkError");
});

test("a listener's redirect is followed on the network, and checked", async () => {
	const server = await serve();
	const dom = create({csp: `img-src cid: ${server.origin}`});
	let heard = 0;
	dom.addEventListener("fetch", (event) => {
		heard++;
		const to = event.request.url === "cid:a"
			? `${server.origin}/a.png`
			: "https://elsewhere.example/b.png";
		event.respondWith(Response.redirect(to, 302));
	});
	dom.document.body.innerHTML = "<img id=a src=\"cid:a\"><img id=b src=\"cid:b\">";
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["loaded", "broken"]);
	// The redirect goes to the network, not back to the listener.
	expect(heard).toBe(2);
	expect(server.heard).toEqual(["GET /a.png"]);
	dom.dispose();
	await server.close();
});

test("a page's own meta policy narrows the program's, and never widens it", async () => {
	const dom = create({csp: "img-src https:"});
	dom.addEventListener("fetch", (event) => {
		event.respondWith(new Response(PNG));
	});
	dom.document.head.innerHTML =
		"<meta http-equiv=\"Content-Security-Policy\" content=\"img-src https://cdn.example data:\">";
	dom.document.body.innerHTML =
		"<img id=a src=\"https://cdn.example/a.png\">" +
		"<img id=b src=\"https://other.example/b.png\">" +
		"<img id=c src=\"data:image/png;base64,AAAA\">";
	const images = ["a", "b", "c"].map((id) =>
		dom.document.getElementById(id) as HTMLImageElement);
	expect(await Promise.all(images.map(settled)))
		.toEqual(["loaded", "broken", "broken"]);
	dom.dispose();
});

test("a meta policy holds from its insertion into the head, whatever becomes of the element", async () => {
	const dom = create({csp: "img-src https:"});
	dom.addEventListener("fetch", (event) => {
		event.respondWith(new Response(PNG));
	});
	const load = async (src: string): Promise<string> => {
		const image = dom.document.createElement("img");
		image.src = src;
		dom.document.body.append(image);
		return settled(image);
	};
	const meta = dom.document.createElement("meta");
	meta.httpEquiv = "Content-Security-Policy";
	meta.content = "img-src https://cdn.example";
	dom.document.body.append(meta.cloneNode());
	expect(await load("https://other.example/a.png")).toBe("loaded");
	dom.document.head.append(meta);
	expect(await load("https://other.example/b.png")).toBe("broken");
	meta.content = "img-src https:";
	meta.remove();
	expect(await load("https://other.example/c.png")).toBe("broken");
	expect(await load("https://cdn.example/d.png")).toBe("loaded");
	dom.dispose();
});

test("Response.error(), a rejection, or preventDefault() without an answer fails the load", async () => {
	const dom = create({csp: "img-src https:"});
	const handled: Array<Promise<undefined>> = [];
	dom.addEventListener("fetch", (event) => {
		handled.push(event.handled);
		const name = event.request.url.slice(-5);
		if (name === "a.png") {
			event.respondWith(Response.error());
		} else if (name === "b.png") {
			event.respondWith(Promise.reject(new Error("no")));
		} else {
			event.preventDefault();
		}
	});
	dom.document.body.innerHTML =
		"<img id=a src=\"https://example.com/a.png\">" +
		"<img id=b src=\"https://example.com/b.png\">" +
		"<img id=c src=\"https://example.com/c.png\">";
	const images = ["a", "b", "c"].map((id) =>
		dom.document.getElementById(id) as HTMLImageElement);
	expect(await Promise.all(images.map(settled)))
		.toEqual(["broken", "broken", "broken"]);
	const outcomes = await Promise.all(
		handled.map((promise) =>
			promise.then(() => "resolved", (error: DOMException) => error.name)),
	);
	expect(outcomes).toEqual(["resolved", "NetworkError", "NetworkError"]);
	dom.dispose();
});

test("respondWith() is called once, during the event, and stops the other listeners", async () => {
	const dom = create({csp: "img-src https:"});
	let late: FetchEvent | null = null;
	const errors: string[] = [];
	dom.addEventListener("fetch", (event) => {
		late = event;
		event.respondWith(new Response(PNG));
		try {
			event.respondWith(new Response(PNG));
		} catch (error) {
			errors.push((error as DOMException).name);
		}
	});
	dom.addEventListener("fetch", () => {
		errors.push("second listener ran");
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	expect(() => late!.respondWith(new Response(PNG))).toThrow();
	expect(errors).toEqual(["InvalidStateError"]);
	dom.dispose();
});

test("waitUntil() keeps dispose() waiting, and dispose() aborts loads in flight", async () => {
	const dom = create({csp: "img-src https:"});
	let finish!: () => void;
	let signal!: AbortSignal;
	dom.addEventListener("fetch", (event) => {
		signal = event.request.signal;
		event.waitUntil(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		event.respondWith(new Promise<Response>(() => {}));
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	await until(() => signal !== undefined);
	let disposed = false;
	const disposing = dom.dispose().then(() => {
		disposed = true;
	});
	expect(signal.aborted).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(disposed).toBe(false);
	finish();
	await disposing;
	expect(disposed).toBe(true);
});

test("a listener added after the constructor's markup hears its images", async () => {
	const dom = create({html: "<img src=\"cid:a\">", csp: "img-src cid:"});
	dom.addEventListener("fetch", (event) => {
		event.respondWith(new Response(PNG));
	});
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	dom.dispose();
});

test("only a document that is a file loads files, whatever the policy", async () => {
	let heard = 0;
	const dom = create({url: "https://mail.example/message/1", csp: "img-src *"});
	dom.addEventListener("fetch", (event) => {
		heard++;
		event.respondWith(new Response(PNG));
	});
	dom.document.body.innerHTML = "<img src=\"file:///etc/hosts\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("broken");
	expect(heard).toBe(0);
	dom.dispose();

	const asked: string[] = [];
	const local = create({url: "file:///home/me/art/", csp: "img-src file:"});
	local.addEventListener("fetch", (event) => {
		asked.push(event.request.url);
		event.respondWith(new Response(PNG));
	});
	local.document.body.innerHTML = "<img src=\"cover.png\">";
	expect(await settled(local.document.querySelector("img")!)).toBe("loaded");
	expect(asked).toEqual(["file:///home/me/art/cover.png"]);
	local.dispose();
});

test("window.fetch is the runtime's, resolved against the document, and no policy or listener governs it", async () => {
	const server = await serve();
	const dom = create({url: `${server.origin}/app/`});
	let heard = 0;
	dom.addEventListener("fetch", () => {
		heard++;
	});
	const answer = await dom.window.fetch("data", {method: "POST", body: "x"});
	expect(answer.status).toBe(200);
	await answer.arrayBuffer();
	expect(server.heard).toEqual(["POST /app/data"]);
	expect(heard).toBe(0);
	dom.dispose();
	await server.close();
});

test("a FetchEvent can be made by hand, and only TermDOM's can be answered or extended", () => {
	const request = new Request("https://example.com/");
	const event = new FetchEvent("fetch", {request});
	expect([
		event.request,
		event.clientId,
		event.resultingClientId,
		event.replacesClientId,
		event.cancelable,
	]).toEqual([request, "", "", "", false]);
	expect(event.handled).toBeInstanceOf(Promise);
	expect(() => event.respondWith(new Response(""))).toThrow();
	expect(() => event.waitUntil(Promise.resolve())).toThrow();
	const target = new EventTarget();
	const errors: string[] = [];
	target.addEventListener("fetch", (dispatched) => {
		try {
			(dispatched as FetchEvent).respondWith(new Response(""));
		} catch (error) {
			errors.push((error as DOMException).name);
		}
	});
	target.dispatchEvent(new FetchEvent("fetch", {request}));
	expect(errors).toEqual(["InvalidStateError"]);
});

test("a SecurityPolicyViolationEvent takes its init, with violatedDirective an alias", () => {
	const dom = create();
	const Violation = (dom.window as unknown as typeof globalThis)
		.SecurityPolicyViolationEvent;
	const event = new Violation("securitypolicyviolation", {
		blockedURI: "https://example.com/a.png",
		effectiveDirective: "img-src",
		originalPolicy: "img-src 'none'",
		statusCode: 200,
	});
	expect([
		event.blockedURI,
		event.violatedDirective,
		event.disposition,
		event.statusCode,
		String(event),
	]).toEqual([
		"https://example.com/a.png",
		"img-src",
		"enforce",
		200,
		"[object SecurityPolicyViolationEvent]",
	]);
	expect(() =>
		new Violation("x", {
			disposition: "bogus" as SecurityPolicyViolationEventDisposition,
		}))
		.toThrow(TypeError);
	dom.dispose();
});

test("without a policy, every load reaches the listeners, and nothing is reported", async () => {
	const logged: string[] = [];
	const transport = {
		...new MockProcess({cols: 40, rows: 12}).transport,
		logError: (text: string) => {
			logged.push(text);
			return true;
		},
	};
	const dom = new TermDOM({transport});
	const heard: string[] = [];
	dom.addEventListener("fetch", (event) => {
		heard.push(event.request.url);
		event.respondWith(Response.error());
	});
	const violations: unknown[] = [];
	dom.document.addEventListener("securitypolicyviolation", (event) => {
		violations.push(event);
	});
	dom.document.body.innerHTML =
		"<img src=\"https://example.com/a.png\"><img src=\"cid:part1\">";
	const images = [...dom.document.querySelectorAll("img")];
	await Promise.all(images.map(settled));
	expect(heard).toEqual(["https://example.com/a.png", "cid:part1"]);
	expect(violations).toEqual([]);
	expect(logged).toEqual([]);
	dom.dispose();
});
