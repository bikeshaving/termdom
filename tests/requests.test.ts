/**
 * What a document's markup loads is first checked against its Content
 * Security Policy. What the policy allows goes to the TermDOM as a
 * "request" event, then to the `fetch` it was given, the runtime's by
 * default.
 */
import {expect, test} from "@b9g/libuild/test";

import {RequestEvent, TermDOM} from "../src/index.ts";
import {encodePNG} from "../src/internal/images.ts";
import {MockProcess, until} from "./test-utils.ts";

const PNG = encodePNG({
	width: 2,
	height: 2,
	data: new Uint8ClampedArray(16).fill(255),
}) as Uint8Array<ArrayBuffer>;

function create(
	options: {
		html?: string;
		url?: string;
		fetch?: (request: Request) => Promise<Response>;
		contentSecurityPolicy?: string;
	} = {},
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

test("without a policy, markup loads nothing, and the block is reported", async () => {
	const dom = create({fetch: async () => new Response(PNG)});
	let heard = 0;
	dom.addEventListener("request", () => {
		heard++;
	});
	const violations: Array<Partial<SecurityPolicyViolationEvent>> = [];
	dom.document.addEventListener("securitypolicyviolation", (event) => {
		violations.push(event as SecurityPolicyViolationEvent);
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\" alt=\"logo\">";
	const image = dom.document.querySelector("img")!;
	expect(await settled(image)).toBe("broken");
	expect(heard).toBe(0);
	expect(violations).toHaveLength(1);
	const [violation] = violations;
	expect(violation.target).toBe(image);
	expect([
		violation.blockedURI,
		violation.effectiveDirective,
		violation.originalPolicy,
		violation.disposition,
		violation.isTrusted,
	]).toEqual([
		"https://example.com/a.png",
		"default-src",
		"default-src 'none'",
		"enforce",
		true,
	]);
	dom.dispose();
});

test("a listener answers what the policy allows, and says what asked", async () => {
	const dom = create({contentSecurityPolicy: "img-src cid:"});
	const seen: Array<Partial<RequestEvent>> = [];
	dom.addEventListener("request", (event) => {
		seen.push(event);
		event.respondWith(new Response(PNG));
	});
	dom.document.body.innerHTML =
		"<img id=a src=\"cid:logo@example.com\"><img id=b src=\"https://example.com/b.png\">";
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["loaded", "broken"]);
	expect(seen).toHaveLength(1);
	expect(seen[0].request!.url).toBe("cid:logo@example.com");
	expect(seen[0].request!.headers.get("accept")).toContain("image/png");
	expect(seen[0].destination).toBe("image");
	expect(seen[0].initiatorType).toBe("img");
	expect(seen[0].initiator).toBe(a);
	dom.dispose();
});

test("an allowed request no listener answers goes to the fetch given, or the runtime's", async () => {
	const asked: string[] = [];
	const dom = create({
		contentSecurityPolicy: "img-src https:",
		fetch: async (request) => {
			asked.push(request.url);
			return new Response(PNG);
		},
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	expect(asked).toEqual(["https://example.com/a.png"]);
	dom.dispose();

	const runtime = create({contentSecurityPolicy: "img-src data:"});
	runtime.document.body.innerHTML =
		`<img src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}">`;
	expect(await settled(runtime.document.querySelector("img")!)).toBe("loaded");
	runtime.dispose();
});

test("a page's own meta policy narrows the program's, and never widens it", async () => {
	const dom = create({contentSecurityPolicy: "img-src https:"});
	dom.addEventListener("request", (event) => {
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

test("Response.error() or a rejection refuses the request", async () => {
	const dom = create({
		contentSecurityPolicy: "img-src https:",
		fetch: async () => new Response(PNG),
	});
	dom.addEventListener("request", (event) => {
		event.respondWith(
			event.request.url.endsWith("a.png")
				? Response.error()
				: Promise.reject(new Error("no")),
		);
	});
	dom.document.body.innerHTML =
		"<img id=a src=\"https://example.com/a.png\">" +
		"<img id=b src=\"https://example.com/b.png\">";
	const a = dom.document.getElementById("a") as HTMLImageElement;
	const b = dom.document.getElementById("b") as HTMLImageElement;
	expect([await settled(a), await settled(b)]).toEqual(["broken", "broken"]);
	dom.dispose();
});

test("respondWith() is called once, during the event", async () => {
	const dom = create({contentSecurityPolicy: "img-src https:"});
	let late: RequestEvent | null = null;
	const errors: string[] = [];
	dom.addEventListener("request", (event) => {
		late = event;
		event.respondWith(new Response(PNG));
		try {
			event.respondWith(new Response(PNG));
		} catch (error) {
			errors.push((error as DOMException).name);
		}
	});
	dom.addEventListener("request", () => {
		errors.push("second listener ran");
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	expect(() => late!.respondWith(new Response(PNG))).toThrow();
	expect(errors).toEqual(["InvalidStateError"]);
	dom.dispose();
});

test("a listener added after the constructor's markup hears its images", async () => {
	const dom = create({
		html: "<img src=\"cid:a\">",
		contentSecurityPolicy: "img-src cid:",
	});
	dom.addEventListener("request", (event) => {
		event.respondWith(new Response(PNG));
	});
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	dom.dispose();
});

test("only a document that is a file loads files, whatever the policy", async () => {
	let heard = 0;
	const dom = create({
		url: "https://mail.example/message/1",
		contentSecurityPolicy: "img-src *",
		fetch: async () => new Response(PNG),
	});
	dom.addEventListener("request", () => {
		heard++;
	});
	dom.document.body.innerHTML = "<img src=\"file:///etc/hosts\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("broken");
	expect(heard).toBe(0);
	dom.dispose();

	const asked: string[] = [];
	const local = create({
		url: "file:///home/me/art/",
		contentSecurityPolicy: "img-src file:",
		fetch: async (request) => {
			asked.push(request.url);
			return new Response(PNG);
		},
	});
	local.document.body.innerHTML = "<img src=\"cover.png\">";
	expect(await settled(local.document.querySelector("img")!)).toBe("loaded");
	expect(asked).toEqual(["file:///home/me/art/cover.png"]);
	local.dispose();
});

test("window.fetch is the fetch given, the runtime's without one, and no policy governs it", async () => {
	const asked: Array<[string, string]> = [];
	const dom = create({
		url: "https://app.example/",
		fetch: async (request) => {
			asked.push([request.method, request.url]);
			return new Response("given");
		},
	});
	const answer = await dom.window.fetch("/data", {method: "POST", body: "x"});
	expect(await answer.text()).toBe("given");
	expect(asked).toEqual([["POST", "https://app.example/data"]]);
	dom.dispose();

	const plain = create();
	const response = await plain.window.fetch("data:text/plain,platform");
	expect(await response.text()).toBe("platform");
	plain.dispose();
});

test("a RequestEvent can be made and dispatched by hand", () => {
	const request = new Request("https://example.com/");
	const event = new RequestEvent("request", {request, destination: "image"});
	expect(event.destination).toBe("image");
	expect(event.initiatorType).toBe("other");
	expect(event.initiator).toBeNull();
	expect(() => event.respondWith(new Response(""))).toThrow();
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

test("a program with no policy hears once that markup loads nothing until one allows it", async () => {
	const logged: string[] = [];
	const transport = {
		...new MockProcess({cols: 40, rows: 12}).transport,
		logError: (text: string) => {
			logged.push(text);
			return true;
		},
	};
	const dom = new TermDOM({transport});
	dom.document.body.innerHTML =
		"<img id=a src=\"https://example.com/a.png\"><img id=b src=\"https://example.com/b.png\">";
	const images = [...dom.document.querySelectorAll("img")];
	await Promise.all(images.map(settled));
	expect(logged).toHaveLength(1);
	expect(logged[0]).toContain("contentSecurityPolicy");
	dom.dispose();

	const quiet: string[] = [];
	const set = new TermDOM({
		transport: {...transport, logError: (text: string) => quiet.push(text) > 0},
		contentSecurityPolicy: "img-src 'none'",
	});
	set.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	await settled(set.document.querySelector("img")!);
	expect(quiet).toEqual([]);
	set.dispose();
});
