export function toBytes(input: unknown): Uint8Array {
	if (input === undefined) {
		return new Uint8Array(0);
	}

	if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
		return new Uint8Array(input);
	}

	if (ArrayBuffer.isView(input)) {
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	}

	throw new TypeError("The input must be an ArrayBuffer or a view of one");
}

export function encodeUTF8(input: string): Uint8Array {
	const out = new Uint8Array(input.length * 3);
	let length = 0;
	for (let i = 0; i < input.length; i++) {
		let code = input.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
			const next = input.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			} else {
				code = 0xfffd;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			code = 0xfffd;
		}

		if (code < 0x80) {
			out[length++] = code;
		} else if (code < 0x800) {
			out[length++] = 0xc0 | (code >> 6);
			out[length++] = 0x80 | (code & 0x3f);
		} else if (code < 0x10000) {
			out[length++] = 0xe0 | (code >> 12);
			out[length++] = 0x80 | ((code >> 6) & 0x3f);
			out[length++] = 0x80 | (code & 0x3f);
		} else {
			out[length++] = 0xf0 | (code >> 18);
			out[length++] = 0x80 | ((code >> 12) & 0x3f);
			out[length++] = 0x80 | ((code >> 6) & 0x3f);
			out[length++] = 0x80 | (code & 0x3f);
		}
	}

	return out.slice(0, length);
}

export class TextEncoder {
	get encoding(): string {
		return "utf-8";
	}

	encode(input = ""): Uint8Array {
		return encodeUTF8(String(input));
	}

	encodeInto(
		input: string,
		destination: Uint8Array,
	): {read: number; written: number} {
		let read = 0;
		let written = 0;
		for (const char of String(input)) {
			const bytes = encodeUTF8(char);
			if (written + bytes.length > destination.length) {
				break;
			}

			destination.set(bytes, written);
			written += bytes.length;
			read += char.length;
		}

		return {read, written};
	}
}

Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, {
	value: "TextEncoder",
	configurable: true,
});

const LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"]);

interface DecoderState {
	fatal: boolean;
	ignoreBOM: boolean;
	pending: number[];
	seenBOM: boolean;
}

const decoders = new WeakMap<object, DecoderState>();

function decoderState(decoder: object): DecoderState {
	const state = decoders.get(decoder);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

function stripBOM(state: DecoderState, text: string): string {
	if (!state.seenBOM && text.length > 0) {
		state.seenBOM = true;
		if (!state.ignoreBOM && text.charCodeAt(0) === 0xfeff) {
			return text.slice(1);
		}
	}

	return text;
}

export class TextDecoder {
	constructor(
		label = "utf-8",
		options: {fatal?: boolean; ignoreBOM?: boolean} = {},
	) {
		if (!LABELS.has(String(label).trim().toLowerCase())) {
			throw new RangeError(`The encoding "${label}" is not supported`);
		}

		decoders.set(this, {
			fatal: !!options.fatal,
			ignoreBOM: !!options.ignoreBOM,
			pending: [],
			seenBOM: false,
		});
	}

	get encoding(): string {
		return "utf-8";
	}

	get fatal(): boolean {
		return decoderState(this).fatal;
	}

	get ignoreBOM(): boolean {
		return decoderState(this).ignoreBOM;
	}

	decode(input?: unknown, options: {stream?: boolean} = {}): string {
		const state = decoderState(this);
		const fresh = toBytes(input);
		const bytes = state.pending.length > 0
			? Uint8Array.from([...state.pending, ...fresh])
			: fresh;
		state.pending = [];
		let out = "";
		let i = 0;
		const fail = (): void => {
			if (state.fatal) {
				state.pending = [];
				throw new TypeError("The encoded data was not valid UTF-8");
			}

			out += "�";
		};
		while (i < bytes.length) {
			const byte = bytes[i];
			let need: number;
			let code: number;
			let lower = 0x80;
			let upper = 0xbf;
			if (byte < 0x80) {
				out += String.fromCharCode(byte);
				i++;
				continue;
			} else if (byte >= 0xc2 && byte <= 0xdf) {
				need = 1;
				code = byte & 0x1f;
			} else if (byte >= 0xe0 && byte <= 0xef) {
				need = 2;
				code = byte & 0x0f;
				if (byte === 0xe0) {
					lower = 0xa0;
				} else if (byte === 0xed) {
					upper = 0x9f;
				}
			} else if (byte >= 0xf0 && byte <= 0xf4) {
				need = 3;
				code = byte & 0x07;
				if (byte === 0xf0) {
					lower = 0x90;
				} else if (byte === 0xf4) {
					upper = 0x8f;
				}
			} else {
				fail();
				i++;
				continue;
			}

			let j = 1;
			let valid = true;
			for (; j <= need; j++) {
				if (i + j >= bytes.length) {
					break;
				}

				const next = bytes[i + j];
				if (next < lower || next > upper) {
					valid = false;
					break;
				}

				lower = 0x80;
				upper = 0xbf;
				code = (code << 6) | (next & 0x3f);
			}

			if (valid && j <= need) {
				if (options.stream) {
					state.pending = Array.from(bytes.subarray(i));
					return stripBOM(state, out);
				}

				fail();
				i += j;
				continue;
			}

			if (!valid) {
				fail();
				i += j;
				continue;
			}

			out += String.fromCodePoint(code);
			i += need + 1;
		}

		const result = stripBOM(state, out);
		if (!options.stream) {
			state.seenBOM = false;
		}

		return result;
	}
}

Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, {
	value: "TextDecoder",
	configurable: true,
});
