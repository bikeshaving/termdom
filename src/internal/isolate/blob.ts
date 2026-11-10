import {ReadableStream} from "web-streams-polyfill";

import {encodeUTF8, TextDecoder, toBytes} from "./encoding.ts";
import {DOMException} from "./events.ts";

const contents = new WeakMap<object, {bytes: Uint8Array; type: string}>();

function blobState(blob: object): {bytes: Uint8Array; type: string} {
	const state = contents.get(blob);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

export function blobBytes(blob: Blob): Uint8Array {
	return blobState(blob).bytes;
}

export function isBlob(value: unknown): value is Blob {
	return typeof value === "object" && value !== null && contents.has(value);
}

const MAX_BLOB_URLS = 10000;
const blobURLs = new Map<string, Blob>();

export function createObjectURL(object: unknown, origin: string): string {
	if (!isBlob(object)) {
		throw new TypeError("URL.createObjectURL needs a Blob");
	}

	if (blobURLs.size >= MAX_BLOB_URLS) {
		throw new DOMException("Too many blob URLs", "QuotaExceededError");
	}

	const url = `blob:${origin}/${crypto.randomUUID()}`;
	blobURLs.set(url, object);
	return url;
}

export function revokeObjectURL(url: unknown): void {
	blobURLs.delete(String(url));
}

export function blobAt(url: string): Blob | undefined {
	return blobURLs.get(url.replace(/#.*$/, ""));
}

function normalizeType(type: unknown): string {
	const text = type === undefined ? "" : String(type);
	return /^[\x20-\x7e]*$/.test(text) ? text.toLowerCase() : "";
}

function concat(parts: Iterable<unknown>): Uint8Array {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (const part of parts) {
		let chunk: Uint8Array;
		if (isBlob(part)) {
			chunk = blobBytes(part);
		} else if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
			chunk = toBytes(part).slice();
		} else {
			chunk = encodeUTF8(String(part));
		}

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

export class Blob {
	constructor(parts: Iterable<unknown> = [], options: {type?: string} = {}) {
		contents.set(this, {
			bytes: concat(parts),
			type: normalizeType(options.type),
		});
	}

	get size(): number {
		return blobState(this).bytes.length;
	}

	get type(): string {
		return blobState(this).type;
	}

	slice(start = 0, end?: number, type?: string): Blob {
		const bytes = blobState(this).bytes;
		const size = bytes.length;
		const from = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
		const to = end === undefined
			? size
			: end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
		return new Blob([bytes.subarray(from, Math.max(from, to))], {type});
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return blobState(this).bytes.slice().buffer;
	}

	async bytes(): Promise<Uint8Array> {
		return blobState(this).bytes.slice();
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(blobState(this).bytes);
	}

	stream(): ReadableStream<Uint8Array> {
		const bytes = blobState(this).bytes.slice();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				if (bytes.length > 0) {
					controller.enqueue(bytes);
				}

				controller.close();
			},
		});
	}
}

Object.defineProperty(Blob.prototype, Symbol.toStringTag, {
	value: "Blob",
	configurable: true,
});

const files = new WeakMap<object, {name: string; lastModified: number}>();

export class File extends Blob {
	constructor(
		parts: Iterable<unknown>,
		name: string,
		options: {type?: string; lastModified?: number} = {},
	) {
		if (arguments.length < 2) {
			throw new TypeError("File requires a name");
		}

		super(parts, options);
		files.set(this, {
			name: String(name),
			lastModified: options.lastModified ?? Date.now(),
		});
	}

	get name(): string {
		const state = files.get(this);
		if (state === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return state.name;
	}

	get lastModified(): number {
		const state = files.get(this);
		if (state === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return state.lastModified;
	}
}

Object.defineProperty(File.prototype, Symbol.toStringTag, {
	value: "File",
	configurable: true,
});

type Entry = [string, string | File];

const forms = new WeakMap<object, Entry[]>();

function formEntries(form: object): Entry[] {
	const entries = forms.get(form);
	if (entries === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return entries;
}

function toEntry(name: string, value: unknown, filename?: string): Entry {
	if (isBlob(value)) {
		const file = value instanceof File && filename === undefined
			? value
			: new File(
				[value],
				filename ?? (value instanceof File ? value.name : "blob"),
				{type: value.type},
			);
		return [String(name), file];
	}

	return [String(name), String(value)];
}

export class FormData {
	constructor(form?: unknown) {
		if (form !== undefined) {
			throw new TypeError("FormData from a form element is not supported here");
		}

		forms.set(this, []);
	}

	append(name: string, value: unknown, filename?: string): void {
		formEntries(this).push(toEntry(name, value, filename));
	}

	set(name: string, value: unknown, filename?: string): void {
		const entries = formEntries(this);
		const entry = toEntry(name, value, filename);
		const index = entries.findIndex(([key]) => key === entry[0]);
		if (index === -1) {
			entries.push(entry);
			return;
		}

		entries.splice(index, 1, entry);
		for (let i = entries.length - 1; i > index; i--) {
			if (entries[i][0] === entry[0]) {
				entries.splice(i, 1);
			}
		}
	}

	delete(name: string): void {
		const key = String(name);
		const entries = formEntries(this);
		forms.set(this, entries.filter(([k]) => k !== key));
	}

	get(name: string): string | File | null {
		const key = String(name);
		return formEntries(this).find(([k]) => k === key)?.[1] ?? null;
	}

	getAll(name: string): Array<string | File> {
		const key = String(name);
		return formEntries(this).filter(([k]) => k === key).map(([, v]) => v);
	}

	has(name: string): boolean {
		const key = String(name);
		return formEntries(this).some(([k]) => k === key);
	}

	forEach(
		callback: (value: string | File, key: string, form: FormData) => void,
		thisArg?: unknown,
	): void {
		for (const [key, value] of formEntries(this).slice()) {
			callback.call(thisArg, value, key, this);
		}
	}

	*entries(): IterableIterator<Entry> {
		for (const [key, value] of formEntries(this).slice()) {
			yield [key, value];
		}
	}

	*keys(): IterableIterator<string> {
		for (const [key] of formEntries(this).slice()) {
			yield key;
		}
	}

	*values(): IterableIterator<string | File> {
		for (const [, value] of formEntries(this).slice()) {
			yield value;
		}
	}

	[Symbol.iterator](): IterableIterator<Entry> {
		return this.entries();
	}
}

Object.defineProperty(FormData.prototype, Symbol.toStringTag, {
	value: "FormData",
	configurable: true,
});
