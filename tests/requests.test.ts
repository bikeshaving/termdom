/**
 * What a document's markup loads goes to the TermDOM as a "request"
 * event, then to the `fetch` it was given, and otherwise nowhere.
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

test("without a listener or a fetch, markup loads nothing", async () => {
	const dom = create({
		html: "<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"logo\">",
	});
	const image = dom.document.querySelector("img")!;
	let failed = false;
	image.addEventListener("error", () => {
		failed = true;
	});
	expect(await settled(image)).toBe("broken");
	await until(() => failed);
	dom.dispose();
});

test("a listener answers what markup asks for, and says what asked", async () => {
	const dom = create();
	const seen: Array<Partial<RequestEvent>> = [];
	dom.addEventListener("request", (event) => {
		const request = event as RequestEvent;
		seen.push(request);
		if (request.request.url.startsWith("cid:")) {
			request.respondWith(new Response(PNG));
		}
	});
	dom.document.body.innerHTML = "<img id=a src=\"cid:logo@example.com\">";
	const image = dom.document.getElementById("a") as HTMLImageElement;
	expect(await settled(image)).toBe("loaded");
	expect(seen).toHaveLength(1);
	expect(seen[0].request!.url).toBe("cid:logo@example.com");
	expect(seen[0].request!.headers.get("accept")).toContain("image/png");
	expect(seen[0].destination).toBe("image");
	expect(seen[0].initiatorType).toBe("img");
	expect(seen[0].initiator).toBe(image);
	dom.dispose();
});

test("a request no listener answers goes to the fetch given", async () => {
	const asked: string[] = [];
	const dom = create({
		fetch: async (request) => {
			asked.push(request.url);
			return new Response(PNG);
		},
	});
	dom.document.body.innerHTML = "<img src=\"https://example.com/a.png\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	expect(asked).toEqual(["https://example.com/a.png"]);
	dom.dispose();
});

test("Response.error() or a rejection refuses the request", async () => {
	const dom = create({fetch: async () => new Response(PNG)});
	dom.addEventListener("request", (event) => {
		const request = event as RequestEvent;
		request.respondWith(
			request.request.url.endsWith("a.png")
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
	const dom = create();
	let late: RequestEvent | null = null;
	const errors: string[] = [];
	dom.addEventListener("request", (event) => {
		const request = event as RequestEvent;
		late = request;
		request.respondWith(new Response(PNG));
		try {
			request.respondWith(new Response(PNG));
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
	const dom = create({html: "<img src=\"cid:a\">"});
	dom.addEventListener("request", (event) => {
		(event as RequestEvent).respondWith(new Response(PNG));
	});
	expect(await settled(dom.document.querySelector("img")!)).toBe("loaded");
	dom.dispose();
});

test("a document that is not a file loads no file, whatever answers", async () => {
	let heard = 0;
	const dom = create({
		url: "https://mail.example/message/1",
		fetch: async () => new Response(PNG),
	});
	dom.addEventListener("request", () => {
		heard++;
	});
	dom.document.body.innerHTML = "<img src=\"file:///etc/hosts\">";
	expect(await settled(dom.document.querySelector("img")!)).toBe("broken");
	expect(heard).toBe(0);
	dom.dispose();

	const local = create({fetch: async () => new Response(PNG)});
	local.document.body.innerHTML = "<img src=\"cover.png\">";
	expect(await settled(local.document.querySelector("img")!)).toBe("loaded");
	local.dispose();
});

test("window.fetch is the fetch given, and the runtime's without one", async () => {
	const given = async () => new Response("given");
	const dom = create({fetch: given});
	expect(dom.window.fetch).toBe(given);
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
