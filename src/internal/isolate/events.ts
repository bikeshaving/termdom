import {reportError} from "./console.ts";
import {performance, setTimeout} from "./timers.ts";

const CODES: Record<string, number> = {
	IndexSizeError: 1,
	HierarchyRequestError: 3,
	WrongDocumentError: 4,
	InvalidCharacterError: 5,
	NoModificationAllowedError: 7,
	NotFoundError: 8,
	NotSupportedError: 9,
	InvalidStateError: 11,
	SyntaxError: 12,
	InvalidModificationError: 13,
	NamespaceError: 14,
	InvalidAccessError: 15,
	TypeMismatchError: 17,
	SecurityError: 18,
	NetworkError: 19,
	AbortError: 20,
	URLMismatchError: 21,
	QuotaExceededError: 22,
	TimeoutError: 23,
	InvalidNodeTypeError: 24,
	DataCloneError: 25,
};

export class DOMException extends Error {
	declare readonly name: string;
	declare readonly code: number;

	constructor(message = "", name = "Error") {
		super(String(message));
		Object.defineProperty(this, "name", {
			value: String(name),
			configurable: true,
			writable: true,
		});
		Object.defineProperty(this, "code", {
			value: CODES[String(name)] ?? 0,
			configurable: true,
		});
	}
}

interface EventState {
	type: string;
	bubbles: boolean;
	cancelable: boolean;
	composed: boolean;
	target: EventTarget | null;
	currentTarget: EventTarget | null;
	phase: number;
	canceled: boolean;
	stopped: boolean;
	stoppedImmediately: boolean;
	inPassiveListener: boolean;
	timeStamp: number;
}

const events = new WeakMap<object, EventState>();

function eventState(event: object): EventState {
	const state = events.get(event);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

function isTrusted(): boolean {
	return false;
}

export class Event {
	static readonly NONE = 0;
	static readonly CAPTURING_PHASE = 1;
	static readonly AT_TARGET = 2;
	static readonly BUBBLING_PHASE = 3;

	constructor(type: string, init: EventInit = {}) {
		if (arguments.length === 0) {
			throw new TypeError("The event type is required");
		}

		events.set(this, {
			type: String(type),
			bubbles: !!init?.bubbles,
			cancelable: !!init?.cancelable,
			composed: !!init?.composed,
			target: null,
			currentTarget: null,
			phase: 0,
			canceled: false,
			stopped: false,
			stoppedImmediately: false,
			inPassiveListener: false,
			timeStamp: performance.now(),
		});
		Object.defineProperty(this, "isTrusted", {
			get: isTrusted,
			enumerable: true,
			configurable: false,
		});
	}

	get type(): string {
		return eventState(this).type;
	}

	get bubbles(): boolean {
		return eventState(this).bubbles;
	}

	get cancelable(): boolean {
		return eventState(this).cancelable;
	}

	get composed(): boolean {
		return eventState(this).composed;
	}

	get target(): EventTarget | null {
		return eventState(this).target;
	}

	get srcElement(): EventTarget | null {
		return eventState(this).target;
	}

	get currentTarget(): EventTarget | null {
		return eventState(this).currentTarget;
	}

	get eventPhase(): number {
		return eventState(this).phase;
	}

	get defaultPrevented(): boolean {
		return eventState(this).canceled;
	}

	get returnValue(): boolean {
		return !eventState(this).canceled;
	}

	get cancelBubble(): boolean {
		return eventState(this).stopped;
	}

	set cancelBubble(value: boolean) {
		if (value) {
			eventState(this).stopped = true;
		}
	}

	get timeStamp(): number {
		return eventState(this).timeStamp;
	}

	composedPath(): EventTarget[] {
		const state = eventState(this);
		return state.currentTarget ? [state.currentTarget] : [];
	}

	preventDefault(): void {
		const state = eventState(this);
		if (state.cancelable && !state.inPassiveListener) {
			state.canceled = true;
		}
	}

	stopPropagation(): void {
		eventState(this).stopped = true;
	}

	stopImmediatePropagation(): void {
		const state = eventState(this);
		state.stopped = true;
		state.stoppedImmediately = true;
	}
}

Object.defineProperty(Event.prototype, Symbol.toStringTag, {
	value: "Event",
	configurable: true,
});

interface Listener {
	callback: EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;
}

const targets = new WeakMap<object, Map<string, Listener[]>>();

function listenersOf(target: object): Map<string, Listener[]> {
	let map = targets.get(target);
	if (map === undefined) {
		map = new Map();
		targets.set(target, map);
	}

	return map;
}

function flatten(options: boolean | EventListenerOptions | undefined): boolean {
	return typeof options === "boolean" ? options : !!options?.capture;
}

export class EventTarget {
	constructor() {
		listenersOf(this);
	}

	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		if (callback == null) {
			return;
		}

		const capture = flatten(options);
		const object = typeof options === "object" ? options : undefined;
		const signal = object?.signal;
		if (signal?.aborted) {
			return;
		}

		const map = listenersOf(this);
		const key = String(type);
		const list = map.get(key) ?? [];
		if (list.some((l) => l.callback === callback && l.capture === capture)) {
			return;
		}

		const listener: Listener = {
			callback,
			capture,
			once: !!object?.once,
			passive: !!object?.passive,
			removed: false,
		};
		list.push(listener);
		map.set(key, list);
		signal?.addEventListener("abort", () => {
			this.removeEventListener(key, callback, {capture});
		});
	}

	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		const capture = flatten(options);
		const map = listenersOf(this);
		const list = map.get(String(type));
		if (list === undefined) {
			return;
		}

		const index = list.findIndex(
			(l) => l.callback === callback && l.capture === capture,
		);
		if (index !== -1) {
			list[index].removed = true;
			list.splice(index, 1);
		}
	}

	dispatchEvent(event: Event): boolean {
		const state = eventState(event);
		if (state.phase !== 0) {
			throw new DOMException(
				"The event is already being dispatched.",
				"InvalidStateError",
			);
		}

		state.target = this;
		state.currentTarget = this;
		state.phase = 2;
		const list = listenersOf(this).get(state.type);
		for (const listener of list ? list.slice() : []) {
			if (listener.removed) {
				continue;
			}

			if (listener.once) {
				this.removeEventListener(state.type, listener.callback, {
					capture: listener.capture,
				});
			}

			state.inPassiveListener = listener.passive;
			try {
				const callback = listener.callback;
				if (typeof callback === "function") {
					callback.call(this, event as never);
				} else {
					callback.handleEvent(event as never);
				}
			} catch (error) {
				reportError(error);
			}

			state.inPassiveListener = false;
			if (state.stoppedImmediately) {
				break;
			}
		}

		state.phase = 0;
		state.currentTarget = null;
		return !state.canceled;
	}
}

Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, {
	value: "EventTarget",
	configurable: true,
});

interface SignalState {
	aborted: boolean;
	reason: unknown;
	onabort: ((event: Event) => unknown) | null;
}

const signals = new WeakMap<object, SignalState>();
let constructingSignal = false;

function signalState(signal: object): SignalState {
	const state = signals.get(signal);
	if (state === undefined) {
		throw new TypeError("Illegal invocation");
	}

	return state;
}

function createSignal(): AbortSignal {
	constructingSignal = true;
	try {
		return new AbortSignal();
	} finally {
		constructingSignal = false;
	}
}

function abortSignal(signal: AbortSignal, reason: unknown): void {
	const state = signalState(signal);
	if (state.aborted) {
		return;
	}

	state.aborted = true;
	state.reason = reason === undefined
		? new DOMException("This operation was aborted", "AbortError")
		: reason;
	const event = new Event("abort");
	if (state.onabort) {
		try {
			state.onabort.call(signal, event);
		} catch (error) {
			reportError(error);
		}
	}

	signal.dispatchEvent(event);
}

export class AbortSignal extends EventTarget {
	constructor() {
		if (!constructingSignal) {
			throw new TypeError("Illegal constructor");
		}

		super();
		signals.set(this, {aborted: false, reason: undefined, onabort: null});
	}

	get aborted(): boolean {
		return signalState(this).aborted;
	}

	get reason(): unknown {
		return signalState(this).reason;
	}

	get onabort(): ((event: Event) => unknown) | null {
		return signalState(this).onabort;
	}

	set onabort(value: ((event: Event) => unknown) | null) {
		signalState(this).onabort = typeof value === "function" ? value : null;
	}

	static abort(reason?: unknown): AbortSignal {
		const signal = createSignal();
		abortSignal(signal, reason);
		return signal;
	}

	static timeout(ms: number): AbortSignal {
		const signal = createSignal();
		setTimeout(() => {
			abortSignal(
				signal,
				new DOMException("The operation timed out.", "TimeoutError"),
			);
		}, ms);
		return signal;
	}

	static any(sources: Iterable<AbortSignal>): AbortSignal {
		const signal = createSignal();
		const list = Array.from(sources);
		for (const source of list) {
			if (source.aborted) {
				abortSignal(signal, source.reason);
				return signal;
			}
		}

		for (const source of list) {
			source.addEventListener(
				"abort",
				() => abortSignal(signal, source.reason),
				{once: true},
			);
		}

		return signal;
	}

	throwIfAborted(): void {
		const state = signalState(this);
		if (state.aborted) {
			throw state.reason;
		}
	}
}

Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, {
	value: "AbortSignal",
	configurable: true,
});

const controllers = new WeakMap<object, AbortSignal>();

export class AbortController {
	constructor() {
		controllers.set(this, createSignal());
	}

	get signal(): AbortSignal {
		const signal = controllers.get(this);
		if (signal === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return signal;
	}

	abort(reason?: unknown): void {
		abortSignal(this.signal, reason);
	}
}

Object.defineProperty(AbortController.prototype, Symbol.toStringTag, {
	value: "AbortController",
	configurable: true,
});
