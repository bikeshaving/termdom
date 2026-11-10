import URLSearchParamsConstructor from "core-js-pure/actual/url-search-params/index.js";
import URLConstructor from "core-js-pure/actual/url/index.js";
import {ReadableStream} from "web-streams-polyfill";

import {Blob, blobAt, blobBytes, FormData, isBlob} from "./blob.ts";
import {encodeUTF8, TextDecoder, toBytes} from "./encoding.ts";
import {AbortController, type AbortSignal} from "./events.ts";

type HeaderList = Array<[string, string]>;

const headerLists =
	new WeakMap<object, {list: HeaderList; immutable: boolean}>();

function headerState(headers: object): {list: HeaderList; immutable: boolean} {
	const state = headerLists.get(headers);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

function headerName(name: unknown): string {
	const text = String(name);
	if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text)) {
		throw new TypeError(`Invalid header name: ${text}`);
	}

	return text.toLowerCase();
}

function headerValue(value: unknown): string {
	const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
	if (/[\0\r\n]/.test(text)) {
		throw new TypeError("Invalid header value");
	}

	return text;
}

function mutable(headers: object): HeaderList {
	const state = headerState(headers);
	if (state.immutable) {
		throw new TypeError("Headers are immutable");
	}

	return state.list;
}

export function freezeHeaders(headers: Headers): void {
	headerState(headers).immutable = true;
}

export class Headers {
	constructor(init?: unknown) {
		headerLists.set(this, {list: [], immutable: false});
		if (init == null) {
			return;
		}

		if (init instanceof Headers) {
			for (const [name, value] of headerState(init).list) {
				this.append(name, value);
			}
		} else if (
			typeof init === "object" && Symbol.iterator in (init as object)
		) {
			for (const pair of init as Iterable<Iterable<unknown>>) {
				const items = Array.from(pair);
				if (items.length !== 2) {
					throw new TypeError("Each header must be a name and a value");
				}

				this.append(String(items[0]), String(items[1]));
			}
		} else if (typeof init === "object") {
			for (const key of Object.keys(init as object)) {
				this.append(key, String((init as Record<string, unknown>)[key]));
			}
		} else {
			throw new TypeError("Invalid headers");
		}
	}

	append(name: string, value: string): void {
		mutable(this).push([headerName(name), headerValue(value)]);
	}

	set(name: string, value: string): void {
		const key = headerName(name);
		const list = mutable(this);
		const index = list.findIndex(([k]) => k === key);
		const entry: [string, string] = [key, headerValue(value)];
		if (index === -1) {
			list.push(entry);
			return;
		}

		list.splice(index, 1, entry);
		for (let i = list.length - 1; i > index; i--) {
			if (list[i][0] === key) {
				list.splice(i, 1);
			}
		}
	}

	delete(name: string): void {
		const key = headerName(name);
		const list = mutable(this);
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i][0] === key) {
				list.splice(i, 1);
			}
		}
	}

	get(name: string): string | null {
		const key = headerName(name);
		const values = headerState(this)
			.list.filter(([k]) => k === key)
			.map(([, v]) => v);
		return values.length === 0 ? null : values.join(", ");
	}

	getSetCookie(): string[] {
		return headerState(this)
			.list.filter(([k]) => k === "set-cookie")
			.map(([, v]) => v);
	}

	has(name: string): boolean {
		const key = headerName(name);
		return headerState(this).list.some(([k]) => k === key);
	}

	*entries(): IterableIterator<[string, string]> {
		const names = [...new Set(headerState(this).list.map(([k]) => k))].sort();
		for (const name of names) {
			yield [name, this.get(name)!];
		}
	}

	*keys(): IterableIterator<string> {
		for (const [name] of this.entries()) {
			yield name;
		}
	}

	*values(): IterableIterator<string> {
		for (const [, value] of this.entries()) {
			yield value;
		}
	}

	forEach(
		callback: (value: string, name: string, headers: Headers) => void,
		thisArg?: unknown,
	): void {
		for (const [name, value] of this.entries()) {
			callback.call(thisArg, value, name, this);
		}
	}

	[Symbol.iterator](): IterableIterator<[string, string]> {
		return this.entries();
	}
}

Object.defineProperty(Headers.prototype, Symbol.toStringTag, {
	value: "Headers",
	configurable: true,
});

interface BodyState {
	stream: ReadableStream<Uint8Array> | null;
	bytes: Uint8Array | null;
	used: boolean;
}

const bodies = new WeakMap<object, BodyState>();

function bodyState(owner: object): BodyState {
	const state = bodies.get(owner);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

function extractBody(
	init: unknown,
	headers: Headers,
): {stream: ReadableStream<Uint8Array> | null; bytes: Uint8Array | null} {
	if (init == null) {
		return {stream: null, bytes: null};
	}

	let bytes: Uint8Array;
	let type: string | null = null;
	if (init instanceof ReadableStream) {
		return {stream: init as ReadableStream<Uint8Array>, bytes: null};
	} else if (isBlob(init)) {
		bytes = blobBytes(init).slice();
		type = (init as Blob).type || null;
	} else if (init instanceof ArrayBuffer || ArrayBuffer.isView(init)) {
		bytes = toBytes(init).slice();
	} else if (init instanceof URLSearchParamsConstructor) {
		bytes = encodeUTF8(String(init));
		type = "application/x-www-form-urlencoded;charset=UTF-8";
	} else if (init instanceof FormData) {
		throw new TypeError("A FormData body is not supported yet");
	} else {
		bytes = encodeUTF8(String(init));
		type = "text/plain;charset=UTF-8";
	}

	if (type !== null && !headers.has("content-type")) {
		headers.set("content-type", type);
	}

	return {stream: null, bytes};
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.length > 0) {
				controller.enqueue(bytes.slice());
			}

			controller.close();
		},
	});
}

function bodyStream(state: BodyState): ReadableStream<Uint8Array> | null {
	if (state.stream === null && state.bytes !== null) {
		state.stream = streamOf(state.bytes);
	}

	return state.stream;
}

async function consume(owner: object): Promise<Uint8Array> {
	const state = bodyState(owner);
	if (state.used) {
		throw new TypeError("Body has already been consumed");
	}

	state.used = true;
	if (state.stream === null) {
		return state.bytes ? state.bytes.slice() : new Uint8Array(0);
	}

	const reader = state.stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			break;
		}

		const chunk = toBytes(value);
		chunks.push(chunk);
		length += chunk.length;
	}

	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}

	return out;
}

function teeBody(state: BodyState): BodyState {
	if (state.used) {
		throw new TypeError("Body has already been consumed");
	}

	if (state.stream === null) {
		return {stream: null, bytes: state.bytes, used: false};
	}

	const [left, right] = state.stream.tee();
	state.stream = left;
	return {stream: right, bytes: null, used: false};
}

class Body {
	get body(): ReadableStream<Uint8Array> | null {
		return bodyStream(bodyState(this));
	}

	get bodyUsed(): boolean {
		const state = bodyState(this);
		return state.used || (state.stream?.locked ?? false);
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await consume(this)).buffer as ArrayBuffer;
	}

	async bytes(): Promise<Uint8Array> {
		return consume(this);
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await consume(this));
	}

	async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}

	async blob(): Promise<Blob> {
		const type =
			(this as unknown as {headers: Headers}).headers.get("content-type");
		return new Blob([await consume(this)], {type: type ?? ""});
	}
}

interface RequestState {
	url: string;
	method: string;
	headers: Headers;
	signal: AbortSignal;
	redirect: RequestRedirect;
	mode: RequestMode;
	credentials: RequestCredentials;
	cache: RequestCache;
	destination: string;
	referrer: string;
	referrerPolicy: string;
	integrity: string;
	keepalive: boolean;
}

const requests = new WeakMap<object, RequestState>();

function requestState(request: object): RequestState {
	const state = requests.get(request);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

let baseURL = "about:blank";

export function setBaseURL(url: string): void {
	baseURL = url;
}

export function setDestination(request: Request, destination: string): void {
	requestState(request).destination = destination;
}

const METHODS = new Set([
	"DELETE",
	"GET",
	"HEAD",
	"OPTIONS",
	"POST",
	"PUT",
	"PATCH",
]);

export class Request extends Body {
	constructor(input: unknown, init: RequestInit = {}) {
		super();
		let source: RequestState | null = null;
		let url: string;
		if (input instanceof Request) {
			source = requestState(input);
			url = source.url;
		} else {
			url = new URLConstructor(String(input), baseURL).href;
		}

		let method = init.method ?? source?.method ?? "GET";
		if (METHODS.has(method.toUpperCase())) {
			method = method.toUpperCase();
		}

		const headers = new Headers(init.headers ?? source?.headers);
		const controller = new AbortController();
		const parent = init.signal ?? source?.signal;
		if (parent) {
			if (parent.aborted) {
				controller.abort(parent.reason);
			} else {
				parent.addEventListener(
					"abort",
					() => controller.abort(parent.reason),
					{once: true},
				);
			}
		}

		requests.set(this, {
			url,
			method,
			headers,
			signal: controller.signal,
			redirect: init.redirect ?? source?.redirect ?? "follow",
			mode: init.mode ?? source?.mode ?? "cors",
			credentials: init.credentials ?? source?.credentials ?? "same-origin",
			cache: init.cache ?? source?.cache ?? "default",
			// Read through the request, where the engine sets it as its own
			// property.
			destination: source === undefined ? "" : (input as Request).destination,
			referrer: init.referrer ?? source?.referrer ?? "about:client",
			referrerPolicy: init.referrerPolicy ?? source?.referrerPolicy ?? "",
			integrity: init.integrity ?? source?.integrity ?? "",
			keepalive: init.keepalive ?? source?.keepalive ?? false,
		});

		if (init.body != null && (method === "GET" || method === "HEAD")) {
			throw new TypeError("A GET or HEAD request cannot have a body");
		}

		if (init.body !== undefined) {
			bodies.set(this, {...extractBody(init.body, headers), used: false});
		} else if (input instanceof Request) {
			bodies.set(this, teeBody(bodyState(input)));
		} else {
			bodies.set(this, {stream: null, bytes: null, used: false});
		}
	}

	get url(): string {
		return requestState(this).url;
	}

	get method(): string {
		return requestState(this).method;
	}

	get headers(): Headers {
		return requestState(this).headers;
	}

	get signal(): AbortSignal {
		return requestState(this).signal;
	}

	get redirect(): RequestRedirect {
		return requestState(this).redirect;
	}

	get mode(): RequestMode {
		return requestState(this).mode;
	}

	get credentials(): RequestCredentials {
		return requestState(this).credentials;
	}

	get cache(): RequestCache {
		return requestState(this).cache;
	}

	get destination(): string {
		return requestState(this).destination;
	}

	get referrer(): string {
		return requestState(this).referrer;
	}

	get referrerPolicy(): string {
		return requestState(this).referrerPolicy;
	}

	get integrity(): string {
		return requestState(this).integrity;
	}

	get keepalive(): boolean {
		return requestState(this).keepalive;
	}

	clone(): Request {
		return new Request(this);
	}
}

Object.defineProperty(Request.prototype, Symbol.toStringTag, {
	value: "Request",
	configurable: true,
});

interface ResponseState {
	status: number;
	statusText: string;
	headers: Headers;
	url: string;
	redirected: boolean;
	type: ResponseType;
}

const responses = new WeakMap<object, ResponseState>();

function responseState(response: object): ResponseState {
	const state = responses.get(response);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

export function setResponseURL(
	response: Response,
	url: string,
	redirected: boolean,
): void {
	const state = responseState(response);
	state.url = url;
	state.redirected = redirected;
	state.type = "basic";
}

export class Response extends Body {
	constructor(body?: unknown, init: ResponseInit = {}) {
		super();
		const status = init.status ?? 200;
		if (status !== 0 && (status < 200 || status > 599)) {
			throw new RangeError(`Invalid status ${status}`);
		}

		const headers = new Headers(init.headers);
		responses.set(this, {
			status,
			statusText: init.statusText ?? "",
			headers,
			url: "",
			redirected: false,
			type: status === 0 ? "error" : "default",
		});
		bodies.set(this, {...extractBody(body, headers), used: false});
	}

	get status(): number {
		return responseState(this).status;
	}

	get statusText(): string {
		return responseState(this).statusText;
	}

	get ok(): boolean {
		const status = responseState(this).status;
		return status >= 200 && status < 300;
	}

	get headers(): Headers {
		return responseState(this).headers;
	}

	get url(): string {
		return responseState(this).url;
	}

	get redirected(): boolean {
		return responseState(this).redirected;
	}

	get type(): ResponseType {
		return responseState(this).type;
	}

	static error(): Response {
		const response = new Response(null, {status: 0});
		freezeHeaders(response.headers);
		return response;
	}

	static redirect(url: string, status = 302): Response {
		if (![301, 302, 303, 307, 308].includes(status)) {
			throw new RangeError(`Invalid redirect status ${status}`);
		}

		return new Response(null, {
			status,
			headers: {location: new URLConstructor(String(url), baseURL).href},
		});
	}

	static json(data: unknown, init: ResponseInit = {}): Response {
		const headers = new Headers(init.headers);
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}

		return new Response(JSON.stringify(data), {
			...init,
			headers: headers as never,
		});
	}

	clone(): Response {
		const state = responseState(this);
		const copy = new Response(null, {
			status: state.status || 200,
			statusText: state.statusText,
			headers: state.headers as never,
		});
		const copyState = responseState(copy);
		copyState.status = state.status;
		copyState.url = state.url;
		copyState.redirected = state.redirected;
		copyState.type = state.type;
		bodies.set(copy, teeBody(bodyState(this)));
		return copy;
	}
}

Object.defineProperty(Response.prototype, Symbol.toStringTag, {
	value: "Response",
	configurable: true,
});

export type Fetcher = (request: Request) => Promise<Response>;

async function noNetwork(): Promise<Response> {
	throw new TypeError("Failed to fetch: no network in this frame");
}

let fetcher: Fetcher = noNetwork;

export function setFetcher(next: Fetcher): void {
	fetcher = next;
}

export async function fetch(
	input: unknown,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init);
	request.signal.throwIfAborted();
	if (request.url.startsWith("blob:")) {
		const blob = request.method === "GET" ? blobAt(request.url) : undefined;
		if (blob === undefined) {
			throw new TypeError("Failed to fetch");
		}

		return new Response(blob, {
			headers: {"content-type": blob.type, "content-length": String(blob.size)},
		});
	}

	return fetcher(request);
}
