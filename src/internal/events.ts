import type {Document, Element, Node, Window} from "./dom.ts";

function isNodeTarget(target: EventTarget): target is Node {
	return typeof (target as {nodeType?: unknown}).nodeType === "number";
}

function isWindowTarget(target: EventTarget): target is Window {
	return !isNodeTarget(target) &&
		(target as {window?: unknown}).window === target;
}

function getTargetDocument(target: EventTarget): Document | null {
	if (isNodeTarget(target)) {
		return (target.nodeType === 9 ? target : target.ownerDocument) as Document |
			null;
	}
	if (isWindowTarget(target)) {
		return target.document as unknown as Document;
	}
	return null;
}

/** Event types whose listeners mean the document observes pointer hover. */
const HOVER_EVENT_TYPES = new Set([
	"mousemove",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
]);

// The engine checks this count to decide whether the terminal should
// report pointer motion. Motion reporting floods stdin, so it stays off
// until a listener can actually use the events.
interface HoverListenerCount {
	count: number;
	onChange: (() => void) | null;
}

const hoverListenerCounters = new WeakMap<Document, HoverListenerCount>();

function getHoverCount(document: Document): HoverListenerCount {
	let hoverCount = hoverListenerCounters.get(document);
	if (hoverCount === undefined) {
		hoverCount = {count: 0, onChange: null};
		hoverListenerCounters.set(document, hoverCount);
	}
	return hoverCount;
}

// Returns null when the type is not a hover type or the target belongs to
// no document.
function getListenerHoverCount(
	target: EventTarget,
	type: string,
): HoverListenerCount | null {
	if (!HOVER_EVENT_TYPES.has(type)) {
		return null;
	}
	const document = getTargetDocument(target);
	return document === null ? null : getHoverCount(document);
}

function countHoverListener(target: EventTarget, listener: Listener): void {
	const hoverCount = getListenerHoverCount(target, listener.type);
	if (hoverCount !== null) {
		listener.hoverCount = hoverCount;
		hoverCount.count++;
		hoverCount.onChange?.();
	}
}

// One watcher per document, which is the engine displaying it. The
// returned function reads the current count.
const hoverListenerCounts = new WeakMap<Document, () => number>();

export function watchHoverListeners(
	document: Document,
	onChange: () => void,
): void {
	const hoverCount = getHoverCount(document);
	hoverCount.onChange = onChange;
	hoverListenerCounts.set(document, () => hoverCount.count);
}

export function hoverListenerCount(document: globalThis.Document): number {
	return hoverListenerCounts.get(document as Document)?.() ?? 0;
}

export function toUnsignedLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	const truncated = Math.trunc(number);
	return ((truncated % 4294967296) + 4294967296) % 4294967296;
}

/**
 * Convert to a WebIDL unsigned short: the unsigned long, wrapped into 16 bits.
 */
export function toUnsignedShort(value: unknown): number {
	return toUnsignedLong(value) % 65536;
}

/** Build one of this file's objects whose constructor authors cannot call. */
export function constructInternal<T>(build: () => T): T {
	const previous = internalConstruction;
	internalConstruction = true;
	try {
		return build();
	} finally {
		internalConstruction = previous;
	}
}

// The HTML element constructor is an author-facing algorithm: it looks
// up which custom element definition `new.target` names and throws if
// there is none. The tree's own creation path needs the same classes
// without that check, and this flag tells the constructor which case it
// is in.
let internalConstruction = false;

export function isConstructingInternally(): boolean {
	return internalConstruction;
}

const kType = Symbol("type");
const kData = Symbol("data");
const kReturnValue = Symbol("returnValue");

// Use the platform's DOMException so a caller's `instanceof DOMException`
// and `error.code` checks work.
export const PlatformDOMException: typeof DOMException = (
	globalThis as unknown as {DOMException: typeof DOMException}
).DOMException;

export function domError(name: string, message: string): DOMException {
	return new PlatformDOMException(message, name);
}

export interface EventInit {
	bubbles?: boolean;
	cancelable?: boolean;
	composed?: boolean;
}

interface CustomEventInit<T = any> extends EventInit {
	detail?: T;
}

export const NONE = 0;
export const CAPTURING_PHASE = 1;
export const AT_TARGET = 2;
export const BUBBLING_PHASE = 3;

// The shadow members (the adjusted target and the two closed-tree flags)
// are what composedPath() uses to decide how much of the path a listener
// may see. Retargeting fills them in while the path is built.
interface PathItem {
	invocationTarget: EventTarget;
	invocationTargetInShadowTree: boolean;
	shadowAdjustedTarget: EventTarget | null;
	relatedTarget: EventTarget | null;
	rootOfClosedTree: boolean;
	slotInClosedTree: boolean;
}

// The spec's internal slots and flags, kept in one object behind a module
// symbol because dispatch is a module function that reads and writes them
// for every target in the path.
export interface DispatchState {
	target: EventTarget | null;
	relatedTarget: EventTarget | null;
	currentTarget: EventTarget | null;
	eventPhase: number;
	path: PathItem[];
	initialized: boolean;
	dispatch: boolean;
	stopPropagation: boolean;
	stopImmediate: boolean;
	canceled: boolean;
	inPassiveListener: boolean;
	trusted: boolean;

	// True when the event is a platform event rather than one of ours. A
	// listener sets flags on the platform object, so dispatch reads them back
	// from the event after every listener call.
	foreign: boolean;
}

/** A dictionary argument per Web IDL: absent, null, or an object. */
export function toDictionary<
	T extends object,
>(value: unknown, what: string): T {
	if (value === undefined || value === null) {
		return {} as T;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		throw new TypeError(`${what} must be an object`);
	}
	return value as T;
}

// Events constructed here are instances of the global Event, and events
// constructed with the global Event dispatch through this DOM. Either
// kind works on both sides.
export const HostEvent = globalThis.Event as unknown as {
	new (type: string, eventInitDict?: EventInit): HostEventInstance;
	prototype: HostEventInstance;
};

// The members that dispatch owns are omitted because they are typed
// against the platform's EventTarget, and the targets here are this DOM's.
interface HostEventInstance
	extends Omit<
		globalThis.Event,
		"target" |
		"srcElement" |
		"currentTarget" |
		"composedPath" |
		"stopPropagation" |
		"stopImmediatePropagation" |
		"preventDefault" |
		"initEvent"
	> {
	stopPropagation(): void;
	stopImmediatePropagation(): void;
	preventDefault(): void;
	initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
}
const kState = Symbol("state");

// One accessor shared by every event and installed as an own property on
// each. The interface declares isTrusted unforgeable, so it cannot live on
// the prototype or be redefined.
function isTrustedGetter(this: Event): boolean {
	return this[kState].trusted;
}

const isTrustedProperty: PropertyDescriptor = {
	get: isTrustedGetter,
	enumerable: true,
	configurable: false,
};

// The prototype chain reaches the platform's Event, but the platform
// constructor never runs. Some platforms install isTrusted as an
// unforgeable own property that always reads false, and a user-agent
// dispatch here needs it to read true.
const EventBase = function EventBase(): void {} as unknown as {
	new (): HostEventInstance;
	prototype: HostEventInstance;
};

EventBase.prototype = Object.create(HostEvent.prototype) as HostEventInstance;

const kBubbles = Symbol("bubbles");
const kCancelable = Symbol("cancelable");
const kComposed = Symbol("composed");
const kTimeStamp = Symbol("timeStamp");
const kIsMouseEvent = Symbol("is a mouse event");

export interface Event {
	[kType]: string;
	[kBubbles]: boolean;
	[kCancelable]: boolean;
	[kComposed]: boolean;
	[kTimeStamp]: number;
	[kState]: DispatchState;
}

/** An event, plus the flags listeners set on it during dispatch. */
export class Event extends EventBase implements globalThis.Event {
	static readonly NONE = NONE;
	static readonly CAPTURING_PHASE = CAPTURING_PHASE;
	static readonly AT_TARGET = AT_TARGET;
	static readonly BUBBLING_PHASE = BUBBLING_PHASE;
	constructor(type: string, eventInitDict: EventInit = {}) {
		if (arguments.length < 1) {
			throw new TypeError("Event constructor needs a type");
		}
		// Convert the dictionary once, here. An accessor member is read exactly
		// once, by this conversion.
		const name = String(type);
		const init = toDictionary<EventInit>(eventInitDict, "An event init");
		const bubbles = Boolean(init.bubbles);
		const cancelable = Boolean(init.cancelable);
		const composed = Boolean(init.composed);
		super();
		this[kState] = {
			target: null,
			relatedTarget: null,
			currentTarget: null,
			eventPhase: NONE,
			path: [],
			initialized: false,
			dispatch: false,
			stopPropagation: false,
			stopImmediate: false,
			canceled: false,
			inPassiveListener: false,
			trusted: false,
			foreign: false,
		};
		this[kType] = name;
		this[kBubbles] = bubbles;
		this[kCancelable] = cancelable;
		this[kComposed] = composed;
		this[kTimeStamp] = performance.now();
		this[kState].initialized = true;
		Object.defineProperty(this, "isTrusted", isTrustedProperty);
	}

	override get type(): string {
		return this[kType];
	}

	// The members that dispatch owns (the path and the flags listeners set)
	// come from the state this DOM keeps. The flags are also written to the
	// platform base, so an event handed back to platform code reads the same
	// through either half of its interface.

	get target(): EventTarget | null {
		return this[kState].target;
	}

	get srcElement(): EventTarget | null {
		return this[kState].target;
	}

	get currentTarget(): EventTarget | null {
		return this[kState].currentTarget;
	}

	override get eventPhase(): number {
		return this[kState].eventPhase;
	}

	override get bubbles(): boolean {
		return this[kBubbles];
	}

	override get cancelable(): boolean {
		return this[kCancelable];
	}

	override get composed(): boolean {
		return this[kComposed];
	}

	override get defaultPrevented(): boolean {
		return this[kState].canceled;
	}

	override get timeStamp(): number {
		return this[kTimeStamp];
	}

	override get returnValue(): boolean {
		return !this[kState].canceled;
	}

	override set returnValue(value: boolean) {
		if (!value) {
			setCanceledFlag(this);
		}
	}

	override get cancelBubble(): boolean {
		return this[kState].stopPropagation;
	}

	override set cancelBubble(value: boolean) {
		if (value) {
			this[kState].stopPropagation = true;
		}
	}

	// Decides whether a "click" runs activation behavior. MouseEvent
	// overrides it.
	get [kIsMouseEvent](): boolean {
		return false;
	}

	composedPath(): EventTarget[] {
		return getComposedPath(this[kState]);
	}

	override stopPropagation(): void {
		this[kState].stopPropagation = true;
	}

	override stopImmediatePropagation(): void {
		this[kState].stopPropagation = true;
		this[kState].stopImmediate = true;
	}

	override preventDefault(): void {
		setCanceledFlag(this);
	}

	override initEvent(type: string, bubbles = false, cancelable = false): void {
		if (arguments.length < 1) {
			throw new TypeError("initEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this[kType] = String(type);
		this[kBubbles] = Boolean(bubbles);
		this[kCancelable] = Boolean(cancelable);
		this[kState].initialized = true;
		this[kState].stopPropagation = false;
		this[kState].stopImmediate = false;
		this[kState].canceled = false;
		this[kState].trusted = false;
		this[kState].target = null;
	}
}

Object.defineProperties(Event.prototype, {
	NONE: {value: NONE, enumerable: true},
	CAPTURING_PHASE: {value: CAPTURING_PHASE, enumerable: true},
	AT_TARGET: {value: AT_TARGET, enumerable: true},
	BUBBLING_PHASE: {value: BUBBLING_PHASE, enumerable: true},
	[Symbol.toStringTag]: {value: "Event", configurable: true},
});

/** Change the type dispatch uses for listener lookup, for the legacy pass. */
export function setEventType(event: Event, type: string): void {
	event[kType] = type;
}

/**
 * An event is canceled only if it is cancelable and no passive listener is
 * running.
 */
export function setCanceledFlag(event: Event): void {
	const state = event[kState];
	if (event.cancelable && !state.inPassiveListener) {
		state.canceled = true;
		// A platform event keeps its canceled flag on the platform object,
		// because that is where whoever passed it in will read it.
		if (state.foreign) {
			HostEvent.prototype.preventDefault.call(event);
		}
	}
}

// Walks outward from the current target. It stops crossing into a closed
// tree it did not start inside, and counts the closed roots and slots it
// passes.
function getComposedPath(state: DispatchState): EventTarget[] {
	const path = state.path;
	if (path.length === 0) {
		return [];
	}
	const currentTarget = state.currentTarget as EventTarget;
	const composed: EventTarget[] = [currentTarget];
	let currentTargetIndex = 0;
	let currentTargetHiddenSubtreeLevel = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) {
			currentTargetHiddenSubtreeLevel++;
		}
		if (path[index].invocationTarget === currentTarget) {
			currentTargetIndex = index;
			break;
		}
		if (path[index].slotInClosedTree) {
			currentTargetHiddenSubtreeLevel--;
		}
	}
	let currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	let maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) {
			currentHiddenLevel++;
		}
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.unshift(path[index].invocationTarget);
		}
		if (path[index].slotInClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel) {
				maxHiddenLevel = currentHiddenLevel;
			}
		}
	}
	currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex + 1; index < path.length; index++) {
		if (path[index].slotInClosedTree) {
			currentHiddenLevel++;
		}
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.push(path[index].invocationTarget);
		}
		if (path[index].rootOfClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel) {
				maxHiddenLevel = currentHiddenLevel;
			}
		}
	}
	return composed;
}

const kDetail = Symbol("detail");

// Extends this DOM's Event (which carries the dispatch state) rather than
// the platform's CustomEvent. An instance is a platform Event but not a
// platform CustomEvent.
export interface CustomEvent<T = any> {
	[kDetail]: T | null;
}

export class CustomEvent<T = any>
	extends Event
	implements globalThis.CustomEvent<T> {
	constructor(type: string, eventInitDict: CustomEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CustomEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this[kDetail] = init.detail ?? null;
	}

	// lib.dom types this as T even though it is null until an init sets it.
	// Every browser's types have the same problem.
	get detail(): T {
		return this[kDetail] as T;
	}

	initCustomEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		detail?: T,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCustomEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kDetail] = detail ?? null;
	}
}

Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, {
	value: "CustomEvent",
	configurable: true,
});

// The interface declares no constructor, so `new` throws for authors.
// Teardown treats two things as cancellation: preventDefault(), and a
// returnValue set to anything but the empty string.
export interface BeforeUnloadEvent {
	[kReturnValue]: string;
}

export class BeforeUnloadEvent extends Event {
	constructor(
		type = "beforeunload",
		eventInitDict: EventInit = {cancelable: true},
	) {
		super(type, eventInitDict);
		this[kReturnValue] = "";
		if (!isConstructingInternally()) {
			throw new TypeError("Illegal constructor");
		}
	}

	// Shadows Event's boolean returnValue with a DOMString. Typed `any`
	// because a narrower type is not assignable over the boolean it shadows.
	// The platform's own types do the same.
	override get returnValue(): any {
		return this[kReturnValue];
	}

	override set returnValue(value: any) {
		this[kReturnValue] = String(value);
	}
}

Object.defineProperty(BeforeUnloadEvent.prototype, Symbol.toStringTag, {
	value: "BeforeUnloadEvent",
	configurable: true,
});

interface MessageEventInit<T = any> extends EventInit {
	data?: T;
	origin?: string;
	lastEventId?: string;
	source?: globalThis.MessageEventSource | null;
	ports?: globalThis.MessagePort[];
}

const kErrorMessage = Symbol("error message");
const kErrorFilename = Symbol("error filename");
const kErrorLineno = Symbol("error lineno");
const kErrorColno = Symbol("error colno");
const kErrorValue = Symbol("error value");

export interface ErrorEvent {
	[kErrorMessage]: string;
	[kErrorFilename]: string;
	[kErrorLineno]: number;
	[kErrorColno]: number;
	[kErrorValue]: unknown;
}

export class ErrorEvent extends Event {
	constructor(type: string, eventInitDict: ErrorEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<ErrorEventInit>(eventInitDict, "An event init");
		this[kErrorMessage] = String(init.message ?? "");
		this[kErrorFilename] = String(init.filename ?? "");
		this[kErrorLineno] = toUnsignedLong(init.lineno ?? 0);
		this[kErrorColno] = toUnsignedLong(init.colno ?? 0);
		this[kErrorValue] = init.error;
	}

	get message(): string {
		return this[kErrorMessage];
	}

	get filename(): string {
		return this[kErrorFilename];
	}

	get lineno(): number {
		return this[kErrorLineno];
	}

	get colno(): number {
		return this[kErrorColno];
	}

	get error(): any {
		return this[kErrorValue];
	}
}

Object.defineProperty(ErrorEvent.prototype, Symbol.toStringTag, {
	value: "ErrorEvent",
	configurable: true,
});

const kMessageData = Symbol("message data");
const kOrigin = Symbol("origin");
const kLastEventId = Symbol("last event id");
const kMessageSource = Symbol("message source");
const kPorts = Symbol("ports");

// Nothing in a terminal posts one yet, but the interface is a constructor
// authors can call and createEvent can name, so it is implemented fully.
export interface MessageEvent<T = any> {
	[kMessageData]: T;
	[kOrigin]: string;
	[kLastEventId]: string;
	[kMessageSource]: globalThis.MessageEventSource | null;
	[kPorts]: readonly globalThis.MessagePort[];
}

export class MessageEvent<T = any> extends Event {
	constructor(type: string, eventInitDict: MessageEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<MessageEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this[kMessageData] = (init.data ?? null) as T;
		this[kOrigin] = String(init.origin ?? "");
		this[kLastEventId] = String(init.lastEventId ?? "");
		this[kMessageSource] = init.source ?? null;
		this[kPorts] = Object.freeze([...(init.ports ?? [])]);
	}

	get data(): T {
		return this[kMessageData];
	}

	get origin(): string {
		return this[kOrigin];
	}

	get lastEventId(): string {
		return this[kLastEventId];
	}

	get source(): globalThis.MessageEventSource | null {
		return this[kMessageSource];
	}

	get ports(): readonly globalThis.MessagePort[] {
		return this[kPorts];
	}

	initMessageEvent(
		type: string,
		bubbles?: boolean,
		cancelable?: boolean,
		data?: any,
		origin?: string,
		lastEventId?: string,
		source?: globalThis.MessageEventSource | null,
		ports?: globalThis.MessagePort[],
	): void;
	initMessageEvent(
		type: string,
		bubbles?: boolean,
		cancelable?: boolean,
		data?: any,
		origin?: string,
		lastEventId?: string,
		source?: globalThis.MessageEventSource | null,
		ports?: Iterable<globalThis.MessagePort>,
	): void;
	initMessageEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		data: any = null,
		origin = "",
		lastEventId = "",
		source: globalThis.MessageEventSource | null = null,
		ports: Iterable<globalThis.MessagePort> = [],
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initMessageEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kMessageData] = data;
		this[kOrigin] = String(origin);
		this[kLastEventId] = String(lastEventId);
		this[kMessageSource] = source;
		this[kPorts] = Object.freeze([...ports]);
	}
}

Object.defineProperty(MessageEvent.prototype, Symbol.toStringTag, {
	value: "MessageEvent",
	configurable: true,
});

interface HashChangeEventInit extends EventInit {
	oldURL?: string;
	newURL?: string;
}

const kOldURL = Symbol("old URL");
const kNewURL = Symbol("new URL");

export interface HashChangeEvent {
	[kOldURL]: string;
	[kNewURL]: string;
}

/** Fired when a document's fragment identifier changes. */
export class HashChangeEvent extends Event {
	constructor(type: string, eventInitDict: HashChangeEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<HashChangeEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kOldURL] = String(init.oldURL ?? "");
		this[kNewURL] = String(init.newURL ?? "");
	}

	get oldURL(): string {
		return this[kOldURL];
	}

	get newURL(): string {
		return this[kNewURL];
	}
}

Object.defineProperty(HashChangeEvent.prototype, Symbol.toStringTag, {
	value: "HashChangeEvent",
	configurable: true,
});

interface StorageEventInit extends EventInit {
	key?: string | null;
	oldValue?: string | null;
	newValue?: string | null;
	url?: string | URL;
	storageArea?: globalThis.Storage | null;
}

const kStorageKey = Symbol("storage key");
const kStorageOldValue = Symbol("storage old value");
const kStorageNewValue = Symbol("storage new value");
const kStorageURL = Symbol("storage url");
const kStorageArea = Symbol("storage area");

// There is no storage area in a terminal, but the interface is a
// constructor authors can call and createEvent can name.
export interface StorageEvent {
	[kStorageKey]: string | null;
	[kStorageOldValue]: string | null;
	[kStorageNewValue]: string | null;
	[kStorageURL]: string;
	[kStorageArea]: globalThis.Storage | null;
}

export class StorageEvent extends Event {
	constructor(type: string, eventInitDict: StorageEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<StorageEventInit>(eventInitDict, "An event init");
		this[kStorageKey] = init.key == null ? null : String(init.key);
		this[kStorageOldValue] =
			init.oldValue == null ? null : String(init.oldValue);
		this[kStorageNewValue] =
			init.newValue == null ? null : String(init.newValue);
		this[kStorageURL] = String(init.url ?? "");
		this[kStorageArea] = init.storageArea ?? null;
	}

	get key(): string | null {
		return this[kStorageKey];
	}

	get oldValue(): string | null {
		return this[kStorageOldValue];
	}

	get newValue(): string | null {
		return this[kStorageNewValue];
	}

	get url(): string {
		return this[kStorageURL];
	}

	get storageArea(): globalThis.Storage | null {
		return this[kStorageArea];
	}

	initStorageEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		key: string | null = null,
		oldValue: string | null = null,
		newValue: string | null = null,
		url: string | URL = "",
		storageArea: globalThis.Storage | null = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initStorageEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kStorageKey] = key == null ? null : String(key);
		this[kStorageOldValue] = oldValue == null ? null : String(oldValue);
		this[kStorageNewValue] = newValue == null ? null : String(newValue);
		this[kStorageURL] = String(url);
		this[kStorageArea] = storageArea ?? null;
	}
}

Object.defineProperty(StorageEvent.prototype, Symbol.toStringTag, {
	value: "StorageEvent",
	configurable: true,
});

interface UIEventInit extends EventInit {
	view?: globalThis.Window | null;
	detail?: number;
	which?: number;
}

interface EventModifierInit extends UIEventInit {
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	modifierAltGraph?: boolean;
	modifierCapsLock?: boolean;
	modifierFn?: boolean;
	modifierFnLock?: boolean;
	modifierHyper?: boolean;
	modifierNumLock?: boolean;
	modifierScrollLock?: boolean;
	modifierSuper?: boolean;
	modifierSymbol?: boolean;
	modifierSymbolLock?: boolean;
}

interface MouseEventInit extends EventModifierInit {
	screenX?: number;
	screenY?: number;
	clientX?: number;
	clientY?: number;
	movementX?: number;
	movementY?: number;
	button?: number;
	buttons?: number;
	relatedTarget?: EventTarget | null;
}

interface FocusEventInit extends UIEventInit {
	relatedTarget?: EventTarget | null;
}

interface KeyboardEventInit extends EventModifierInit {
	key?: string;
	code?: string;
	location?: number;
	repeat?: boolean;
	isComposing?: boolean;
	charCode?: number;
	keyCode?: number;
}

interface CompositionEventInit extends UIEventInit {
	data?: string;
}

interface InputEventInit extends UIEventInit {
	data?: string | null;
	isComposing?: boolean;
	inputType?: string;
}

interface WheelEventInit extends MouseEventInit {
	deltaX?: number;
	deltaY?: number;
	deltaZ?: number;
	deltaMode?: number;
}

/** Convert to a WebIDL long: truncate and wrap into 32 signed bits. */
export function toLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	return Math.trunc(number) | 0;
}

/** Convert to a WebIDL double: any finite number; throw for the rest. */
export function toDouble(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new TypeError("That value is not a finite double");
	}
	return number;
}

/** Convert an EventTarget? argument per Web IDL: null or an event target. */
function toEventTarget(value: unknown): EventTarget | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!(value instanceof EventTarget)) {
		throw new TypeError("That is not an event target");
	}
	return value;
}

/** The modifier key names an event's init dictionary sets. */
function getInitModifiers(init: EventModifierInit): Set<string> {
	const modifiers = new Set<string>();
	if (init.ctrlKey) {
		modifiers.add("Control");
	}
	if (init.shiftKey) {
		modifiers.add("Shift");
	}
	if (init.altKey) {
		modifiers.add("Alt");
	}
	if (init.metaKey) {
		modifiers.add("Meta");
	}
	if (init.modifierAltGraph) {
		modifiers.add("AltGraph");
	}
	if (init.modifierCapsLock) {
		modifiers.add("CapsLock");
	}
	if (init.modifierFn) {
		modifiers.add("Fn");
	}
	if (init.modifierFnLock) {
		modifiers.add("FnLock");
	}
	if (init.modifierHyper) {
		modifiers.add("Hyper");
	}
	if (init.modifierNumLock) {
		modifiers.add("NumLock");
	}
	if (init.modifierScrollLock) {
		modifiers.add("ScrollLock");
	}
	if (init.modifierSuper) {
		modifiers.add("Super");
	}
	if (init.modifierSymbol) {
		modifiers.add("Symbol");
	}
	if (init.modifierSymbolLock) {
		modifiers.add("SymbolLock");
	}
	return modifiers;
}

const kWhich = Symbol("which");

// `view` is always null here because a window is not the global object.
// An init that passes one is a type error, not a value silently dropped.
export interface UIEvent {
	[kDetail]: number;
	[kWhich]: number;
}

export class UIEvent extends Event {
	constructor(type: string, eventInitDict: UIEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<UIEventInit>(eventInitDict, "An event init");
		if (init.view !== undefined && init.view !== null) {
			throw new TypeError("There is no window for an event to come through");
		}
		this[kDetail] = toLong(init.detail ?? 0);
		this[kWhich] = toUnsignedLong(init.which ?? 0);
	}

	get view(): globalThis.Window | null {
		return null;
	}

	get detail(): number {
		return this[kDetail];
	}

	get which(): number {
		return this[kWhich];
	}

	initUIEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		detail = 0,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initUIEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		if (view !== undefined && view !== null) {
			throw new TypeError("There is no window for an event to come through");
		}
		this[kDetail] = toLong(detail);
	}
}

Object.defineProperty(UIEvent.prototype, Symbol.toStringTag, {
	value: "UIEvent",
	configurable: true,
});

const kScreenX = Symbol("screenX");
const kScreenY = Symbol("screenY");
const kClientX = Symbol("clientX");
const kMovementX = Symbol("movementX");
const kMovementY = Symbol("movementY");
const kEventView = Symbol("eventView");
const kTargetRect = Symbol("targetRect");
const kClientY = Symbol("clientY");
const kButton = Symbol("button");
const kButtons = Symbol("buttons");
const kModifiers = Symbol("modifiers");

// Dispatch runs activation behavior for a click that is a MouseEvent.
// [kIsMouseEvent] is how it checks.
export interface MouseEvent {
	[kScreenX]: number;
	[kScreenY]: number;
	[kClientX]: number;
	[kClientY]: number;
	[kButton]: number;
	[kButtons]: number;
	[kMovementX]: number;
	[kMovementY]: number;
	[kModifiers]: Set<string>;
}

export class MouseEvent extends UIEvent implements globalThis.MouseEvent {
	constructor(type: string, eventInitDict: MouseEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<MouseEventInit>(eventInitDict, "An event init");
		this[kScreenX] = toLong(init.screenX ?? 0);
		this[kScreenY] = toLong(init.screenY ?? 0);
		this[kClientX] = toLong(init.clientX ?? 0);
		this[kClientY] = toLong(init.clientY ?? 0);
		this[kMovementX] = toLong(init.movementX ?? 0);
		this[kMovementY] = toLong(init.movementY ?? 0);
		this[kButton] = toShort(init.button ?? 0);
		this[kButtons] = toUnsignedShort(init.buttons ?? 0);
		this[kModifiers] = getInitModifiers(init);
		this[kState].relatedTarget = toEventTarget(init.relatedTarget);
	}

	get screenX(): number {
		return this[kScreenX];
	}

	get screenY(): number {
		return this[kScreenY];
	}

	get clientX(): number {
		return this[kClientX];
	}

	get clientY(): number {
		return this[kClientY];
	}

	/** Aliases of clientX/clientY, per CSSOM View. */
	get x(): number {
		return this[kClientX];
	}

	get y(): number {
		return this[kClientY];
	}

	// Client coordinates plus the document scroll, read live. Dispatch is
	// synchronous, so a listener sees the scroll the event was created under.
	get pageX(): number {
		return this[kClientX] + (this[kEventView]?.scrollX ?? 0);
	}

	get pageY(): number {
		return this[kClientY] + (this[kEventView]?.scrollY ?? 0);
	}

	// Client coordinates relative to the target's box. Uses the border edge
	// where the spec says padding edge, a one-cell difference.
	get offsetX(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientX] : this[kClientX] - rect.left;
	}

	get offsetY(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientY] : this[kClientY] - rect.top;
	}

	// Pre-standard, no spec. Browsers report the offset from the nearest
	// positioned ancestor, which for an unpositioned target is what
	// offsetX/offsetY already return.
	get layerX(): number {
		return this.offsetX;
	}

	get layerY(): number {
		return this.offsetY;
	}

	get movementX(): number {
		return this[kMovementX];
	}

	get movementY(): number {
		return this[kMovementY];
	}

	get ctrlKey(): boolean {
		return this[kModifiers].has("Control");
	}

	get shiftKey(): boolean {
		return this[kModifiers].has("Shift");
	}

	get altKey(): boolean {
		return this[kModifiers].has("Alt");
	}

	get metaKey(): boolean {
		return this[kModifiers].has("Meta");
	}

	get button(): number {
		return this[kButton];
	}

	get buttons(): number {
		return this[kButtons];
	}

	get relatedTarget(): EventTarget | null {
		return this[kState].relatedTarget;
	}

	override get which(): number {
		return this[kButton] + 1;
	}

	override get [kIsMouseEvent](): boolean {
		return true;
	}

	/** The scroll offsets of the window the target renders in, or null. */
	get [kEventView](): {scrollX: number; scrollY: number} | null {
		const target = this[kState].target as Node | null;
		if (target === null || target.ownerDocument === null) {
			return null;
		}
		const view = target.ownerDocument.defaultView as Window | null;
		return (view ?? null) as {scrollX: number; scrollY: number} | null;
	}

	/**
	 * The target's viewport-space rect, or null if no engine can measure it.
	 */
	get [kTargetRect](): {left: number; top: number} | null {
		const target = this[kState].target as Element | null;
		if (
			target === null ||
			typeof (target as {getBoundingClientRect?: unknown})
				.getBoundingClientRect !== "function"
		) {
			return null;
		}
		return target.getBoundingClientRect();
	}

	getModifierState(keyArg: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("getModifierState needs a key");
		}
		return this[kModifiers].has(String(keyArg));
	}

	initMouseEvent(
		type: string,
		bubbles: boolean,
		cancelable: boolean,
		view: globalThis.Window,
		detail: number,
		screenX: number,
		screenY: number,
		clientX: number,
		clientY: number,
		ctrlKey: boolean,
		altKey: boolean,
		shiftKey: boolean,
		metaKey: boolean,
		button: number,
		relatedTarget: globalThis.EventTarget | null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initMouseEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, detail);
		this[kScreenX] = toLong(screenX);
		this[kScreenY] = toLong(screenY);
		this[kClientX] = toLong(clientX);
		this[kClientY] = toLong(clientY);
		this[kModifiers] = getInitModifiers({ctrlKey, altKey, shiftKey, metaKey});
		this[kButton] = toShort(button);
		this[kState].relatedTarget = toEventTarget(relatedTarget);
	}
}

Object.defineProperty(MouseEvent.prototype, Symbol.toStringTag, {
	value: "MouseEvent",
	configurable: true,
});

/** Convert to a WebIDL short: the long, wrapped into 16 signed bits. */
function toShort(value: unknown): number {
	return (toLong(value) << 16) >> 16;
}

/** Fired when focus moves. relatedTarget is the element on the other side. */
export class FocusEvent extends UIEvent {
	constructor(type: string, eventInitDict: FocusEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<FocusEventInit>(eventInitDict, "An event init");
		this[kState].relatedTarget = toEventTarget(init.relatedTarget);
	}

	get relatedTarget(): EventTarget | null {
		return this[kState].relatedTarget;
	}
}

Object.defineProperty(FocusEvent.prototype, Symbol.toStringTag, {
	value: "FocusEvent",
	configurable: true,
});

const DOM_KEY_LOCATION_STANDARD = 0;
const DOM_KEY_LOCATION_LEFT = 1;
const DOM_KEY_LOCATION_RIGHT = 2;
const DOM_KEY_LOCATION_NUMPAD = 3;

const kKey = Symbol("key");
const kCode = Symbol("code");
const kLocation = Symbol("location");
const kRepeat = Symbol("repeat");
const kIsComposing = Symbol("isComposing");
const kCharCode = Symbol("charCode");
const kKeyCode = Symbol("keyCode");

/** The key-location constants, installed on the prototype. */
export interface KeyboardEvent {
	[kKey]: string;
	[kCode]: string;
	[kLocation]: number;
	[kRepeat]: boolean;
	[kIsComposing]: boolean;
	[kCharCode]: number;
	[kKeyCode]: number;
	[kModifiers]: Set<string>;
}

/** A key event, identified by the character it types and the physical key. */
export class KeyboardEvent extends UIEvent implements globalThis.KeyboardEvent {
	static readonly DOM_KEY_LOCATION_STANDARD = DOM_KEY_LOCATION_STANDARD;
	static readonly DOM_KEY_LOCATION_LEFT = DOM_KEY_LOCATION_LEFT;
	static readonly DOM_KEY_LOCATION_RIGHT = DOM_KEY_LOCATION_RIGHT;
	static readonly DOM_KEY_LOCATION_NUMPAD = DOM_KEY_LOCATION_NUMPAD;
	declare readonly DOM_KEY_LOCATION_STANDARD: globalThis.KeyboardEvent["DOM_KEY_LOCATION_STANDARD"];
	declare readonly DOM_KEY_LOCATION_LEFT: globalThis.KeyboardEvent["DOM_KEY_LOCATION_LEFT"];
	declare readonly DOM_KEY_LOCATION_RIGHT: globalThis.KeyboardEvent["DOM_KEY_LOCATION_RIGHT"];
	declare readonly DOM_KEY_LOCATION_NUMPAD: globalThis.KeyboardEvent["DOM_KEY_LOCATION_NUMPAD"];
	constructor(type: string, eventInitDict: KeyboardEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<KeyboardEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kKey] = String(init.key ?? "");
		this[kCode] = String(init.code ?? "");
		this[kLocation] = toUnsignedLong(init.location ?? 0);
		this[kRepeat] = Boolean(init.repeat);
		this[kIsComposing] = Boolean(init.isComposing);
		this[kCharCode] = toUnsignedLong(init.charCode ?? 0);
		this[kKeyCode] = toUnsignedLong(init.keyCode ?? 0);
		this[kModifiers] = getInitModifiers(init);
	}

	get key(): string {
		return this[kKey];
	}

	get code(): string {
		return this[kCode];
	}

	get location(): number {
		return this[kLocation];
	}

	get ctrlKey(): boolean {
		return this[kModifiers].has("Control");
	}

	get shiftKey(): boolean {
		return this[kModifiers].has("Shift");
	}

	get altKey(): boolean {
		return this[kModifiers].has("Alt");
	}

	get metaKey(): boolean {
		return this[kModifiers].has("Meta");
	}

	get repeat(): boolean {
		return this[kRepeat];
	}

	get isComposing(): boolean {
		return this[kIsComposing];
	}

	get charCode(): number {
		return this[kCharCode];
	}

	get keyCode(): number {
		return this[kKeyCode];
	}

	override get which(): number {
		return this[kKeyCode];
	}

	getModifierState(keyArg: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("getModifierState needs a key");
		}
		return this[kModifiers].has(String(keyArg));
	}

	initKeyboardEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		key = "",
		location = 0,
		ctrlKey = false,
		altKey = false,
		shiftKey = false,
		metaKey = false,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initKeyboardEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kKey] = String(key);
		this[kLocation] = toUnsignedLong(location);
		this[kModifiers] = getInitModifiers({ctrlKey, altKey, shiftKey, metaKey});
	}
}

Object.defineProperties(KeyboardEvent.prototype, {
	DOM_KEY_LOCATION_STANDARD: {
		value: DOM_KEY_LOCATION_STANDARD,
		enumerable: true,
	},
	DOM_KEY_LOCATION_LEFT: {value: DOM_KEY_LOCATION_LEFT, enumerable: true},
	DOM_KEY_LOCATION_RIGHT: {value: DOM_KEY_LOCATION_RIGHT, enumerable: true},
	DOM_KEY_LOCATION_NUMPAD: {value: DOM_KEY_LOCATION_NUMPAD, enumerable: true},
	[Symbol.toStringTag]: {value: "KeyboardEvent", configurable: true},
});

export interface CompositionEvent {
	[kData]: string;
}

/** Fired while an input method composes text. */
export class CompositionEvent extends UIEvent {
	constructor(type: string, eventInitDict: CompositionEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CompositionEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kData] = String(init.data ?? "");
	}

	get data(): string {
		return this[kData];
	}

	initCompositionEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCompositionEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kData] = String(data);
	}
}

Object.defineProperty(CompositionEvent.prototype, Symbol.toStringTag, {
	value: "CompositionEvent",
	configurable: true,
});

// DOM Level 3's legacy text-input event. The interface declares no
// constructor, so createEvent("TextEvent") is the only way to make one.
export interface TextEvent {
	[kData]: string;
}

export class TextEvent extends UIEvent {
	constructor(type = "", eventInitDict: UIEventInit = {}) {
		super(type, eventInitDict);
		this[kData] = "";
		if (!isConstructingInternally()) {
			throw new TypeError("Illegal constructor");
		}
	}

	get data(): string {
		return this[kData];
	}

	initTextEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initTextEvent needs a type");
		}
		if (this[kState].dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kData] = String(data);
	}
}

Object.defineProperty(TextEvent.prototype, Symbol.toStringTag, {
	value: "TextEvent",
	configurable: true,
});

const kInputType = Symbol("inputType");

export interface InputEvent {
	[kData]: string | null;
	[kIsComposing]: boolean;
	[kInputType]: string;
}

/** Fired when an editing host's text changes, with the kind of change. */
export class InputEvent extends UIEvent {
	constructor(type: string, eventInitDict: InputEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<InputEventInit>(eventInitDict, "An event init");
		this[kData] =
			init.data === undefined || init.data === null ? null : String(init.data);
		this[kIsComposing] = Boolean(init.isComposing);
		this[kInputType] = String(init.inputType ?? "");
	}

	get data(): string | null {
		return this[kData];
	}

	get isComposing(): boolean {
		return this[kIsComposing];
	}

	get inputType(): string {
		return this[kInputType];
	}

	get dataTransfer(): globalThis.DataTransfer | null {
		return null;
	}

	getTargetRanges(): globalThis.StaticRange[] {
		return [];
	}
}

Object.defineProperty(InputEvent.prototype, Symbol.toStringTag, {
	value: "InputEvent",
	configurable: true,
});

// A transfer here carries text under format names and nothing else. There
// is no drag and drop in a terminal and no files to hand over, so
// `dropEffect`, `effectAllowed`, `setDragImage()` and `files` exist,
// return what the interface specifies, and do nothing.

// The platform's two shorthands map to the media types they stand for,
// so `"TEXT/Plain "` and `"text"` name the same entry.
function normalizeTransferFormat(format: unknown): string {
	const name = String(format).trim().toLowerCase();
	if (name === "text") {
		return "text/plain";
	}
	if (name === "url") {
		return "text/uri-list";
	}
	return name;
}

/** The brand used to construct an interface that declares no constructor. */
const kInternalConstruction = Symbol("internal construction");

export class FileList {
	readonly [index: number]: globalThis.File;
	get length(): number {
		return 0;
	}

	item(_index: number): globalThis.File | null {
		return null;
	}

	* [Symbol.iterator](): Generator<never, void, unknown> {}
}

Object.defineProperty(FileList.prototype, Symbol.toStringTag, {
	value: "FileList",
	configurable: true,
});

const kItemType = Symbol("type");
const kItemData = Symbol("data");

export interface DataTransferItem {
	[kItemType]: string;
	[kItemData]: string;
}

/** One entry of a transfer: a string under a format name. */
export class DataTransferItem {
	constructor(brand?: unknown, type?: string, data?: string) {
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kItemType] = String(type);
		this[kItemData] = String(data);
	}

	get kind(): string {
		return "string";
	}

	get type(): string {
		return this[kItemType];
	}

	getAsString(callback: globalThis.FunctionStringCallback | null): void {
		if (callback === null || callback === undefined) {
			return;
		}
		if (typeof callback !== "function") {
			throw new TypeError("getAsString needs a function");
		}
		const data = this[kItemData];
		queueMicrotask(() => {
			(callback as (data: string) => void)(data);
		});
	}

	getAsFile(): globalThis.File | null {
		return null;
	}

	webkitGetAsEntry(): globalThis.FileSystemEntry | null {
		return null;
	}
}

Object.defineProperty(DataTransferItem.prototype, Symbol.toStringTag, {
	value: "DataTransferItem",
	configurable: true,
});

const kListOwner = Symbol("owner");
const kListIndices = Symbol("indices");
const kTransferMode = Symbol("mode");

const kTransferEntries = Symbol("entries");

/** The entries of a transfer, as an indexed, mutable list. */
export interface DataTransferItemList {
	[kListOwner]: DataTransfer;
	[kListIndices]: number;
}

export class DataTransferItemList {
	readonly [index: number]: DataTransferItem;
	constructor(brand?: unknown, owner?: DataTransfer) {
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kListOwner] = owner as DataTransfer;
		this[kListIndices] = 0;
	}

	get length(): number {
		return this[kListOwner][kTransferEntries].size;
	}

	add(data: string, type: string): DataTransferItem | null;
	add(data: globalThis.File): DataTransferItem | null;
	add(data: string | globalThis.File, type?: string): DataTransferItem | null {
		const owner = this[kListOwner];
		if (owner[kTransferMode] !== "readwrite") {
			return null;
		}
		if (type === undefined) {
			throw new TypeError("Adding a string entry needs a format");
		}
		const format = normalizeTransferFormat(type);
		if (owner[kTransferEntries].has(format)) {
			throw domError(
				"NotSupportedError",
				`The transfer already carries a ${format} entry`,
			);
		}
		owner[kTransferEntries].set(format, String(data));
		syncTransferItems(owner);
		return (this as unknown as Record<number, DataTransferItem>)[
			owner[kTransferEntries].size - 1
		];
	}

	remove(index: number): void {
		const owner = this[kListOwner];
		if (owner[kTransferMode] !== "readwrite") {
			throw domError("InvalidStateError", "That transfer cannot be modified");
		}
		const formats = Array.from(owner[kTransferEntries].keys());
		const at = toLong(index);
		if (at < 0 || at >= formats.length) {
			return;
		}
		owner[kTransferEntries].delete(formats[at]);
		syncTransferItems(owner);
	}

	clear(): void {
		const owner = this[kListOwner];
		if (owner[kTransferMode] !== "readwrite") {
			return;
		}
		owner[kTransferEntries].clear();
		syncTransferItems(owner);
	}
}

Object.defineProperty(DataTransferItemList.prototype, Symbol.toStringTag, {
	value: "DataTransferItemList",
	configurable: true,
});

const kTransferItems = Symbol("items");

/** Update a list's indexed properties to match the entries behind it. */
function syncTransferItems(transfer: DataTransfer): void {
	const list = transfer[kTransferItems] as unknown as Record<number, unknown>;
	const formats = Array.from(transfer[kTransferEntries].keys());
	for (let i = 0; i < transfer[kTransferItems][kListIndices]; i++) {
		delete list[i];
	}
	for (let i = 0; i < formats.length; i++) {
		Object.defineProperty(list, i, {
			value: new DataTransferItem(
				kInternalConstruction,
				formats[i],
				transfer[kTransferEntries].get(formats[i]),
			),
			configurable: true,
			enumerable: true,
		});
	}
	transfer[kTransferItems][kListIndices] = formats.length;
}

const kTransferFiles = Symbol("files");
const EFFECTS_ALLOWED = new Set([
	"none",
	"copy",
	"copyLink",
	"copyMove",
	"link",
	"linkMove",
	"move",
	"all",
	"uninitialized",
]);

const kDropEffect = Symbol("dropEffect");
const kEffectAllowed = Symbol("effectAllowed");

export interface DataTransfer {
	[kTransferEntries]: Map<string, string>;
	[kTransferItems]: DataTransferItemList;
	[kTransferFiles]: FileList;
	[kTransferMode]: "readwrite" | "readonly" | "protected";
	[kDropEffect]: "none" | "copy" | "link" | "move";
	[kEffectAllowed]: "none" |
		"copy" |
		"copyLink" |
		"copyMove" |
		"link" |
		"linkMove" |
		"move" |
		"all" |
		"uninitialized";
}

/** The payload a clipboard event carries: text under format names. */
export class DataTransfer {
	constructor() {
		this[kTransferEntries] = new Map();
		this[kTransferItems] = new DataTransferItemList(
			kInternalConstruction,
			this,
		);
		this[kTransferFiles] = new FileList();
		this[kTransferMode] = "readwrite";
		this[kDropEffect] = "none";
		this[kEffectAllowed] = "uninitialized";
	}

	get dropEffect(): "none" | "copy" | "link" | "move" {
		return this[kDropEffect];
	}

	set dropEffect(value: "none" | "copy" | "link" | "move") {
		const effect = String(value);
		if (["none", "copy", "link", "move"].includes(effect)) {
			this[kDropEffect] = effect as "none" | "copy" | "link" | "move";
		}
	}

	get effectAllowed():
		"none" |
		"copy" |
		"copyLink" |
		"copyMove" |
		"link" |
		"linkMove" |
		"move" |
		"all" |
		"uninitialized" {
		return this[kEffectAllowed];
	}

	set effectAllowed(
		value:
			"none" |
			"copy" |
			"copyLink" |
			"copyMove" |
			"link" |
			"linkMove" |
			"move" |
			"all" |
			"uninitialized",
	) {
		const effect = String(value);
		if (EFFECTS_ALLOWED.has(effect)) {
			this[kEffectAllowed] = effect as typeof value;
		}
	}

	get items(): DataTransferItemList {
		return this[kTransferItems];
	}

	get types(): readonly string[] {
		if (this[kTransferMode] === "protected") {
			return Object.freeze([]);
		}
		return Object.freeze(Array.from(this[kTransferEntries].keys()));
	}

	get files(): FileList {
		return this[kTransferFiles];
	}

	setDragImage(_image: globalThis.Element, _x: number, _y: number): void {}

	getData(format: string): string {
		if (this[kTransferMode] === "protected") {
			return "";
		}
		return this[kTransferEntries].get(normalizeTransferFormat(format)) ?? "";
	}

	setData(format: string, data: string): void {
		if (this[kTransferMode] !== "readwrite") {
			return;
		}
		this[kTransferEntries].set(normalizeTransferFormat(format), String(data));
		syncTransferItems(this);
	}

	clearData(format?: string): void {
		if (this[kTransferMode] !== "readwrite") {
			return;
		}
		if (format === undefined) {
			this[kTransferEntries].clear();
		} else {
			this[kTransferEntries].delete(normalizeTransferFormat(format));
		}
		syncTransferItems(this);
	}
}

Object.defineProperty(DataTransfer.prototype, Symbol.toStringTag, {
	value: "DataTransfer",
	configurable: true,
});

/**
 * Put a transfer into the read-only mode `paste` gives its listeners.
 * Listeners can read the text but cannot change the clipboard through the
 * event.
 */
export function lockDataTransfer(transfer: DataTransfer): void {
	transfer[kTransferMode] = "readonly";
}

// Listeners can read a clipboard event's payload only while the event is
// dispatching, as in a browser. This is for conformance, not security: an
// app can still read the clipboard through navigator.clipboard.
export function protectClipboardData(event: Event): void {
	if (!(event instanceof ClipboardEvent)) {
		return;
	}
	const transfer = event.clipboardData;
	if (transfer !== null) {
		transfer[kTransferMode] = "protected";
	}
}

interface ClipboardEventInit extends EventInit {
	clipboardData?: DataTransfer | null;
}

const kClipboardData = Symbol("clipboardData");

export interface ClipboardEvent {
	[kClipboardData]: DataTransfer | null;
}

/** Fired for a clipboard gesture, carrying the data it moves. */
export class ClipboardEvent extends Event {
	constructor(type: string, eventInitDict: ClipboardEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<ClipboardEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kClipboardData] =
			init.clipboardData === undefined || init.clipboardData === null
				? null
				: init.clipboardData;
	}

	get clipboardData(): DataTransfer | null {
		return this[kClipboardData];
	}
}

Object.defineProperty(ClipboardEvent.prototype, Symbol.toStringTag, {
	value: "ClipboardEvent",
	configurable: true,
});

interface TransitionEventInit extends EventInit {
	propertyName?: string;
	elapsedTime?: number;
	pseudoElement?: string;
}

const kPropertyName = Symbol("propertyName");
const kElapsedTime = Symbol("elapsedTime");
const kEventPseudoElement = Symbol("pseudoElement");

export interface TransitionEvent {
	[kPropertyName]: string;
	[kElapsedTime]: number;
	[kEventPseudoElement]: string;
}

/** Fired when a CSS transition changes phase (css-transitions-1 §6). */
export class TransitionEvent extends Event {
	constructor(type: string, eventInitDict: TransitionEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<TransitionEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kPropertyName] =
			init.propertyName === undefined ? "" : String(init.propertyName);
		this[kElapsedTime] =
			init.elapsedTime === undefined ? 0 : Number(init.elapsedTime);
		this[kEventPseudoElement] =
			init.pseudoElement === undefined ? "" : String(init.pseudoElement);
	}

	get propertyName(): string {
		return this[kPropertyName];
	}

	get elapsedTime(): number {
		return this[kElapsedTime];
	}

	get pseudoElement(): string {
		return this[kEventPseudoElement];
	}
}

Object.defineProperty(TransitionEvent.prototype, Symbol.toStringTag, {
	value: "TransitionEvent",
	configurable: true,
});

interface AnimationEventInit extends EventInit {
	animationName?: string;
	elapsedTime?: number;
	pseudoElement?: string;
}

const kAnimationName = Symbol("animationName");

// css-animations-1 §4. The engine does not run @keyframes animations
// yet. The interface exists because the platform defines it.
export interface AnimationEvent {
	[kAnimationName]: string;
	[kElapsedTime]: number;
	[kEventPseudoElement]: string;
}

export class AnimationEvent extends Event {
	constructor(type: string, eventInitDict: AnimationEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<AnimationEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kAnimationName] =
			init.animationName === undefined ? "" : String(init.animationName);
		this[kElapsedTime] =
			init.elapsedTime === undefined ? 0 : Number(init.elapsedTime);
		this[kEventPseudoElement] =
			init.pseudoElement === undefined ? "" : String(init.pseudoElement);
	}

	get animationName(): string {
		return this[kAnimationName];
	}

	get elapsedTime(): number {
		return this[kElapsedTime];
	}

	get pseudoElement(): string {
		return this[kEventPseudoElement];
	}
}

Object.defineProperty(AnimationEvent.prototype, Symbol.toStringTag, {
	value: "AnimationEvent",
	configurable: true,
});

const DOM_DELTA_PIXEL = 0x00;
const DOM_DELTA_LINE = 0x01;
const DOM_DELTA_PAGE = 0x02;

const kDeltaX = Symbol("deltaX");
const kDeltaY = Symbol("deltaY");
const kDeltaZ = Symbol("deltaZ");
const kDeltaMode = Symbol("deltaMode");

export interface WheelEvent {
	[kDeltaX]: number;
	[kDeltaY]: number;
	[kDeltaZ]: number;
	[kDeltaMode]: number;
}

/** Fired when the wheel turns over a target. */
export class WheelEvent extends MouseEvent {
	static readonly DOM_DELTA_PIXEL = DOM_DELTA_PIXEL;
	static readonly DOM_DELTA_LINE = DOM_DELTA_LINE;
	static readonly DOM_DELTA_PAGE = DOM_DELTA_PAGE;
	declare readonly DOM_DELTA_PIXEL: 0;
	declare readonly DOM_DELTA_LINE: 1;
	declare readonly DOM_DELTA_PAGE: 2;
	constructor(type: string, eventInitDict: WheelEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<WheelEventInit>(eventInitDict, "An event init");
		this[kDeltaX] = toDouble(init.deltaX ?? 0);
		this[kDeltaY] = toDouble(init.deltaY ?? 0);
		this[kDeltaZ] = toDouble(init.deltaZ ?? 0);
		this[kDeltaMode] = toUnsignedLong(init.deltaMode ?? 0);
	}

	get deltaX(): number {
		return this[kDeltaX];
	}

	get deltaY(): number {
		return this[kDeltaY];
	}

	get deltaZ(): number {
		return this[kDeltaZ];
	}

	get deltaMode(): number {
		return this[kDeltaMode];
	}
}

Object.defineProperties(WheelEvent.prototype, {
	DOM_DELTA_PIXEL: {value: DOM_DELTA_PIXEL, enumerable: true},
	DOM_DELTA_LINE: {value: DOM_DELTA_LINE, enumerable: true},
	DOM_DELTA_PAGE: {value: DOM_DELTA_PAGE, enumerable: true},
	[Symbol.toStringTag]: {value: "WheelEvent", configurable: true},
});

interface PointerEventInit extends MouseEventInit {
	pointerId?: number;
	width?: number;
	height?: number;
	pressure?: number;
	tangentialPressure?: number;
	tiltX?: number;
	tiltY?: number;
	twist?: number;
	altitudeAngle?: number;
	azimuthAngle?: number;
	pointerType?: string;
	isPrimary?: boolean;
	coalescedEvents?: PointerEvent[];
	predictedEvents?: PointerEvent[];
}

const kPointerId = Symbol("pointerId");
const kWidth = Symbol("width");
const kHeight = Symbol("height");
const kPressure = Symbol("pressure");
const kTangentialPressure = Symbol("tangentialPressure");
const kTiltX = Symbol("tiltX");
const kTiltY = Symbol("tiltY");
const kTwist = Symbol("twist");
const kAltitudeAngle = Symbol("altitudeAngle");
const kAzimuthAngle = Symbol("azimuthAngle");
const kPointerType = Symbol("pointerType");
const kIsPrimary = Symbol("isPrimary");
const kCoalesced = Symbol("coalesced");
const kPredicted = Symbol("predicted");

// `element.click()` fires one of these. It is a MouseEvent, so dispatch
// runs any activation behavior it reaches.
export interface PointerEvent {
	[kPointerId]: number;
	[kWidth]: number;
	[kHeight]: number;
	[kPressure]: number;
	[kTangentialPressure]: number;
	[kTiltX]: number | null;
	[kTiltY]: number | null;
	[kTwist]: number;
	[kAltitudeAngle]: number | null;
	[kAzimuthAngle]: number | null;
	[kPointerType]: string;
	[kIsPrimary]: boolean;
	[kCoalesced]: PointerEvent[];
	[kPredicted]: PointerEvent[];
}

export class PointerEvent extends MouseEvent {
	constructor(type: string, eventInitDict: PointerEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<PointerEventInit>(eventInitDict, "An event init");
		this[kPointerId] = toLong(init.pointerId ?? 0);
		this[kWidth] = toDouble(init.width ?? 1);
		this[kHeight] = toDouble(init.height ?? 1);
		this[kPressure] = toDouble(init.pressure ?? 0);
		this[kTangentialPressure] = toDouble(init.tangentialPressure ?? 0);
		this[kTiltX] = init.tiltX === undefined ? null : toLong(init.tiltX);
		this[kTiltY] = init.tiltY === undefined ? null : toLong(init.tiltY);
		this[kTwist] = toLong(init.twist ?? 0);
		this[kAltitudeAngle] =
			init.altitudeAngle === undefined ? null : toDouble(init.altitudeAngle);
		this[kAzimuthAngle] =
			init.azimuthAngle === undefined ? null : toDouble(init.azimuthAngle);
		this[kPointerType] = String(init.pointerType ?? "");
		this[kIsPrimary] = Boolean(init.isPrimary);
		this[kCoalesced] = [...(init.coalescedEvents ?? [])];
		this[kPredicted] = [...(init.predictedEvents ?? [])];
	}

	get pointerId(): number {
		return this[kPointerId];
	}

	get width(): number {
		return this[kWidth];
	}

	get height(): number {
		return this[kHeight];
	}

	get pressure(): number {
		return this[kPressure];
	}

	get tangentialPressure(): number {
		return this[kTangentialPressure];
	}

	// The tilt pair and the altitude/azimuth pair describe the same angle two
	// ways. If an init gives one, the other is computed from it. If it gives
	// neither, the pen is upright.
	get tiltX(): number {
		if (this[kTiltX] !== null) {
			return this[kTiltX];
		}
		if (this[kAltitudeAngle] === null && this[kAzimuthAngle] === null) {
			return 0;
		}
		return sphericalToTilt(
			this[kAltitudeAngle] ?? Math.PI / 2,
			this[kAzimuthAngle] ?? 0,
		)[0];
	}

	get tiltY(): number {
		if (this[kTiltY] !== null) {
			return this[kTiltY];
		}
		if (this[kAltitudeAngle] === null && this[kAzimuthAngle] === null) {
			return 0;
		}
		return sphericalToTilt(
			this[kAltitudeAngle] ?? Math.PI / 2,
			this[kAzimuthAngle] ?? 0,
		)[1];
	}

	get twist(): number {
		return this[kTwist];
	}

	get altitudeAngle(): number {
		if (this[kAltitudeAngle] !== null) {
			return this[kAltitudeAngle];
		}
		if (this[kTiltX] === null && this[kTiltY] === null) {
			return Math.PI / 2;
		}
		return tiltToSpherical(this[kTiltX] ?? 0, this[kTiltY] ?? 0)[0];
	}

	get azimuthAngle(): number {
		if (this[kAzimuthAngle] !== null) {
			return this[kAzimuthAngle];
		}
		if (this[kTiltX] === null && this[kTiltY] === null) {
			return 0;
		}
		return tiltToSpherical(this[kTiltX] ?? 0, this[kTiltY] ?? 0)[1];
	}

	get pointerType(): string {
		return this[kPointerType];
	}

	get isPrimary(): boolean {
		return this[kIsPrimary];
	}

	getCoalescedEvents(): PointerEvent[] {
		return [...this[kCoalesced]];
	}

	getPredictedEvents(): PointerEvent[] {
		return [...this[kPredicted]];
	}
}

Object.defineProperty(PointerEvent.prototype, Symbol.toStringTag, {
	value: "PointerEvent",
	configurable: true,
});

interface DragEventInit extends MouseEventInit {
	dataTransfer?: DataTransfer | null;
}

const kEventDataTransfer = Symbol("event data transfer");

export interface DragEvent {
	[kEventDataTransfer]: DataTransfer | null;
}

/** A drag-and-drop event, carrying its drag session's data transfer. */
export class DragEvent extends MouseEvent {
	constructor(type: string, eventInitDict: DragEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<DragEventInit>(eventInitDict, "An event init");
		this[kEventDataTransfer] = init.dataTransfer ?? null;
	}

	get dataTransfer(): DataTransfer | null {
		return this[kEventDataTransfer];
	}
}

Object.defineProperty(DragEvent.prototype, Symbol.toStringTag, {
	value: "DragEvent",
	configurable: true,
});

/** Convert a pen's altitude and azimuth to tilt angles in degrees. */
function sphericalToTilt(altitude: number, azimuth: number): [number, number] {
	if (altitude === 0) {
		if (azimuth === 0 || azimuth === 2 * Math.PI) {
			return [90, 0];
		}
		if (azimuth === Math.PI / 2) {
			return [0, 90];
		}
		if (azimuth === Math.PI) {
			return [-90, 0];
		}
		if (azimuth === (3 * Math.PI) / 2) {
			return [0, -90];
		}
	}
	const tiltX = Math.round(
		(Math.atan(Math.cos(azimuth) / Math.tan(altitude)) * 180) / Math.PI,
	);
	const tiltY = Math.round(
		(Math.atan(Math.sin(azimuth) / Math.tan(altitude)) * 180) / Math.PI,
	);
	return [tiltX, tiltY];
}

/** Convert a pen's tilt angles to altitude and azimuth in radians. */
function tiltToSpherical(tiltX: number, tiltY: number): [number, number] {
	const radiansX = (tiltX * Math.PI) / 180;
	const radiansY = (tiltY * Math.PI) / 180;
	const tanX = Math.tan(radiansX);
	const tanY = Math.tan(radiansY);
	let azimuth = Math.atan2(tanY, tanX);
	if (azimuth < 0) {
		azimuth += 2 * Math.PI;
	}
	const altitude = Math.atan(1 / Math.sqrt(tanX * tanX + tanY * tanY));
	return [
		Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90 ? 0 : altitude,
		azimuth,
	];
}

/** What an AbortSignal must provide for a listener to use it. */
interface ListenerSignal {
	aborted: boolean;
	addEventListener(type: string, callback: () => void): void;
}

export interface Listener {
	type: string;
	callback: globalThis.EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;

	/** The hover count this listener is counted in, if any. */
	hoverCount?: HoverListenerCount;
}

/**
 * The platform's AbortSignal, which a listener's signal must be an instance of.
 */
const PlatformAbortSignal = (
	globalThis as unknown as {AbortSignal?: new () => ListenerSignal}
).AbortSignal;

const kHandlers = Symbol("handlers");
const kListeners = Symbol("event listener list");

export interface EventTarget {
	[kListeners]: Listener[];

	[kHandlers]: Map<string, EventHandlerRecord> | null;
}

/** An event target: a listener list, and the parent dispatch walks to. */
export class EventTarget implements globalThis.EventTarget {
	/** Null until this target is given an event handler. Most never are. */
	declare dispatchEvent: (event: globalThis.Event) => boolean;

	constructor() {
		this[kListeners] = [];
		this[kHandlers] = null;
	}

	addEventListener(
		type: string,
		callback: globalThis.EventListenerOrEventListenerObject | null,
		options?: boolean | globalThis.AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		callback: globalThis.EventListenerOrEventListenerObject | null,
		options?: boolean | globalThis.AddEventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("addEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const flat = flattenMore(options);
		if (flat.signal !== null && flat.signal.aborted) {
			return;
		}
		if (listenerCallback === null) {
			return;
		}
		const passive =
			flat.passive === null ? getDefaultPassiveValue(name, this) : flat.passive;
		for (const existing of this[kListeners]) {
			if (
				existing.type === name &&
				existing.callback === listenerCallback &&
				existing.capture === flat.capture
			) {
				return;
			}
		}
		const listener: Listener = {
			type: name,
			callback: listenerCallback,
			capture: flat.capture,
			once: flat.once,
			passive,
			removed: false,
		};
		this[kListeners].push(listener);
		countHoverListener(this, listener);
		if (flat.signal !== null) {
			flat.signal.addEventListener("abort", () => {
				removeListener(this[kListeners], listener);
			});
		}
	}

	removeEventListener(
		type: string,
		callback: globalThis.EventListenerOrEventListenerObject | null,
		options?: boolean | globalThis.EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		callback: globalThis.EventListenerOrEventListenerObject | null,
		options?: boolean | globalThis.EventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("removeEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const capture = flattenCapture(options);
		if (listenerCallback === null) {
			return;
		}
		for (const listener of this[kListeners]) {
			if (
				listener.type === name &&
				listener.callback === listenerCallback &&
				listener.capture === capture
			) {
				removeListener(this[kListeners], listener);
				return;
			}
		}
	}
}

Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, {
	value: "EventTarget",
	configurable: true,
});

function flattenMore(
	options: boolean | globalThis.AddEventListenerOptions | undefined,
): {
	capture: boolean;
	once: boolean;

	/** Null until the type and target decide it, which the spec defers. */
	passive: boolean | null;
	signal: ListenerSignal | null;
} {
	if (
		options !== null &&
		options !== undefined &&
		typeof options !== "object" &&
		typeof options !== "function"
	) {
		return {
			capture: Boolean(options),
			once: false,
			passive: null,
			signal: null,
		};
	}
	const dictionary = toDictionary<globalThis.AddEventListenerOptions>(
		options,
		"Listener options",
	);
	let signal: ListenerSignal | null = null;
	if (dictionary.signal !== undefined) {
		if (
			PlatformAbortSignal === undefined ||
			!(dictionary.signal instanceof PlatformAbortSignal)
		) {
			throw new TypeError("A listener's signal must be an AbortSignal");
		}
		signal = dictionary.signal;
	}
	return {
		capture: Boolean(dictionary.capture),
		once: Boolean(dictionary.once),
		passive:
			dictionary.passive === undefined ? null : Boolean(dictionary.passive),
		signal,
	};
}

/** A capture-only options argument, for removeEventListener. */
function flattenCapture(
	options: boolean | globalThis.EventListenerOptions | undefined,
): boolean {
	if (
		options !== null &&
		options !== undefined &&
		typeof options !== "object" &&
		typeof options !== "function"
	) {
		return Boolean(options);
	}
	return Boolean(
		toDictionary<globalThis.EventListenerOptions>(
			options,
			"Listener options",
		).capture,
	);
}

/** Convert a listener callback per Web IDL: null, or a callable object. */
function toEventListener(
	callback: unknown,
): globalThis.EventListenerOrEventListenerObject | null {
	if (callback === null || callback === undefined) {
		return null;
	}
	if (typeof callback === "function" || typeof callback === "object") {
		return callback as globalThis.EventListenerOrEventListenerObject;
	}
	throw new TypeError("An event listener must be an object or a function");
}

// Scroll-blocking event types are passive by default at the roots a page
// scrolls through, so a listener there cannot cancel a scroll it only
// meant to observe.
function getDefaultPassiveValue(type: string, target: EventTarget): boolean {
	if (
		type !== "touchstart" &&
		type !== "touchmove" &&
		type !== "wheel" &&
		type !== "mousewheel"
	) {
		return false;
	}
	if (isWindowTarget(target)) {
		return true;
	}
	if (!isNodeTarget(target)) {
		return false;
	}
	const document = getTargetDocument(target);
	return (
		document !== null &&
		(target === (document as EventTarget) ||
			target === (document.documentElement as unknown as EventTarget | null) ||
			target === (document.body as unknown as EventTarget | null))
	);
}

// Created only when a handler is set. Reading a handler from a target
// that has none allocates nothing.
function getEventHandlerMap(
	target: EventTarget,
	create: boolean,
): Map<string, EventHandlerRecord> | null {
	if (target[kHandlers] === null && create) {
		target[kHandlers] = new Map();
	}
	return target[kHandlers];
}

/**
 * Remove a listener from a list and mark it so an in-progress dispatch skips
 * it.
 */
export function removeListener(
	listeners: Listener[],
	listener: Listener,
): void {
	listener.removed = true;
	const index = listeners.indexOf(listener);
	if (index !== -1) {
		listeners.splice(index, 1);
		if (listener.hoverCount !== undefined) {
			listener.hoverCount.count--;
			listener.hoverCount.onChange?.();
		}
	}
}

// LegacyTreatNonObjectAsNull: a non-object is stored as null. A
// non-callable object is stored and throws when the event arrives.
type EventHandlerValue = ((event: Event) => unknown) | object;

// The listener is registered on the first non-null assignment and stays
// registered, which fixes the handler's position among listeners added
// around it. Reassigning `onclick` changes what runs, never when. A null
// assignment removes it, so a later assignment goes to the end.
interface EventHandlerRecord {
	value: EventHandlerValue | null;
	listener: Listener | null;
}

/** The value an event handler attribute holds, or null. */
function getEventHandlerValue(
	target: EventTarget,
	type: string,
): EventHandlerValue | null {
	const handlers = getEventHandlerMap(target, false);
	if (handlers === null) {
		return null;
	}
	const record = handlers.get(type);
	return record === undefined
		? null
		: compileEventHandler(target, type, record);
}

// Activate the handler on a value. Deactivate it on null.
export function setEventHandler(
	target: EventTarget,
	type: string,
	value: unknown,
): void {
	const handler =
		typeof value === "function" || (typeof value === "object" && value !== null)
			? (value as EventHandlerValue)
			: null;
	const handlers = getEventHandlerMap(target, handler !== null);
	if (handlers === null) {
		return;
	}
	const record = handlers.get(type);
	if (handler === null) {
		if (record === undefined) {
			return;
		}
		record.value = null;
		if (record.listener !== null) {
			removeListener(target[kListeners], record.listener);
			record.listener = null;
		}
		return;
	}
	if (record !== undefined) {
		record.value = handler;
		if (record.listener === null) {
			record.listener = registerHandlerListener(target, type, record);
		}
		return;
	}
	const created: EventHandlerRecord = {value: handler, listener: null};
	handlers.set(type, created);
	created.listener = registerHandlerListener(target, type, created);
}

// Writes the list directly, as the spec's "add an event listener" does.
// Setting a handler is not an addEventListener call and does not go
// through one.
function registerHandlerListener(
	target: EventTarget,
	type: string,
	record: EventHandlerRecord,
): Listener {
	const listener: Listener = {
		type,
		callback: (event: globalThis.Event): void => {
			invokeEventHandler(target, type, record, event as Event);
		},
		capture: false,
		once: false,
		passive: false,
		removed: false,
	};
	target[kListeners].push(listener);
	countHoverListener(target, listener);
	return listener;
}

// An ErrorEvent of this DOM's, or one dispatched from outside with the
// same shape.
function isErrorEvent(event: Event): boolean {
	return (
		event instanceof ErrorEvent ||
		("message" in event &&
			"filename" in event &&
			"lineno" in event &&
			"colno" in event &&
			"error" in event)
	);
}

// The event handler processing algorithm. If a handler throws, the
// exception is reported instead of propagating into the dispatch.
function invokeEventHandler(
	target: EventTarget,
	type: string,
	record: EventHandlerRecord,
	event: Event,
): void {
	const callback = compileEventHandler(target, type, record);
	if (callback === null) {
		return;
	}
	// A window's error handler receives the ErrorEvent's fields as separate
	// arguments and returns true to cancel, the inverse of every other
	// handler. A document's or element's error handler is an ordinary one.
	const errorHandling =
		type === "error" && !isNodeTarget(target) && isErrorEvent(event);
	let result: unknown;
	try {
		const called = callback as (...args: unknown[]) => unknown;
		result = errorHandling
			? called.call(
				target,
				(event as unknown as {message: unknown}).message,
				(event as unknown as {filename: unknown}).filename,
				(event as unknown as {lineno: unknown}).lineno,
				(event as unknown as {colno: unknown}).colno,
				(event as unknown as {error: unknown}).error,
			)
			: called.call(target, event);
	} catch (error) {
		reportError(error, getTargetDocument(target));
		return;
	}
	if (errorHandling ? result === true : result === false) {
		setCanceledFlag(event);
	}
}

// The prefixed animation handlers listen for the mixed-case legacy types
// (HTML's event handler table).
export const PREFIXED_HANDLER_TYPES = new Map([
	["onwebkitanimationend", "webkitAnimationEnd"],
	["onwebkitanimationiteration", "webkitAnimationIteration"],
	["onwebkitanimationstart", "webkitAnimationStart"],
	["onwebkittransitionend", "webkitTransitionEnd"],
]);

// Per spec a handler IS a listener. It goes through the same listener
// list as any other, so dispatch order and dedup are the same.
export function installEventHandler(prototype: object, name: string): void {
	const type = PREFIXED_HANDLER_TYPES.get(name) ?? name.slice(2);
	Object.defineProperty(prototype, name, {
		get(this: EventTarget): EventHandlerValue | null {
			return getEventHandlerValue(this, type);
		},
		set(this: EventTarget, value: unknown): void {
			setEventHandler(this, type, value);
		},
		enumerable: true,
		configurable: true,
	});
}

// An event handler content attribute (`onclick="..."`) holds its source
// until the handler is first read or fired, when it compiles to a function
// taking `event` with the element as `this`. Markup the app hands the
// engine is the app's, as a page's markup is the page's: a handler in it
// runs, and untrusted markup is the app's to sanitize first. One that
// does not compile reports its error and leaves the handler null.
export class UncompiledHandler {
	readonly source: string;
	readonly element: Element;

	constructor(source: string, element: Element) {
		this.source = source;
		this.element = element;
	}
}

function compileEventHandler(
	target: EventTarget,
	type: string,
	record: EventHandlerRecord,
): EventHandlerValue | null {
	const value = record.value;
	if (!(value instanceof UncompiledHandler)) {
		return value;
	}
	try {
		record.value = new Function("event", value.source) as EventHandlerValue;
	} catch (error) {
		reportError(error, getTargetDocument(value.element));
		setEventHandler(target, type, null);
		return null;
	}
	return record.value;
}

export function installEventHandlers(
	prototype: object,
	names: readonly string[],
): void {
	for (const name of names) {
		installEventHandler(prototype, name);
	}
}

// The handlers `body` and `frameset` forward to the window. With no
// window, writes are dropped and reads return null.
export function installForwardedEventHandler(
	prototype: object,
	name: string,
): void {
	Object.defineProperty(prototype, name, {
		get(this: Element): unknown {
			const view = getTargetDocument(this)?.defaultView as Record<
				string,
				unknown
			> | null;
			return view === null ? null : (view[name] ?? null);
		},
		set(this: Element, value: unknown): void {
			const view = getTargetDocument(this)?.defaultView as Record<
				string,
				unknown
			> | null;
			if (view === null) {
				return;
			}
			view[name] = value;
		},
		enumerable: true,
		configurable: true,
	});
}

// For an object callback, handleEvent is looked up at call time.
export function callListener(
	callback: globalThis.EventListenerOrEventListenerObject,
	thisArg: EventTarget | null,
	event: Event,
): void {
	if (typeof callback === "function") {
		callback.call(thisArg, event);
		return;
	}
	const handleEvent = (callback as {handleEvent?: unknown}).handleEvent;
	if (typeof handleEvent !== "function") {
		throw new TypeError("An event listener object needs a handleEvent method");
	}
	(handleEvent as (event: Event) => void).call(callback, event);
}

// HTML's "report an exception": the document's window hears an error
// event first, and a handler that cancels it has handled the error. With
// no window, or an unhandled one, the runtime reports it.
export function reportError(
	error: unknown,
	document: Document | null = null,
): void {
	const view = document === null
		? null
		: (document.defaultView as Window | null);
	if (view !== null) {
		view.reportError(error);
		return;
	}
	reportUncaught(error);
}

/** What a window does with an error nothing handled. */
export function reportUncaught(error: unknown): void {
	const report = (globalThis as {reportError?: (e: unknown) => void})
		.reportError;
	if (report) {
		report(error);
	} else {
		console.error(error);
	}
}

export function getDispatchState(event: Event): DispatchState {
	return event[kState];
}

export function getListeners(target: EventTarget): Listener[] {
	return target[kListeners];
}

export function isMouseEvent(event: Event): boolean {
	return event[kIsMouseEvent];
}

// stay on the event afterwards and read the cleared state.
export function adoptForeignEvent(event: Event): void {
	if (Object.prototype.hasOwnProperty.call(event, kState)) {
		return;
	}
	const state: DispatchState = {
		target: null,
		relatedTarget: null,
		currentTarget: null,
		eventPhase: NONE,
		path: [],
		initialized: true,
		dispatch: false,
		stopPropagation: false,
		stopImmediate: false,
		canceled: Boolean(event.defaultPrevented),
		inPassiveListener: false,
		trusted: false,
		foreign: true,
	};
	Object.defineProperty(event, kState, {value: state});
	defineDispatchAccessor(event, "target", () => state.target);
	defineDispatchAccessor(event, "srcElement", () => state.target);
	defineDispatchAccessor(event, "currentTarget", () => state.currentTarget);
	defineDispatchAccessor(event, "eventPhase", () => state.eventPhase);
	Object.defineProperty(event, "composedPath", {
		value: () => getComposedPath(state),
		configurable: true,
	});
}

function defineDispatchAccessor(
	event: Event,
	name: string,
	get: () => unknown,
): void {
	Object.defineProperty(event, name, {get, configurable: true});
}
