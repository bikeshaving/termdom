/**
 * navigator.clipboard and the items it moves, carried over OSC 52.
 *
 * The module knows nothing about the engine: it is handed a way to reach the
 * terminal's clipboard when reaching it is permitted, and answers a refusal
 * when it is not.
 */
import {EventTarget} from "./dom.js";

/** The two clipboard round trips a terminal session answers. */
export interface ClipboardTerminal {
	writeClipboard(text: string): Promise<void>;
	queryClipboard(): Promise<string | null>;
}

/**
 * What the clipboard asks its host before it moves anything.
 *
 * The clipboard is the user's to grant, so it is reachable only from a
 * trusted activation-triggering event while it is being dispatched -- a
 * keystroke, a mouse press or release, a click, a paste. This is stricter
 * than a browser on purpose: a browser's transient activation outlives the
 * dispatch that granted it, because its window is a span of time, so a
 * handler there may await and still write the clipboard. Here the gate is the
 * dispatch itself, and the clipboard is reachable only synchronously within
 * it. A timer, a microtask, a resolved fetch and an event an application
 * dispatched itself are all outside.
 */
export interface ClipboardAccess {
	/** The terminal to talk to, or null with no attached interactive one. */
	terminal(): ClipboardTerminal | null;
	/** Whether a user gesture is being dispatched right now. */
	userActive(): boolean;
}

const kItemEntries = Symbol("entries");

/** Refuse a clipboard request the user has not asked for. */
function clipboardDenied(why: string): Promise<never> {
	return Promise.reject(new globalThis.DOMException(why, "NotAllowedError"));
}

/** A media type, lowercased with the surrounding whitespace dropped. */
function normalizeMediaType(type: unknown): string {
	return String(type).trim().toLowerCase();
}

/** The payload OSC 52 carries, which is text and only text. */
const CLIPBOARD_TEXT_TYPE = "text/plain";

/**
 * A payload the clipboard moves, held under the media types it reads as.
 *
 * Blob is the platform's, which Node and Bun both have as a global. OSC 52
 * carries one payload a terminal treats as text, so text/plain is the only
 * type a write sends and the only type a read answers with; an item may hold
 * others, and the clipboard passes over them.
 */
export class ClipboardItem {
	declare [kItemEntries]: Map<string, Promise<Blob>>;

	constructor(
		items: Record<string, string | Blob | Promise<string | Blob>>,
		_options?: unknown,
	) {
		if (items === null || typeof items !== "object") {
			throw new TypeError("A clipboard item takes a record of types");
		}
		const entries = new Map<string, Promise<Blob>>();
		for (const [type, value] of Object.entries(items)) {
			const mediaType = normalizeMediaType(type);
			entries.set(
				mediaType,
				Promise.resolve(value).then((held) =>
					held instanceof Blob ?
						held :
							new Blob([String(held)], {type: mediaType}),
				),
			);
		}
		if (entries.size === 0) {
			throw new TypeError("A clipboard item carries at least one type");
		}
		this[kItemEntries] = entries;
	}

	get types(): readonly string[] {
		return Object.freeze(Array.from(this[kItemEntries].keys()));
	}

	getType(type: string): Promise<Blob> {
		const held = this[kItemEntries].get(normalizeMediaType(type));
		if (held === undefined) {
			return Promise.reject(
				new globalThis.DOMException(
					`That item carries no ${normalizeMediaType(type)}`,
					"NotFoundError",
				),
			);
		}
		return held;
	}

	static supports(type: string): boolean {
		return normalizeMediaType(type) === CLIPBOARD_TEXT_TYPE;
	}
}

Object.defineProperty(ClipboardItem.prototype, Symbol.toStringTag, {
	value: "ClipboardItem",
	configurable: true,
});

/** The brand an interface with no constructor is built through internally. */
const kInternalConstruction = Symbol("internal construction");
const kClipboardAccess = Symbol("access");

/**
 * The clipboard, as navigator.clipboard.
 *
 * writeText() carries the text to the system clipboard over OSC 52, which
 * travels in-band -- across SSH too. Terminals without OSC 52 ignore it;
 * there is no way to know, so the promise resolves when the transport has the
 * bytes. readText() asks for the clipboard the same way (OSC 52 with `?` for
 * the payload) and resolves with what comes back. write() and read() are the
 * same two round trips over a ClipboardItem.
 *
 * It is an EventTarget because the interface says so; the user agent fires
 * nothing at it.
 */
export class Clipboard extends EventTarget {
	declare [kClipboardAccess]: ClipboardAccess;

	constructor(brand?: unknown, access?: ClipboardAccess) {
		super();
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kClipboardAccess] = access as ClipboardAccess;
	}

	writeText(text: string): Promise<void> {
		const reached = reach(this[kClipboardAccess], "writes");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		return reached.terminal.writeClipboard(String(text));
	}

	async readText(): Promise<string> {
		const reached = reach(this[kClipboardAccess], "reads");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		const text = await reached.terminal.queryClipboard();
		if (text === null) {
			// Silence is a refusal: most terminals gate clipboard reads on
			// their own configuration and answer nothing when they are off.
			return clipboardDenied("the terminal did not answer the clipboard query");
		}
		return text;
	}

	async write(items: Iterable<ClipboardItem>): Promise<void> {
		const reached = reach(this[kClipboardAccess], "writes");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		let carrier: ClipboardItem | null = null;
		for (const item of items) {
			if (item.types.includes(CLIPBOARD_TEXT_TYPE)) {
				carrier = item;
				break;
			}
		}
		if (carrier === null) {
			return clipboardDenied(
				`a clipboard write needs a ${CLIPBOARD_TEXT_TYPE} entry`,
			);
		}
		const text = await (await carrier.getType(CLIPBOARD_TEXT_TYPE)).text();
		return reached.terminal.writeClipboard(text);
	}

	async read(): Promise<ClipboardItem[]> {
		const text = await this.readText();
		return [new ClipboardItem({[CLIPBOARD_TEXT_TYPE]: text})];
	}
}

Object.defineProperty(Clipboard.prototype, Symbol.toStringTag, {
	value: "Clipboard",
	configurable: true,
});

/** The terminal to move bytes over, or the refusal standing in its way. */
type Reached =
	{terminal: ClipboardTerminal; refusal: null} |
	{terminal: null; refusal: Promise<never>};

function reach(access: ClipboardAccess, what: string): Reached {
	const terminal = access.terminal();
	if (terminal === null) {
		return {
			terminal: null,
			refusal: clipboardDenied(
				"clipboard requires an attached interactive terminal",
			),
		};
	}
	if (!access.userActive()) {
		return {
			terminal: null,
			refusal: clipboardDenied(`clipboard ${what} need a user gesture`),
		};
	}
	return {terminal, refusal: null};
}

/** Build the clipboard a navigator carries. */
export function createClipboard(access: ClipboardAccess): Clipboard {
	return new Clipboard(kInternalConstruction, access);
}
