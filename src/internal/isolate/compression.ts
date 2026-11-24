import {Gunzip, Inflate, Unzlib} from "fflate";
import {ReadableStream, WritableStream} from "web-streams-polyfill";

import {toBytes} from "./encoding.ts";

const SLICE_BYTES = 4096;

type Inflater = Gunzip | Inflate | Unzlib;

function createInflater(format: string): Inflater {
	switch (format) {
		case "gzip":
			return new Gunzip();
		case "deflate":
			return new Unzlib();
		case "deflate-raw":
			return new Inflate();
		default:
			throw new TypeError(`Unsupported compression format: ${format}`);
	}
}

const streams = new WeakMap<
	object,
	{readable: ReadableStream<Uint8Array>; writable: WritableStream<unknown>}
>();

export class DecompressionStream {
	constructor(format: string) {
		const inflater = createInflater(String(format));
		const input: Uint8Array[] = [];
		const output: Uint8Array[] = [];
		let inputDone = false;
		let ended = false;
		let wake: (() => void) | null = null;
		const signal = (): void => {
			const resume = wake;
			wake = null;
			resume?.();
		};
		inflater.ondata = (chunk, final) => {
			if (chunk.length > 0) {
				output.push(chunk);
			}

			if (final) {
				ended = true;
			}
		};
		const readable = new ReadableStream<Uint8Array>({
			async pull(controller) {
				while (output.length === 0) {
					if (input.length > 0) {
						const chunk = input[0];
						const piece = chunk.subarray(0, SLICE_BYTES);
						if (chunk.length > SLICE_BYTES) {
							input[0] = chunk.subarray(SLICE_BYTES);
						} else {
							input.shift();
						}

						if (ended) {
							controller.error(new TypeError("Junk after the compressed data"));
							return;
						}

						try {
							inflater.push(piece, inputDone && input.length === 0);
						} catch (error) {
							controller.error(
								new TypeError(`Decompression failed: ${String(error)}`),
							);
							return;
						}
					} else if (inputDone) {
						if (!ended) {
							controller.error(new TypeError("The compressed data ends early"));
						} else {
							controller.close();
						}

						return;
					} else {
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				}

				controller.enqueue(output.shift()!);
			},
			cancel() {
				input.length = 0;
				output.length = 0;
				inputDone = true;
				signal();
			},
		});
		const writable = new WritableStream<unknown>({
			write(chunk) {
				input.push(toBytes(chunk));
				signal();
			},
			close() {
				inputDone = true;
				signal();
			},
			abort() {
				input.length = 0;
				inputDone = true;
				signal();
			},
		});
		streams.set(this, {readable, writable});
	}

	get readable(): ReadableStream<Uint8Array> {
		const pair = streams.get(this);
		if (pair === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return pair.readable;
	}

	get writable(): WritableStream<unknown> {
		const pair = streams.get(this);
		if (pair === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return pair.writable;
	}
}

Object.defineProperty(DecompressionStream.prototype, Symbol.toStringTag, {
	value: "DecompressionStream",
	configurable: true,
});
