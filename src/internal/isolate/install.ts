import atob from "core-js-pure/actual/atob.js";
import btoa from "core-js-pure/actual/btoa.js";
import structuredClone from "core-js-pure/actual/structured-clone.js";
import URLSearchParams from "core-js-pure/actual/url-search-params/index.js";
import URL from "core-js-pure/actual/url/index.js";
import {
	ReadableStream,
	TransformStream,
	WritableStream,
} from "web-streams-polyfill";

import {Blob, File, FormData} from "./blob.ts";
import {DecompressionStream} from "./compression.ts";
import {console} from "./console.ts";
import {TextDecoder, TextEncoder} from "./encoding.ts";
import {
	AbortController,
	AbortSignal,
	DOMException,
	Event,
	EventTarget,
} from "./events.ts";
import {fetch, Headers, Request, Response} from "./fetch.ts";
import {host} from "./host.ts";
import {installNetwork} from "./network.ts";
import {
	clearInterval,
	clearTimeout,
	performance,
	queueMicrotask,
	setInterval,
	setTimeout,
} from "./timers.ts";

const MAX_RANDOM_BYTES = 65536;

function getRandomValues<T extends ArrayBufferView>(view: T): T {
	if (
		!(view instanceof Int8Array) &&
		!(view instanceof Uint8Array) &&
		!(view instanceof Uint8ClampedArray) &&
		!(view instanceof Int16Array) &&
		!(view instanceof Uint16Array) &&
		!(view instanceof Int32Array) &&
		!(view instanceof Uint32Array) &&
		!(view instanceof BigInt64Array) &&
		!(view instanceof BigUint64Array)
	) {
		throw new DOMException(
			"The data is not an integer typed array",
			"TypeMismatchError",
		);
	}

	if (view.byteLength > MAX_RANDOM_BYTES) {
		throw new DOMException(
			`The length exceeds ${MAX_RANDOM_BYTES} bytes`,
			"QuotaExceededError",
		);
	}

	const bytes = host.random(view.byteLength);
	new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
	return view;
}

// eslint-disable-next-line acrocase/acrocase -- the Web Crypto name
function randomUUID(): string {
	const bytes = getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return [
		hex.slice(0, 4).join(""),
		hex.slice(4, 6).join(""),
		hex.slice(6, 8).join(""),
		hex.slice(8, 10).join(""),
		hex.slice(10).join(""),
	].join("-");
}

const crypto = {getRandomValues, randomUUID};

const globals: Record<string, unknown> = {
	AbortController,
	AbortSignal,
	Blob,
	DOMException,
	DecompressionStream,
	Event,
	EventTarget,
	File,
	FormData,
	Headers,
	ReadableStream,
	Request,
	Response,
	TextDecoder,
	TextEncoder,
	TransformStream,
	URL,
	URLSearchParams,
	WritableStream,
	atob,
	btoa,
	clearInterval,
	clearTimeout,
	console,
	crypto,
	fetch,
	performance,
	queueMicrotask,
	setInterval,
	setTimeout,
	structuredClone,
};

for (const name of Object.keys(globals)) {
	Object.defineProperty(globalThis, name, {
		value: globals[name],
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

Reflect.deleteProperty(globalThis, "__core-js_shared__");
installNetwork();
