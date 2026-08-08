/**
 * The DOM Standard's node tree, standalone.
 *
 * This is TermDOM's own implementation of the DOM: Node and its subclasses,
 * the mutation algorithms, attributes, live collections, traversal, the
 * ParentNode/ChildNode mixins, events and their dispatch, mutation observers,
 * HTML parsing and serialization through parse5, and selector matching through
 * nwsapi.
 *
 * Dispatch builds the spec's event path -- one struct per invocation target,
 * each carrying the target a listener there sees -- and walks it twice. The
 * members of that struct that only shadow trees fill in are present and
 * inert, so retargeting has somewhere to go rather than something to replace.
 *
 * A mutation record is queued where the spec queues one, and reaches the
 * observers that asked for it through the registered observer list of every
 * inclusive ancestor of the mutated node. A node carries copies of those
 * registrations out of the tree when it is removed, so the mutations that
 * follow inside it still arrive.
 *
 * The spec's "insertion steps", "removing steps", "adopting steps", "attribute
 * change steps", "children changed steps" and "cloning steps" each exist here
 * as a symbol-keyed hook a subclass overrides and the mutation algorithms call
 * where the spec calls them. Nothing on the public surface names them.
 *
 * Every element is created through the same "create an element" algorithm and
 * looked up in an element-definition registry, so an element carries the shape
 * a custom element needs -- a definition, a state, and lifecycle reactions --
 * whether or not anything ever defines one.
 */

import {parseFragment, parse as parse5Parse} from "parse5";
import NWSAPI from "nwsapi";

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/* ------------------------------------------------------------------ errors */

/**
 * The DOMException the platform supplies, so a caller's `instanceof
 * DOMException` and `error.code` are the platform's own.
 */
const PlatformDOMException: typeof DOMException = (
	globalThis as unknown as {DOMException: typeof DOMException}
).DOMException;

function domError(name: string, message: string): DOMException {
	return new PlatformDOMException(message, name);
}

function hierarchyRequestError(message: string): DOMException {
	return domError("HierarchyRequestError", message);
}

function notFoundError(message: string): DOMException {
	return domError("NotFoundError", message);
}

function indexSizeError(message: string): DOMException {
	return domError("IndexSizeError", message);
}

/* -------------------------------------------------------------- validation */

/**
 * The DOM Standard's name productions.
 *
 * A valid element local name either starts with an ASCII alpha and then holds
 * anything but the characters that would end a tag name, or starts with a
 * colon, underscore or non-ASCII character and continues in the narrower set.
 * An attribute local name and a namespace prefix are the looser rules, and a
 * doctype name is the loosest of all -- it may even be empty.
 */
const VALID_ELEMENT_LOCAL_NAME =
	/^(?:[A-Za-z][^\0\t\n\f\r />]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9\-.:_\u0080-\u{10FFFF}]*)$/u;
const VALID_ATTRIBUTE_LOCAL_NAME = /^[^\0\t\n\f\r /=>]+$/u;
const VALID_NAMESPACE_PREFIX = /^[^\0\t\n\f\r />]+$/u;
const VALID_DOCTYPE_NAME = /^[^\0\t\n\f\r >]*$/u;

// XML 1.0 (5th ed) Name, which a processing instruction's target must match.
// Surrogates are matched as pairs so an astral character counts as one.
const NAME_START =
	"A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D" +
	"\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF" +
	"\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD:";
const NAME_REST = `${NAME_START}\\-.0-9\u00B7\u0300-\u036F\u203F-\u2040`;
// The combining-mark ranges are the production's own, and are meant to match
// a combining mark on its own rather than as part of a grapheme.
// eslint-disable-next-line no-misleading-character-class
const XML_NAME = new RegExp(
	`^(?:[${NAME_START}]|[\uD800-\uDBFF][\uDC00-\uDFFF])` +
		`(?:[${NAME_REST}]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$`,
);

/** Throw unless the string matches the XML Name production. */
function validateXMLName(name: string): void {
	if (!XML_NAME.test(name)) {
		throw domError("InvalidCharacterError", `"${name}" is not a valid name`);
	}
}

function isValidLocalName(name: string, forAttribute: boolean): boolean {
	return forAttribute
		? VALID_ATTRIBUTE_LOCAL_NAME.test(name)
		: VALID_ELEMENT_LOCAL_NAME.test(name);
}

/** Throw unless the string is a valid element local name. */
function validateElementLocalName(name: string): void {
	if (!VALID_ELEMENT_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid element name`,
		);
	}
}

/** Throw unless the string is a valid attribute local name. */
function validateAttributeLocalName(name: string): void {
	if (!VALID_ATTRIBUTE_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid attribute name`,
		);
	}
}

/** Throw unless the string is a valid doctype name. */
function validateDoctypeName(name: string): void {
	if (!VALID_DOCTYPE_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid doctype name`,
		);
	}
}

/**
 * Split a qualified name against a namespace, throwing the errors the spec's
 * name and namespace constraints call for.
 */
function validateAndExtract(
	namespace: string | null,
	qualifiedName: string,
	forAttribute: boolean,
): {namespace: string | null; prefix: string | null; localName: string} {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	let prefix: string | null = null;
	let localName = qualifiedName;
	const colon = qualifiedName.indexOf(":");
	if (colon !== -1) {
		prefix = qualifiedName.slice(0, colon);
		localName = qualifiedName.slice(colon + 1);
		if (!VALID_NAMESPACE_PREFIX.test(prefix)) {
			throw domError(
				"InvalidCharacterError",
				`"${prefix}" is not a valid namespace prefix`,
			);
		}
	}
	if (!isValidLocalName(localName, forAttribute)) {
		throw domError(
			"InvalidCharacterError",
			`"${localName}" is not a valid local name`,
		);
	}
	if (prefix !== null && ns === null) {
		throw domError(
			"NamespaceError",
			"A prefixed name needs a non-null namespace",
		);
	}
	if (prefix === "xml" && ns !== XML_NAMESPACE) {
		throw domError("NamespaceError", "The xml prefix needs the XML namespace");
	}
	if (
		(qualifiedName === "xmlns" || prefix === "xmlns") &&
		ns !== XMLNS_NAMESPACE
	) {
		throw domError(
			"NamespaceError",
			"The xmlns name needs the XMLNS namespace",
		);
	}
	if (
		ns === XMLNS_NAMESPACE &&
		qualifiedName !== "xmlns" &&
		prefix !== "xmlns"
	) {
		throw domError(
			"NamespaceError",
			"The XMLNS namespace needs the xmlns name",
		);
	}
	return {namespace: ns, prefix, localName};
}

/* ------------------------------------------------------------------- hooks */

/**
 * The spec's per-node algorithm steps, as symbol keys a subclass overrides.
 *
 * They are module-scoped, so the only code that reaches them is the code in
 * this file: the mutation algorithms that call them and the classes that
 * implement them. Engine invalidation hangs off these.
 */
const kInsertionSteps = Symbol("insertion steps");
const kRemovingSteps = Symbol("removing steps");
const kAdoptingSteps = Symbol("adopting steps");
const kChildrenChanged = Symbol("children changed steps");
const kAttributeChanged = Symbol("attribute change steps");
const kCloningSteps = Symbol("cloning steps");
const kCloneSingle = Symbol("clone a single node");
const kDispatchState = Symbol("event dispatch state");
const kListeners = Symbol("event listener list");
const kGetTheParent = Symbol("get the parent");
const kSetEventType = Symbol("set event type");
const kIsMouseEvent = Symbol("is a mouse event");
const kActivationBehavior = Symbol("activation behavior");
const kLegacyPreActivationBehavior = Symbol("legacy-pre-activation behavior");
const kLegacyCanceledActivationBehavior = Symbol(
	"legacy-canceled activation behavior",
);

/**
 * A node's tree state. These are module-scoped symbols rather than #private
 * fields because the mutation algorithms are module functions: they operate on
 * whole subtrees of mixed node types, which no one class body can reach.
 */
const kParent = Symbol("parent");
const kFirstChild = Symbol("first child");
const kLastChild = Symbol("last child");
const kPrevious = Symbol("previous sibling");
const kNext = Symbol("next sibling");
const kDocument = Symbol("node document");
const kChildNodes = Symbol("childNodes");
const kChildren = Symbol("children");
const kCollectionCaches = Symbol("collection caches");
const kHost = Symbol("host");
const kRegisteredObservers = Symbol("registered observer list");
const kShadowRoot = Symbol("shadow root");
const kShadowMode = Symbol("shadow root mode");
const kDelegatesFocus = Symbol("delegates focus");
const kSlotAssignment = Symbol("slot assignment");
const kClonable = Symbol("clonable");
const kSerializable = Symbol("serializable");
const kDeclarative = Symbol("declarative");
const kAvailableToInternals = Symbol("available to element internals");
const kSlotName = Symbol("slot name");
const kSlottableName = Symbol("slottable name");
const kAssignedSlot = Symbol("assigned slot");
const kAssignedNodes = Symbol("assigned nodes");
const kManualAssignment = Symbol("manually assigned nodes");
const kManualSlot = Symbol("manual slot assignment");
const kReactionQueue = Symbol("custom element reaction queue");
const kPseudoElements = Symbol("user-agent pseudo-element slots");
const kTemplateContent = Symbol("template content");

/* ------------------------------------------------------------------ events */

export interface EventInit {
	bubbles?: boolean;
	cancelable?: boolean;
	composed?: boolean;
}

export interface CustomEventInit<T = unknown> extends EventInit {
	detail?: T;
}

const NONE = 0;
const CAPTURING_PHASE = 1;
const AT_TARGET = 2;
const BUBBLING_PHASE = 3;

/**
 * One struct of an event's path.
 *
 * The shadow members -- the shadow-adjusted target and the two closed-tree
 * flags -- are what composedPath() reads to decide how much of a path a
 * listener may see. Shadow trees are a later phase, so every invocation target
 * is in a document tree and both flags are false; retargeting and the
 * assigned-slot walk fill them in where the algorithm already reads them.
 */
interface PathItem {
	invocationTarget: EventTarget;
	invocationTargetInShadowTree: boolean;
	shadowAdjustedTarget: EventTarget | null;
	relatedTarget: EventTarget | null;
	rootOfClosedTree: boolean;
	slotInClosedTree: boolean;
}

/**
 * An event's dispatch-time state: the spec's internal slots and flags.
 *
 * They live in one object behind a module symbol because dispatch is a module
 * function that reads and writes them across every target in a path, which no
 * one class body can reach.
 */
interface DispatchState {
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
}

/**
 * The types a trusted event falls back to when nothing listened for its own.
 *
 * An animation or transition event whose modern type found no listener at a
 * target is offered again there under the prefixed name.
 */
const LEGACY_EVENT_TYPES = new Map([
	["animationend", "webkitAnimationEnd"],
	["animationiteration", "webkitAnimationIteration"],
	["animationstart", "webkitAnimationStart"],
	["transitionend", "webkitTransitionEnd"],
]);

/**
 * The activation behavior an event target runs when a click dispatch reaches
 * it uncanceled, and the two legacy hooks around it that a checkbox and a
 * radio button need.
 *
 * They are the spec's hooks: an element that has one is an activation target,
 * and dispatch runs it after the path is walked. The elements that have them
 * -- links, form controls -- are the HTML Standard's, so nothing here defines
 * one yet; dispatch consults them where the spec does.
 */
interface ActivationTarget {
	[kActivationBehavior]?: (event: Event) => void;
	[kLegacyPreActivationBehavior]?: () => void;
	[kLegacyCanceledActivationBehavior]?: () => void;
}

/** A dictionary argument, per Web IDL: absent, null, or an object. */
function toDictionary<T extends object>(value: unknown, what: string): T {
	if (value === undefined || value === null) return {} as T;
	if (typeof value !== "object" && typeof value !== "function") {
		throw new TypeError(`${what} must be an object`);
	}
	return value as T;
}

/**
 * isTrusted is one accessor shared by every event, installed as an own
 * property of each: the interface declares it unforgeable, so it is not on
 * the prototype and cannot be redefined away.
 */
function isTrustedGetter(this: Event): boolean {
	return this[kDispatchState].trusted;
}

const isTrustedProperty: PropertyDescriptor = {
	get: isTrustedGetter,
	enumerable: true,
	configurable: false,
};

/** An event, and the flags a listener sets on it while it is dispatched. */
export class Event {
	#type: string;
	#bubbles: boolean;
	#cancelable: boolean;
	#composed: boolean;
	#timeStamp: number;
	#state: DispatchState = {
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
	};

	declare readonly isTrusted: boolean;

	static readonly NONE = NONE;
	static readonly CAPTURING_PHASE = CAPTURING_PHASE;
	static readonly AT_TARGET = AT_TARGET;
	static readonly BUBBLING_PHASE = BUBBLING_PHASE;

	constructor(type: string, eventInitDict: EventInit = {}) {
		if (arguments.length < 1) {
			throw new TypeError("Event constructor needs a type");
		}
		this.#type = String(type);
		const init = toDictionary<EventInit>(eventInitDict, "An event init");
		this.#bubbles = Boolean(init.bubbles);
		this.#cancelable = Boolean(init.cancelable);
		this.#composed = Boolean(init.composed);
		this.#timeStamp = performance.now();
		this.#state.initialized = true;
		Object.defineProperty(this, "isTrusted", isTrustedProperty);
	}

	get [kDispatchState](): DispatchState {
		return this.#state;
	}

	/** Swap the type a dispatch invokes listeners under, for the legacy pass. */
	[kSetEventType](type: string): void {
		this.#type = type;
	}

	/**
	 * Whether this is a MouseEvent, which is what makes a "click" the event
	 * that runs activation behavior. MouseEvent belongs to UI Events, a later
	 * phase, and overrides this when it lands.
	 */
	get [kIsMouseEvent](): boolean {
		return false;
	}

	get type(): string {
		return this.#type;
	}

	get target(): EventTarget | null {
		return this.#state.target;
	}

	get srcElement(): EventTarget | null {
		return this.#state.target;
	}

	get currentTarget(): EventTarget | null {
		return this.#state.currentTarget;
	}

	get eventPhase(): number {
		return this.#state.eventPhase;
	}

	get bubbles(): boolean {
		return this.#bubbles;
	}

	get cancelable(): boolean {
		return this.#cancelable;
	}

	get composed(): boolean {
		return this.#composed;
	}

	get defaultPrevented(): boolean {
		return this.#state.canceled;
	}

	get timeStamp(): number {
		return this.#timeStamp;
	}

	get returnValue(): boolean {
		return !this.#state.canceled;
	}

	set returnValue(value: boolean) {
		if (!value) setCanceledFlag(this);
	}

	get cancelBubble(): boolean {
		return this.#state.stopPropagation;
	}

	set cancelBubble(value: boolean) {
		if (value) this.#state.stopPropagation = true;
	}

	composedPath(): EventTarget[] {
		return composedPath(this.#state);
	}

	stopPropagation(): void {
		this.#state.stopPropagation = true;
	}

	stopImmediatePropagation(): void {
		this.#state.stopPropagation = true;
		this.#state.stopImmediate = true;
	}

	preventDefault(): void {
		setCanceledFlag(this);
	}

	initEvent(type: string, bubbles = false, cancelable = false): void {
		if (arguments.length < 1) {
			throw new TypeError("initEvent needs a type");
		}
		if (this.#state.dispatch) return;
		this.#type = String(type);
		this.#bubbles = Boolean(bubbles);
		this.#cancelable = Boolean(cancelable);
		this.#state.initialized = true;
		this.#state.stopPropagation = false;
		this.#state.stopImmediate = false;
		this.#state.canceled = false;
		this.#state.trusted = false;
		this.#state.target = null;
	}
}

Object.defineProperties(Event.prototype, {
	NONE: {value: NONE, enumerable: true},
	CAPTURING_PHASE: {value: CAPTURING_PHASE, enumerable: true},
	AT_TARGET: {value: AT_TARGET, enumerable: true},
	BUBBLING_PHASE: {value: BUBBLING_PHASE, enumerable: true},
	[Symbol.toStringTag]: {value: "Event", configurable: true},
});

/** An event is canceled only where it is cancelable and nothing is passive. */
function setCanceledFlag(event: Event): void {
	const state = event[kDispatchState];
	if (event.cancelable && !state.inPassiveListener) state.canceled = true;
}

/**
 * The path as the target that is running sees it.
 *
 * A listener sees every struct it is allowed to: the walk out from the
 * current target stops crossing into a closed tree it did not start inside,
 * counting the closed roots and slots it passes.
 */
function composedPath(state: DispatchState): EventTarget[] {
	const path = state.path;
	if (path.length === 0) return [];
	const currentTarget = state.currentTarget as EventTarget;
	const composed: EventTarget[] = [currentTarget];
	let currentTargetIndex = 0;
	let currentTargetHiddenSubtreeLevel = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) currentTargetHiddenSubtreeLevel++;
		if (path[index].invocationTarget === currentTarget) {
			currentTargetIndex = index;
			break;
		}
		if (path[index].slotInClosedTree) currentTargetHiddenSubtreeLevel--;
	}
	let currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	let maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) currentHiddenLevel++;
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.unshift(path[index].invocationTarget);
		}
		if (path[index].slotInClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel)
				maxHiddenLevel = currentHiddenLevel;
		}
	}
	currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex + 1; index < path.length; index++) {
		if (path[index].slotInClosedTree) currentHiddenLevel++;
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.push(path[index].invocationTarget);
		}
		if (path[index].rootOfClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel)
				maxHiddenLevel = currentHiddenLevel;
		}
	}
	return composed;
}

export class CustomEvent<T = unknown> extends Event {
	#detail: T | null;

	constructor(type: string, eventInitDict: CustomEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CustomEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this.#detail = init.detail ?? null;
	}

	get detail(): T | null {
		return this.#detail;
	}

	initCustomEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		detail: T | null = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCustomEvent needs a type");
		}
		if (this[kDispatchState].dispatch) return;
		this.initEvent(type, bubbles, cancelable);
		this.#detail = detail;
	}
}

Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, {
	value: "CustomEvent",
	configurable: true,
});

export type EventListenerOrEventListenerObject =
	| ((event: Event) => void)
	| {handleEvent(event: Event): void};

/** What an AbortSignal has to be for a listener to hang off it. */
interface ListenerSignal {
	aborted: boolean;
	addEventListener(type: string, callback: () => void): void;
}

export interface AddEventListenerOptions {
	capture?: boolean;
	once?: boolean;
	passive?: boolean;
	signal?: ListenerSignal;
}

export interface EventListenerOptions {
	capture?: boolean;
}

interface Listener {
	type: string;
	callback: EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;
}

/** The AbortSignal the platform supplies, which a listener's signal must be. */
const PlatformAbortSignal = (
	globalThis as unknown as {AbortSignal?: new () => ListenerSignal}
).AbortSignal;

interface FlatOptions {
	capture: boolean;
	once: boolean;
	/** Null until the type and target decide, which is what the spec defers. */
	passive: boolean | null;
	signal: ListenerSignal | null;
}

/**
 * An options argument, which is either a dictionary or a capture boolean.
 *
 * The union resolves the way Web IDL resolves it: null, undefined and objects
 * are the dictionary, and anything else is the boolean.
 */
function flattenMore(
	options: boolean | AddEventListenerOptions | undefined,
): FlatOptions {
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
	const dictionary = toDictionary<AddEventListenerOptions>(
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
	options: boolean | EventListenerOptions | undefined,
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
		toDictionary<EventListenerOptions>(options, "Listener options").capture,
	);
}

/** A listener callback, per Web IDL: null, or an object that may be called. */
function toEventListener(
	callback: unknown,
): EventListenerOrEventListenerObject | null {
	if (callback === null || callback === undefined) return null;
	if (typeof callback === "function" || typeof callback === "object") {
		return callback as EventListenerOrEventListenerObject;
	}
	throw new TypeError("An event listener must be an object or a function");
}

/**
 * The scroll-blocking types, which are passive by default at the roots a page
 * scrolls through, so that a listener there cannot cancel a scroll it was
 * only meant to watch.
 */
function defaultPassiveValue(type: string, target: EventTarget): boolean {
	if (
		type !== "touchstart" &&
		type !== "touchmove" &&
		type !== "wheel" &&
		type !== "mousewheel"
	) {
		return false;
	}
	if (!(target instanceof Node)) return false;
	const document = target[kDocument];
	return (
		target === (document as EventTarget) ||
		target === (document.documentElement as EventTarget | null) ||
		target === (document.body as EventTarget | null)
	);
}

/** An event target: a listener list, and the parent a dispatch walks to. */
export class EventTarget {
	#listeners: Listener[] = [];

	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("addEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const flat = flattenMore(options);
		if (flat.signal !== null && flat.signal.aborted) return;
		if (listenerCallback === null) return;
		const passive =
			flat.passive === null ? defaultPassiveValue(name, this) : flat.passive;
		for (const existing of this.#listeners) {
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
		this.#listeners.push(listener);
		if (flat.signal !== null) {
			flat.signal.addEventListener("abort", () => {
				removeListener(this.#listeners, listener);
			});
		}
	}

	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("removeEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const capture = flattenCapture(options);
		if (listenerCallback === null) return;
		for (const listener of this.#listeners) {
			if (
				listener.type === name &&
				listener.callback === listenerCallback &&
				listener.capture === capture
			) {
				removeListener(this.#listeners, listener);
				return;
			}
		}
	}

	dispatchEvent(event: Event): boolean {
		if (!(event instanceof Event)) {
			throw new TypeError("dispatchEvent needs an Event");
		}
		const state = event[kDispatchState];
		if (state.dispatch || !state.initialized) {
			throw domError(
				"InvalidStateError",
				"That event is already being dispatched",
			);
		}
		state.trusted = false;
		return dispatch(this, event);
	}

	/** The listeners this target holds, for the dispatch algorithm. */
	get [kListeners](): Listener[] {
		return this.#listeners;
	}

	/**
	 * The target a dispatch reaches next. A bare event target is the end of a
	 * path; a node hands back its parent.
	 */
	[kGetTheParent](_event: Event): EventTarget | null {
		return null;
	}
}

Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, {
	value: "EventTarget",
	configurable: true,
});

/** Take a listener out of a list, marking it so a live dispatch skips it. */
function removeListener(listeners: Listener[], listener: Listener): void {
	listener.removed = true;
	const index = listeners.indexOf(listener);
	if (index !== -1) listeners.splice(index, 1);
}

/**
 * Retarget an object against another: walk out of the shadow trees the other
 * object cannot see into.
 */
function retarget(
	object: EventTarget | null,
	against: EventTarget,
): EventTarget | null {
	let current = object;
	for (;;) {
		if (!(current instanceof Node)) return current;
		const root = getRoot(current);
		if (!isShadowRoot(root)) return current;
		if (against instanceof Node && isInclusiveAncestor(root, against)) {
			return current;
		}
		current = (root as DocumentFragment)[kHost];
	}
}

/** Whether a root is a shadow root: a fragment a host holds. */
function isShadowRoot(root: Node): boolean {
	return root instanceof ShadowRoot;
}

function appendToPath(
	state: DispatchState,
	invocationTarget: EventTarget,
	shadowAdjustedTarget: EventTarget | null,
	relatedTarget: EventTarget | null,
	slotInClosedTree: boolean,
): void {
	const inShadowTree =
		invocationTarget instanceof Node && isShadowRoot(getRoot(invocationTarget));
	const rootOfClosedTree =
		invocationTarget instanceof ShadowRoot &&
		invocationTarget[kShadowMode] === "closed";
	state.path.push({
		invocationTarget,
		invocationTargetInShadowTree: inShadowTree,
		shadowAdjustedTarget,
		relatedTarget,
		rootOfClosedTree,
		slotInClosedTree,
	});
}

/**
 * Dispatch an event at a target.
 *
 * The path is built once, from the target outward, and then walked twice: in
 * from the far end for the capture phase and out again for the bubble phase.
 * A struct that carries a shadow-adjusted target is a target of this dispatch
 * and is walked in both directions whether or not the event bubbles.
 *
 * The spec threads a legacy target override flag through here for HTML's load
 * event, which retargets to a Window; there is no Window in this DOM.
 */
function dispatch(target: EventTarget, event: Event): boolean {
	const state = event[kDispatchState];
	state.dispatch = true;
	let activationTarget: EventTarget | null = null;
	let relatedTarget = retarget(state.relatedTarget, target);
	let clearTargets = false;
	if (target !== relatedTarget || target === state.relatedTarget) {
		let eventTarget = target;
		const isActivationEvent = event[kIsMouseEvent] && event.type === "click";
		appendToPath(state, eventTarget, eventTarget, relatedTarget, false);
		// A slottable that is assigned reaches its slot next, and the slot's
		// tree may be closed to the tree the event started in: the struct for
		// the slot carries that, so composedPath can count the boundary.
		let slottable: Node | null = isAssigned(eventTarget)
			? (eventTarget as Node)
			: null;
		let slotInClosedTree = false;
		if (isActivationEvent && hasActivationBehavior(eventTarget)) {
			activationTarget = eventTarget;
		}
		let parent = eventTarget[kGetTheParent](event);
		while (parent !== null) {
			if (slottable !== null) {
				slottable = null;
				const slotRoot = getRoot(parent as Node);
				if (
					slotRoot instanceof ShadowRoot &&
					slotRoot[kShadowMode] === "closed"
				) {
					slotInClosedTree = true;
				}
			}
			if (isAssigned(parent)) slottable = parent as Node;
			relatedTarget = retarget(state.relatedTarget, parent);
			if (
				parent instanceof Node &&
				eventTarget instanceof Node &&
				isShadowIncludingInclusiveAncestor(getRoot(eventTarget), parent)
			) {
				if (
					isActivationEvent &&
					event.bubbles &&
					activationTarget === null &&
					hasActivationBehavior(parent)
				) {
					activationTarget = parent;
				}
				appendToPath(state, parent, null, relatedTarget, slotInClosedTree);
			} else if (parent === relatedTarget) {
				parent = null;
			} else {
				eventTarget = parent;
				if (
					isActivationEvent &&
					activationTarget === null &&
					hasActivationBehavior(eventTarget)
				) {
					activationTarget = eventTarget;
				}
				appendToPath(
					state,
					parent,
					eventTarget,
					relatedTarget,
					slotInClosedTree,
				);
			}
			if (parent !== null) parent = parent[kGetTheParent](event);
			slotInClosedTree = false;
		}
		for (let index = state.path.length - 1; index >= 0; index--) {
			const struct = state.path[index];
			if (struct.shadowAdjustedTarget !== null) {
				if (isShadowRootTarget(struct.shadowAdjustedTarget))
					clearTargets = true;
				if (isShadowRootTarget(struct.relatedTarget)) clearTargets = true;
				break;
			}
		}
		if (activationTarget !== null) {
			(activationTarget as ActivationTarget)[kLegacyPreActivationBehavior]?.();
		}
		for (let index = state.path.length - 1; index >= 0; index--) {
			const struct = state.path[index];
			state.eventPhase =
				struct.shadowAdjustedTarget !== null ? AT_TARGET : CAPTURING_PHASE;
			invoke(event, index, true);
		}
		for (let index = 0; index < state.path.length; index++) {
			const struct = state.path[index];
			if (struct.shadowAdjustedTarget !== null) {
				state.eventPhase = AT_TARGET;
			} else {
				if (!event.bubbles) continue;
				state.eventPhase = BUBBLING_PHASE;
			}
			invoke(event, index, false);
		}
	}
	state.eventPhase = NONE;
	state.currentTarget = null;
	state.path = [];
	state.dispatch = false;
	state.stopPropagation = false;
	state.stopImmediate = false;
	if (clearTargets) {
		state.target = null;
		state.relatedTarget = null;
	}
	if (activationTarget !== null) {
		const behaviors = activationTarget as ActivationTarget;
		if (!state.canceled) {
			behaviors[kActivationBehavior]?.(event);
		} else {
			behaviors[kLegacyCanceledActivationBehavior]?.();
		}
	}
	return !state.canceled;
}

/** Whether a target is a node sitting inside a shadow tree. */
function isShadowRootTarget(target: EventTarget | null): boolean {
	return target instanceof Node && isShadowRoot(getRoot(target));
}

function hasActivationBehavior(target: EventTarget): boolean {
	return (target as ActivationTarget)[kActivationBehavior] !== undefined;
}

/**
 * Run one struct of the path.
 *
 * The event's target is the nearest target at or before this struct, so a
 * listener on an ancestor sees the node the event was dispatched at.
 */
function invoke(event: Event, index: number, capturing: boolean): void {
	const state = event[kDispatchState];
	const struct = state.path[index];
	for (let i = index; i >= 0; i--) {
		const adjusted = state.path[i].shadowAdjustedTarget;
		if (adjusted !== null) {
			state.target = adjusted;
			break;
		}
	}
	state.relatedTarget = struct.relatedTarget;
	if (state.stopPropagation) return;
	state.currentTarget = struct.invocationTarget;
	const listeners = struct.invocationTarget[kListeners].slice();
	const found = innerInvoke(event, listeners, capturing);
	if (!found && state.trusted) {
		const legacyType = LEGACY_EVENT_TYPES.get(event.type);
		if (legacyType !== undefined) {
			const originalType = event.type;
			event[kSetEventType](legacyType);
			innerInvoke(event, listeners, capturing);
			event[kSetEventType](originalType);
		}
	}
}

/**
 * Call the listeners of one target, and report whether any of them was
 * listening for this type at all -- a target that heard nothing is where a
 * trusted event is offered again under its legacy type.
 */
function innerInvoke(
	event: Event,
	listeners: Listener[],
	capturing: boolean,
): boolean {
	const state = event[kDispatchState];
	let found = false;
	for (const listener of listeners) {
		if (listener.removed) continue;
		if (listener.type !== event.type) continue;
		found = true;
		if (capturing && !listener.capture) continue;
		if (!capturing && listener.capture) continue;
		if (listener.once) {
			const target = state.currentTarget as EventTarget;
			removeListener(target[kListeners], listener);
		}
		if (listener.passive) state.inPassiveListener = true;
		try {
			callListener(listener.callback, state.currentTarget, event);
		} catch (error) {
			reportError(error);
		}
		state.inPassiveListener = false;
		if (state.stopImmediate) break;
	}
	return found;
}

/**
 * Call a listener: a function with the current target as its this, or an
 * object whose handleEvent is looked up at the moment of the call.
 */
function callListener(
	callback: EventListenerOrEventListenerObject,
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

function reportError(error: unknown): void {
	const report = (globalThis as {reportError?: (e: unknown) => void})
		.reportError;
	if (report) {
		report(error);
	} else {
		// eslint-disable-next-line no-console
		console.error(error);
	}
}

/* ------------------------------------------------------------- live tables */

/**
 * The mutation counter every live collection reads.
 *
 * Any change to a tree -- a child inserted or removed, an attribute set --
 * bumps it. A collection whose cached list was computed at an older count
 * recomputes on its next access.
 */
let treeVersion = 0;

const kSync = Symbol("sync indexed properties");

interface Materializable {
	[kSync](): void;
}

/** Live collections that have materialized indexed properties. */
const materialized: Array<WeakRef<Materializable>> = [];
let materializedCompactAt = 8;

/**
 * Register a collection whose indexed properties must track the tree.
 *
 * Indexed access is a plain own property, not a proxy trap, so a collection
 * that has ever been indexed into is resynchronized as part of the mutation
 * that would otherwise leave those properties stale.
 */
function registerMaterialized(collection: Materializable): void {
	materialized.push(new WeakRef(collection));
	if (materialized.length >= materializedCompactAt) {
		let write = 0;
		for (let read = 0; read < materialized.length; read++) {
			if (materialized[read].deref() !== undefined) {
				materialized[write++] = materialized[read];
			}
		}
		materialized.length = write;
		materializedCompactAt = Math.max(8, write * 2);
	}
}

function bumpVersion(): void {
	treeVersion++;
	for (let i = 0; i < materialized.length; i++) {
		const collection = materialized[i].deref();
		if (collection !== undefined) syncMethod.call(collection);
	}
}

/* -------------------------------------------------------------------- node */

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const ENTITY_REFERENCE_NODE = 5;
const ENTITY_NODE = 6;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_TYPE_NODE = 10;
const DOCUMENT_FRAGMENT_NODE = 11;
const NOTATION_NODE = 12;

const DOCUMENT_POSITION_DISCONNECTED = 0x01;
const DOCUMENT_POSITION_PRECEDING = 0x02;
const DOCUMENT_POSITION_FOLLOWING = 0x04;
const DOCUMENT_POSITION_CONTAINS = 0x08;
const DOCUMENT_POSITION_CONTAINED_BY = 0x10;
const DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 0x20;

/** A stable per-node serial, so disconnected nodes order consistently. */
let nodeSerial = 0;
const kSerial = Symbol("node serial");

export class Node extends EventTarget {
	[kParent]: Node | null = null;
	[kFirstChild]: Node | null = null;
	[kLastChild]: Node | null = null;
	[kPrevious]: Node | null = null;
	[kNext]: Node | null = null;
	[kDocument]: Document;
	[kChildNodes]: NodeList | null = null;
	[kSerial]: number = ++nodeSerial;
	[kRegisteredObservers]: RegisteredObserver[] | null = null;

	static readonly ELEMENT_NODE = ELEMENT_NODE;
	static readonly ATTRIBUTE_NODE = ATTRIBUTE_NODE;
	static readonly TEXT_NODE = TEXT_NODE;
	static readonly CDATA_SECTION_NODE = CDATA_SECTION_NODE;
	static readonly ENTITY_REFERENCE_NODE = ENTITY_REFERENCE_NODE;
	static readonly ENTITY_NODE = ENTITY_NODE;
	static readonly PROCESSING_INSTRUCTION_NODE = PROCESSING_INSTRUCTION_NODE;
	static readonly COMMENT_NODE = COMMENT_NODE;
	static readonly DOCUMENT_NODE = DOCUMENT_NODE;
	static readonly DOCUMENT_TYPE_NODE = DOCUMENT_TYPE_NODE;
	static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
	static readonly NOTATION_NODE = NOTATION_NODE;
	static readonly DOCUMENT_POSITION_DISCONNECTED =
		DOCUMENT_POSITION_DISCONNECTED;
	static readonly DOCUMENT_POSITION_PRECEDING = DOCUMENT_POSITION_PRECEDING;
	static readonly DOCUMENT_POSITION_FOLLOWING = DOCUMENT_POSITION_FOLLOWING;
	static readonly DOCUMENT_POSITION_CONTAINS = DOCUMENT_POSITION_CONTAINS;
	static readonly DOCUMENT_POSITION_CONTAINED_BY =
		DOCUMENT_POSITION_CONTAINED_BY;
	static readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC =
		DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;

	constructor() {
		super();
		if (new.target === Node) {
			throw new TypeError("Illegal constructor");
		}
		// A Document is its own node document; every other node is given one by
		// the algorithm that creates it.
		this[kDocument] = this as unknown as Document;
	}

	/**
	 * The target a dispatch reaches next: a node's parent. A slottable that is
	 * assigned overrides this to reach its slot, which is where the composed
	 * tree continues.
	 */
	override [kGetTheParent](_event: Event): EventTarget | null {
		return this[kParent];
	}

	get nodeType(): number {
		return 0;
	}

	get nodeName(): string {
		return "";
	}

	get baseURI(): string {
		return this[kDocument][kDocumentURL];
	}

	get isConnected(): boolean {
		return shadowIncludingRoot(this).nodeType === DOCUMENT_NODE;
	}

	get ownerDocument(): Document | null {
		return this.nodeType === DOCUMENT_NODE
			? null
			: (this[kDocument] as Document);
	}

	getRootNode(options?: {composed?: boolean}): Node {
		const init = toDictionary<{composed?: boolean}>(
			options ?? {},
			"A GetRootNodeOptions",
		);
		return init.composed ? shadowIncludingRoot(this) : getRoot(this);
	}

	get parentNode(): Node | null {
		return this[kParent];
	}

	get parentElement(): Element | null {
		const parent = this[kParent];
		return parent !== null && parent.nodeType === ELEMENT_NODE
			? (parent as Element)
			: null;
	}

	hasChildNodes(): boolean {
		return this[kFirstChild] !== null;
	}

	get childNodes(): NodeList {
		let list = this[kChildNodes];
		if (list === null) {
			list = createChildNodeList(this);
			this[kChildNodes] = list;
		}
		return list;
	}

	get firstChild(): Node | null {
		return this[kFirstChild];
	}

	get lastChild(): Node | null {
		return this[kLastChild];
	}

	get previousSibling(): Node | null {
		return this[kPrevious];
	}

	get nextSibling(): Node | null {
		return this[kNext];
	}

	get nodeValue(): string | null {
		return null;
	}

	set nodeValue(_value: string | null) {
		// Overridden where a node has a value.
	}

	get textContent(): string | null {
		return null;
	}

	set textContent(_value: string | null) {
		// Overridden where a node has text content.
	}

	normalize(): void {
		const texts: Text[] = [];
		for (
			let node = this[kFirstChild];
			node !== null;
			node = nextInTree(node, this)
		) {
			if (node.nodeType === TEXT_NODE) texts.push(node as Text);
		}
		for (const text of texts) {
			if (text[kParent] === null) continue;
			if ((text as CharacterData)[kData].length === 0) {
				removeNode(text);
				continue;
			}
			let data = "";
			let sibling = text[kNext];
			while (sibling !== null && isExclusiveText(sibling)) {
				data += (sibling as CharacterData)[kData];
				sibling = sibling[kNext];
			}
			if (data !== "") {
				replaceData(
					text as CharacterData,
					(text as CharacterData)[kData].length,
					0,
					data,
				);
			}
			let current = text[kNext];
			while (current !== null && isExclusiveText(current)) {
				const next = current[kNext];
				removeNode(current);
				current = next;
			}
		}
	}

	cloneNode(deep = false): Node {
		if (isShadowRoot(this)) {
			throw domError("NotSupportedError", "A shadow root cannot be cloned");
		}
		return cloneNode(this, undefined, Boolean(deep));
	}

	isEqualNode(otherNode: Node | null): boolean {
		return otherNode != null && equalNodes(this, otherNode);
	}

	isSameNode(otherNode: Node | null): boolean {
		return this === otherNode;
	}

	compareDocumentPosition(other: Node): number {
		if (this === other) return 0;
		let node1: Node | null = other;
		let node2: Node | null = this;
		let attr1: Attr | null = null;
		let attr2: Attr | null = null;
		if (node1.nodeType === ATTRIBUTE_NODE) {
			attr1 = node1 as Attr;
			node1 = attr1.ownerElement;
		}
		if (node2.nodeType === ATTRIBUTE_NODE) {
			attr2 = node2 as Attr;
			node2 = attr2.ownerElement;
			if (attr1 !== null && node1 !== null && node1 === node2) {
				for (const attr of (node2 as Element)[kAttributeList]) {
					if (attr === attr1) {
						return (
							DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
							DOCUMENT_POSITION_PRECEDING
						);
					}
					if (attr === attr2) {
						return (
							DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
							DOCUMENT_POSITION_FOLLOWING
						);
					}
				}
			}
		}
		if (node1 === null || node2 === null || getRoot(node1) !== getRoot(node2)) {
			const first =
				node1 === null || node2 === null
					? this[kSerial] < other[kSerial]
					: getRoot(node2)[kSerial] < getRoot(node1)[kSerial];
			return (
				DOCUMENT_POSITION_DISCONNECTED +
				DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
				(first ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING)
			);
		}
		if (
			(isInclusiveAncestor(node1, node2) && attr1 === null) ||
			(node1 === node2 && attr2 !== null)
		) {
			return DOCUMENT_POSITION_CONTAINS + DOCUMENT_POSITION_PRECEDING;
		}
		if (
			(isInclusiveAncestor(node2, node1) && attr2 === null) ||
			(node1 === node2 && attr1 !== null)
		) {
			return DOCUMENT_POSITION_CONTAINED_BY + DOCUMENT_POSITION_FOLLOWING;
		}
		return precedesInTree(node1, node2)
			? DOCUMENT_POSITION_PRECEDING
			: DOCUMENT_POSITION_FOLLOWING;
	}

	contains(other: Node | null): boolean {
		return other != null && isInclusiveAncestor(this, other);
	}

	lookupPrefix(namespace: string | null): string | null {
		if (namespace == null || namespace === "") return null;
		switch (this.nodeType) {
			case ELEMENT_NODE:
				return locateNamespacePrefix(this as unknown as Element, namespace);
			case DOCUMENT_NODE: {
				const element = (this as unknown as Document).documentElement;
				return element === null
					? null
					: locateNamespacePrefix(element, namespace);
			}
			case DOCUMENT_TYPE_NODE:
			case DOCUMENT_FRAGMENT_NODE:
				return null;
			case ATTRIBUTE_NODE: {
				const owner = (this as unknown as Attr).ownerElement;
				return owner === null ? null : locateNamespacePrefix(owner, namespace);
			}
			default: {
				const parent = this.parentElement;
				return parent === null
					? null
					: locateNamespacePrefix(parent, namespace);
			}
		}
	}

	lookupNamespaceURI(prefix: string | null): string | null {
		const name = prefix == null || prefix === "" ? null : String(prefix);
		return locateNamespace(this, name);
	}

	isDefaultNamespace(namespace: string | null): boolean {
		const ns = namespace === "" ? null : namespace;
		return locateNamespace(this, null) === ns;
	}

	insertBefore(node: Node, child: Node | null): Node {
		if (arguments.length < 2) {
			throw new TypeError("insertBefore needs a node and a child");
		}
		return preInsert(node, this, child);
	}

	appendChild(node: Node): Node {
		if (arguments.length < 1) {
			throw new TypeError("appendChild needs a node");
		}
		return preInsert(node, this, null);
	}

	replaceChild(node: Node, child: Node): Node {
		if (arguments.length < 2) {
			throw new TypeError("replaceChild needs a node and a child");
		}
		return replaceChild(child, node, this);
	}

	removeChild(child: Node): Node {
		if (arguments.length < 1) {
			throw new TypeError("removeChild needs a child");
		}
		return preRemove(child, this);
	}

	/* The spec's per-node steps. Subclasses override; the algorithms call. */

	[kInsertionSteps](): void {}

	[kRemovingSteps](_oldParent: Node): void {}

	[kAdoptingSteps](_oldDocument: Document): void {}

	[kChildrenChanged](): void {}

	[kCloningSteps](_copy: Node, _document: Document, _deep: boolean): void {}

	[kCloneSingle](_document: Document): Node {
		throw domError("NotSupportedError", "That node cannot be cloned");
	}
}

for (const [name, value] of [
	["ELEMENT_NODE", ELEMENT_NODE],
	["ATTRIBUTE_NODE", ATTRIBUTE_NODE],
	["TEXT_NODE", TEXT_NODE],
	["CDATA_SECTION_NODE", CDATA_SECTION_NODE],
	["ENTITY_REFERENCE_NODE", ENTITY_REFERENCE_NODE],
	["ENTITY_NODE", ENTITY_NODE],
	["PROCESSING_INSTRUCTION_NODE", PROCESSING_INSTRUCTION_NODE],
	["COMMENT_NODE", COMMENT_NODE],
	["DOCUMENT_NODE", DOCUMENT_NODE],
	["DOCUMENT_TYPE_NODE", DOCUMENT_TYPE_NODE],
	["DOCUMENT_FRAGMENT_NODE", DOCUMENT_FRAGMENT_NODE],
	["NOTATION_NODE", NOTATION_NODE],
	["DOCUMENT_POSITION_DISCONNECTED", DOCUMENT_POSITION_DISCONNECTED],
	["DOCUMENT_POSITION_PRECEDING", DOCUMENT_POSITION_PRECEDING],
	["DOCUMENT_POSITION_FOLLOWING", DOCUMENT_POSITION_FOLLOWING],
	["DOCUMENT_POSITION_CONTAINS", DOCUMENT_POSITION_CONTAINS],
	["DOCUMENT_POSITION_CONTAINED_BY", DOCUMENT_POSITION_CONTAINED_BY],
	[
		"DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC",
		DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
	],
] as Array<[string, number]>) {
	Object.defineProperty(Node.prototype, name, {value, enumerable: true});
}

Object.defineProperty(Node.prototype, Symbol.toStringTag, {
	value: "Node",
	configurable: true,
});

/* --------------------------------------------------------- tree primitives */

function getRoot(node: Node): Node {
	let current = node;
	while (current[kParent] !== null) current = current[kParent] as Node;
	return current;
}

function isInclusiveAncestor(ancestor: Node, node: Node): boolean {
	let current: Node | null = node;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current[kParent];
	}
	return false;
}

/**
 * A host-including inclusive ancestor: the ancestor chain, stepping from a
 * fragment to its host where one exists.
 */
function isHostIncludingInclusiveAncestor(ancestor: Node, node: Node): boolean {
	if (isInclusiveAncestor(ancestor, node)) return true;
	const root = getRoot(node);
	if (root.nodeType === DOCUMENT_FRAGMENT_NODE) {
		const host = (root as DocumentFragment)[kHost];
		if (host != null) return isHostIncludingInclusiveAncestor(ancestor, host);
	}
	return false;
}

/**
 * A node's shadow-including root: the root, stepping from a shadow root to its
 * host and on up, so a node inside a shadow tree in a document roots at that
 * document.
 */
function shadowIncludingRoot(node: Node): Node {
	const root = getRoot(node);
	return isShadowRoot(root)
		? shadowIncludingRoot((root as ShadowRoot)[kHost] as Element)
		: root;
}

/** Whether ancestor is node, an ancestor of node, or a host above it. */
function isShadowIncludingInclusiveAncestor(
	ancestor: Node,
	node: Node,
): boolean {
	if (isInclusiveAncestor(ancestor, node)) return true;
	const root = getRoot(node);
	if (isShadowRoot(root)) {
		return isShadowIncludingInclusiveAncestor(
			ancestor,
			(root as ShadowRoot)[kHost] as Element,
		);
	}
	return false;
}

/**
 * Every shadow-including inclusive descendant, in shadow-including tree order:
 * a node, then its shadow root's tree, then its children's.
 */
function* shadowIncludingInclusiveDescendants(node: Node): Generator<Node> {
	yield node;
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot];
		if (shadow !== null) yield* shadowIncludingInclusiveDescendants(shadow);
	}
	for (let child = node[kFirstChild]; child !== null; child = child[kNext]) {
		yield* shadowIncludingInclusiveDescendants(child);
	}
}

/** The next node in tree order, stopping once the walk leaves the root. */
function nextInTree(node: Node, root: Node): Node | null {
	if (node[kFirstChild] !== null) return node[kFirstChild];
	let current: Node | null = node;
	while (current !== null && current !== root) {
		if (current[kNext] !== null) return current[kNext];
		current = current[kParent];
	}
	return null;
}

/** Every inclusive descendant of a node, in tree order. */
function* inclusiveDescendants(node: Node): Generator<Node> {
	let current: Node | null = node;
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

/** Every descendant of a node, in tree order. */
function* descendants(node: Node): Generator<Node> {
	let current = node[kFirstChild];
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

/** Every descendant element of a node, in tree order, into an array. */
function descendantElements(root: Node, into: Element[]): Element[] {
	let current = root[kFirstChild];
	while (current !== null) {
		if (current.nodeType === ELEMENT_NODE) into.push(current as Element);
		current = nextInTree(current, root);
	}
	return into;
}

/** Whether node1 precedes node2 in tree order; both share a root. */
function precedesInTree(node1: Node, node2: Node): boolean {
	const root = getRoot(node1);
	for (const node of inclusiveDescendants(root)) {
		if (node === node1) return true;
		if (node === node2) return false;
	}
	return false;
}

function isExclusiveText(node: Node): boolean {
	return node.nodeType === TEXT_NODE;
}

/* --------------------------------------------------- mutation: pre-insert */

function isCharacterData(node: Node): boolean {
	const type = node.nodeType;
	return (
		type === TEXT_NODE ||
		type === CDATA_SECTION_NODE ||
		type === COMMENT_NODE ||
		type === PROCESSING_INSTRUCTION_NODE
	);
}

function countChildren(parent: Node, type: number): number {
	let count = 0;
	for (let node = parent[kFirstChild]; node !== null; node = node[kNext]) {
		if (node.nodeType === type) count++;
	}
	return count;
}

function hasFollowing(child: Node | null, type: number): boolean {
	for (let node = child; node !== null; node = node[kNext]) {
		if (node.nodeType === type) return true;
	}
	return false;
}

function hasPreceding(child: Node | null, type: number): boolean {
	if (child === null) return false;
	for (let node = child[kPrevious]; node !== null; node = node[kPrevious]) {
		if (node.nodeType === type) return true;
	}
	return false;
}

/** Ensure pre-insertion validity of node into parent before child. */
function ensurePreInsertionValidity(
	node: Node,
	parent: Node,
	child: Node | null,
	replacingAll = false,
): void {
	const parentType = parent.nodeType;
	if (
		parentType !== DOCUMENT_NODE &&
		parentType !== DOCUMENT_FRAGMENT_NODE &&
		parentType !== ELEMENT_NODE
	) {
		throw hierarchyRequestError("That parent cannot have children");
	}
	if (isHostIncludingInclusiveAncestor(node, parent)) {
		throw hierarchyRequestError("A node cannot be inserted into itself");
	}
	if (child !== null && child[kParent] !== parent) {
		throw notFoundError("The reference child is not a child of that parent");
	}
	const type = node.nodeType;
	if (
		type !== DOCUMENT_FRAGMENT_NODE &&
		type !== DOCUMENT_TYPE_NODE &&
		type !== ELEMENT_NODE &&
		!isCharacterData(node)
	) {
		throw hierarchyRequestError("That node cannot be inserted");
	}
	if (
		(type === TEXT_NODE && parentType === DOCUMENT_NODE) ||
		(type === DOCUMENT_TYPE_NODE && parentType !== DOCUMENT_NODE)
	) {
		throw hierarchyRequestError("That node cannot go there");
	}
	if (parentType !== DOCUMENT_NODE) return;
	const elements = replacingAll ? 0 : countChildren(parent, ELEMENT_NODE);
	const doctypes = replacingAll ? 0 : countChildren(parent, DOCUMENT_TYPE_NODE);
	if (type === DOCUMENT_FRAGMENT_NODE) {
		const elementCount = countChildren(node, ELEMENT_NODE);
		if (elementCount > 1 || countChildren(node, TEXT_NODE) > 0) {
			throw hierarchyRequestError("That fragment cannot go in a document");
		}
		if (
			elementCount === 1 &&
			(elements > 0 ||
				(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
				hasFollowing(child, DOCUMENT_TYPE_NODE))
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === ELEMENT_NODE) {
		if (
			elements > 0 ||
			(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
			hasFollowing(child, DOCUMENT_TYPE_NODE)
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === DOCUMENT_TYPE_NODE) {
		if (
			doctypes > 0 ||
			(child !== null && hasPreceding(child, ELEMENT_NODE)) ||
			(child === null && elements > 0)
		) {
			throw hierarchyRequestError("A document can have one doctype child");
		}
	}
}

function preInsert(node: Node, parent: Node, child: Node | null): Node {
	if (!(node instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	if (child !== null && child !== undefined && !(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const reference = child ?? null;
	ensurePreInsertionValidity(node, parent, reference);
	let referenceChild = reference;
	if (referenceChild === node) referenceChild = node[kNext];
	insertNode(node, parent, referenceChild, false);
	return node;
}

/** Insert node into parent before child. */
function insertNode(
	node: Node,
	parent: Node,
	child: Node | null,
	suppressObservers: boolean,
): void {
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? childNodeArray(node) : [node];
	const count = nodes.length;
	if (count === 0) return;
	if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
		for (const child_ of nodes) removeNode(child_, true);
		queueTreeMutationRecord(node, [], nodes, null, null);
	}
	const previousSibling =
		child !== null ? child[kPrevious] : parent[kLastChild];
	const document = parent[kDocument];
	for (const inserted of nodes) {
		adoptNode(inserted, document);
		linkChild(inserted, parent, child);
		const shadow =
			parent.nodeType === ELEMENT_NODE
				? (parent as Element)[kShadowRoot]
				: null;
		if (shadow !== null) {
			if (shadow[kSlotAssignment] === "named") {
				if (isSlottable(inserted)) assignASlot(inserted as Slottable);
			} else {
				// A manual assignment names nodes rather than finding them, and
				// only a node the host still has counts: the host's child list
				// changing is what makes an assignment appear or disappear.
				assignSlottablesForTree(shadow);
			}
		}
		if (
			isShadowRoot(getRoot(parent)) &&
			parent instanceof HTMLSlotElement &&
			parent[kAssignedNodes].length === 0
		) {
			signalASlotChange(parent);
		}
		assignSlottablesForTree(getRoot(inserted));
		for (const descendant of shadowIncludingInclusiveDescendants(inserted)) {
			descendant[kInsertionSteps]();
			if (!descendant.isConnected) continue;
			if (descendant.nodeType !== ELEMENT_NODE) continue;
			const element = descendant as Element;
			if (element[kCustomState] === "custom") {
				enqueueCallbackReaction(element, "connectedCallback", []);
			} else {
				tryToUpgrade(element);
			}
		}
	}
	bumpVersion();
	if (!suppressObservers) {
		queueTreeMutationRecord(parent, nodes, [], previousSibling, child);
	}
	parent[kChildrenChanged]();
}

/** Splice a node into a parent's child list. */
function linkChild(node: Node, parent: Node, before: Node | null): void {
	node[kParent] = parent;
	if (before === null) {
		const last = parent[kLastChild];
		node[kPrevious] = last;
		node[kNext] = null;
		if (last === null) {
			parent[kFirstChild] = node;
		} else {
			last[kNext] = node;
		}
		parent[kLastChild] = node;
	} else {
		const previous = before[kPrevious];
		node[kPrevious] = previous;
		node[kNext] = before;
		before[kPrevious] = node;
		if (previous === null) {
			parent[kFirstChild] = node;
		} else {
			previous[kNext] = node;
		}
	}
}

function unlinkChild(node: Node): void {
	const parent = node[kParent] as Node;
	const previous = node[kPrevious];
	const next = node[kNext];
	if (previous === null) {
		parent[kFirstChild] = next;
	} else {
		previous[kNext] = next;
	}
	if (next === null) {
		parent[kLastChild] = previous;
	} else {
		next[kPrevious] = previous;
	}
	node[kParent] = null;
	node[kPrevious] = null;
	node[kNext] = null;
}

function childNodeArray(parent: Node): Node[] {
	const nodes: Node[] = [];
	for (let node = parent[kFirstChild]; node !== null; node = node[kNext]) {
		nodes.push(node);
	}
	return nodes;
}

/** Append, with the observers of the append suppressed. */
function appendNode(node: Node, parent: Node): Node {
	return preInsert(node, parent, null);
}

/* -------------------------------------------------- mutation: replace/remove */

function replaceChild(child: Node, node: Node, parent: Node): Node {
	if (!(node instanceof Node) || !(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const parentType = parent.nodeType;
	if (
		parentType !== DOCUMENT_NODE &&
		parentType !== DOCUMENT_FRAGMENT_NODE &&
		parentType !== ELEMENT_NODE
	) {
		throw hierarchyRequestError("That parent cannot have children");
	}
	if (isHostIncludingInclusiveAncestor(node, parent)) {
		throw hierarchyRequestError("A node cannot be inserted into itself");
	}
	if (child[kParent] !== parent) {
		throw notFoundError("The replaced child is not a child of that parent");
	}
	const type = node.nodeType;
	if (
		type !== DOCUMENT_FRAGMENT_NODE &&
		type !== DOCUMENT_TYPE_NODE &&
		type !== ELEMENT_NODE &&
		!isCharacterData(node)
	) {
		throw hierarchyRequestError("That node cannot be inserted");
	}
	if (
		(type === TEXT_NODE && parentType === DOCUMENT_NODE) ||
		(type === DOCUMENT_TYPE_NODE && parentType !== DOCUMENT_NODE)
	) {
		throw hierarchyRequestError("That node cannot go there");
	}
	if (parentType === DOCUMENT_NODE) {
		if (type === DOCUMENT_FRAGMENT_NODE) {
			const elementCount = countChildren(node, ELEMENT_NODE);
			if (elementCount > 1 || countChildren(node, TEXT_NODE) > 0) {
				throw hierarchyRequestError("That fragment cannot go in a document");
			}
			if (
				elementCount === 1 &&
				(hasOtherElementChild(parent, child) ||
					hasFollowing(child[kNext], DOCUMENT_TYPE_NODE))
			) {
				throw hierarchyRequestError("A document can have one element child");
			}
		} else if (type === ELEMENT_NODE) {
			if (
				hasOtherElementChild(parent, child) ||
				hasFollowing(child[kNext], DOCUMENT_TYPE_NODE)
			) {
				throw hierarchyRequestError("A document can have one element child");
			}
		} else if (type === DOCUMENT_TYPE_NODE) {
			if (
				hasOtherDoctypeChild(parent, child) ||
				hasPreceding(child, ELEMENT_NODE)
			) {
				throw hierarchyRequestError("A document can have one doctype child");
			}
		}
	}
	let referenceChild = child[kNext];
	if (referenceChild === node) referenceChild = node[kNext];
	const previousSibling = child[kPrevious];
	const removedNodes: Node[] = [];
	// Adopting takes the replacement out of the tree it is in now, which is a
	// removal of its own and is reported as one. It happens before the
	// replaced child leaves, so that removal's siblings are the ones an
	// observer saw before any of this began.
	adoptNode(node, parent[kDocument]);
	if (child[kParent] !== null) {
		removedNodes.push(child);
		removeNode(child, true);
	}
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? childNodeArray(node) : [node];
	insertNode(node, parent, referenceChild, true);
	queueTreeMutationRecord(
		parent,
		nodes,
		removedNodes,
		previousSibling,
		referenceChild,
	);
	return child;
}

function hasOtherElementChild(parent: Node, exclude: Node): boolean {
	for (let node = parent[kFirstChild]; node !== null; node = node[kNext]) {
		if (node !== exclude && node.nodeType === ELEMENT_NODE) return true;
	}
	return false;
}

function hasOtherDoctypeChild(parent: Node, exclude: Node): boolean {
	for (let node = parent[kFirstChild]; node !== null; node = node[kNext]) {
		if (node !== exclude && node.nodeType === DOCUMENT_TYPE_NODE) return true;
	}
	return false;
}

/** Replace all of a parent's children with a node, or with nothing. */
function replaceAll(node: Node | null, parent: Node): void {
	if (node !== null) adoptNode(node, parent[kDocument]);
	const removedNodes = childNodeArray(parent);
	const addedNodes =
		node === null
			? []
			: node.nodeType === DOCUMENT_FRAGMENT_NODE
				? childNodeArray(node)
				: [node];
	for (const child of removedNodes) removeNode(child, true);
	if (node !== null) insertNode(node, parent, null, true);
	if (removedNodes.length > 0 || addedNodes.length > 0) {
		queueTreeMutationRecord(parent, addedNodes, removedNodes, null, null);
	}
}

function preRemove(child: Node, parent: Node): Node {
	if (!(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	if (child[kParent] !== parent) {
		throw notFoundError("The removed child is not a child of that parent");
	}
	removeNode(child);
	return child;
}

/** Remove a node from its parent. */
function removeNode(node: Node, suppressObservers = false): void {
	const parent = node[kParent];
	if (parent === null) return;
	for (const reference of node[kDocument][kNodeIterators]) {
		const iterator = reference.deref();
		if (iterator !== undefined) preRemoveFromIterator(iterator, node);
	}
	const oldPreviousSibling = node[kPrevious];
	const oldNextSibling = node[kNext];
	unlinkChild(node);
	const assignedSlot = isSlottable(node)
		? (node as Slottable)[kAssignedSlot]
		: null;
	if (assignedSlot !== null) assignSlottables(assignedSlot);
	const hostShadow =
		parent.nodeType === ELEMENT_NODE ? (parent as Element)[kShadowRoot] : null;
	if (hostShadow !== null && hostShadow[kSlotAssignment] === "manual") {
		assignSlottablesForTree(hostShadow);
	}
	if (
		isShadowRoot(getRoot(parent)) &&
		parent instanceof HTMLSlotElement &&
		parent[kAssignedNodes].length === 0
	) {
		signalASlotChange(parent);
	}
	if (hasInclusiveDescendantSlot(node)) {
		assignSlottablesForTree(getRoot(parent));
		assignSlottablesForTree(node);
	}
	const parentWasConnected = parent.isConnected;
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		descendant[kRemovingSteps](parent);
		if (
			parentWasConnected &&
			descendant.nodeType === ELEMENT_NODE &&
			(descendant as Element)[kCustomState] === "custom"
		) {
			enqueueCallbackReaction(
				descendant as Element,
				"disconnectedCallback",
				[],
			);
		}
	}
	bumpVersion();
	addTransientObservers(node, parent);
	if (!suppressObservers) {
		queueTreeMutationRecord(
			parent,
			[],
			[node],
			oldPreviousSibling,
			oldNextSibling,
		);
	}
	parent[kChildrenChanged]();
}

/* --------------------------------------------------------- mutation: adopt */

function adoptNode(node: Node, document: Document): void {
	const oldDocument = node[kDocument];
	if (node[kParent] !== null) removeNode(node);
	if (oldDocument === document) return;
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		descendant[kDocument] = document;
		if (descendant.nodeType === ELEMENT_NODE) {
			for (const attr of (descendant as Element)[kAttributeList]) {
				attr[kDocument] = document;
			}
		}
	}
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		if (
			descendant.nodeType === ELEMENT_NODE &&
			(descendant as Element)[kCustomState] === "custom"
		) {
			enqueueCallbackReaction(descendant as Element, "adoptedCallback", [
				oldDocument,
				document,
			]);
		}
		descendant[kAdoptingSteps](oldDocument);
	}
}

/* ----------------------------------------------------- mutation observers */

const kObserveNode = Symbol("add a node to an observer's node list");
const kEnqueueRecord = Symbol("enqueue a record");
const kNotifyObserver = Symbol("deliver an observer's records");

export interface MutationObserverInit {
	childList?: boolean;
	attributes?: boolean;
	characterData?: boolean;
	subtree?: boolean;
	attributeOldValue?: boolean;
	characterDataOldValue?: boolean;
	attributeFilter?: Iterable<string>;
}

export type MutationCallback = (
	records: MutationRecord[],
	observer: MutationObserver,
) => void;

/**
 * An observe() dictionary once observe() has defaulted it.
 *
 * attributes, characterData and their old-value members stay tri-state:
 * a member that was never given is not the same as one given as false, and
 * both the defaulting rules and the record filter read the difference.
 */
interface ObserverOptions {
	childList: boolean;
	attributes: boolean | undefined;
	characterData: boolean | undefined;
	subtree: boolean;
	attributeOldValue: boolean | undefined;
	characterDataOldValue: boolean | undefined;
	attributeFilter: string[] | undefined;
}

/**
 * One entry of a node's registered observer list.
 *
 * An entry with a source is transient: it was copied onto a node as that node
 * was removed from a tree an observer was watching with subtree, so mutations
 * inside the removed subtree still reach that observer until it is next
 * notified.
 */
interface RegisteredObserver {
	observer: MutationObserver;
	options: ObserverOptions;
	source: RegisteredObserver | null;
}

/**
 * How many registered observers exist, transient ones included.
 *
 * While it is zero the three queueing call sites return before walking any
 * ancestors, so a tree nobody observes pays nothing for the machinery.
 */
let registeredObserverCount = 0;

/** The agent's "mutation observer microtask queued" flag. */
let mutationObserverMicrotaskQueued = false;

/** The agent's pending mutation observers. */
const pendingMutationObservers = new Set<MutationObserver>();

function queueMutationObserverMicrotask(): void {
	if (mutationObserverMicrotaskQueued) return;
	mutationObserverMicrotaskQueued = true;
	queueMicrotask(notifyMutationObservers);
}

/**
 * Deliver every pending observer's records.
 *
 * This runs as a microtask, so a script sees the records of everything it did
 * before it yields, in one callback per observer.
 */
function notifyMutationObservers(): void {
	mutationObserverMicrotaskQueued = false;
	const notifySet = [...pendingMutationObservers];
	pendingMutationObservers.clear();
	const signalSet = signalSlots.splice(0, signalSlots.length);
	for (const observer of notifySet) observer[kNotifyObserver]();
	for (const slot of signalSet) {
		const event = new Event("slotchange", {bubbles: true});
		dispatch(slot, event);
	}
}

function registeredObserverList(node: Node): RegisteredObserver[] {
	let list = node[kRegisteredObservers];
	if (list === null) {
		list = [];
		node[kRegisteredObservers] = list;
	}
	return list;
}

/**
 * Copy every subtree registration above a node onto the node itself, as it
 * leaves the tree.
 *
 * One transient entry per source is enough: two entries with the same source
 * would report the same mutation to the same observer, which the record queue
 * collapses anyway.
 */
function addTransientObservers(node: Node, parent: Node): void {
	if (registeredObserverCount === 0) return;
	for (
		let ancestor: Node | null = parent;
		ancestor !== null;
		ancestor = ancestor[kParent]
	) {
		const list = ancestor[kRegisteredObservers];
		if (list === null) continue;
		for (const registered of list) {
			if (registered.options.subtree !== true) continue;
			appendTransientObserver(node, registered);
		}
	}
}

function appendTransientObserver(node: Node, source: RegisteredObserver): void {
	const list = registeredObserverList(node);
	for (const existing of list) {
		if (existing.source === source) return;
	}
	list.push({observer: source.observer, options: source.options, source});
	registeredObserverCount++;
	source.observer[kObserveNode](node);
}

/** Drop the transient entries of a node's list that a predicate names. */
function removeTransientObservers(
	node: Node,
	matches: (registered: RegisteredObserver) => boolean,
): void {
	const list = node[kRegisteredObservers];
	if (list === null) return;
	for (let index = list.length - 1; index >= 0; index--) {
		const registered = list[index];
		if (registered.source === null || !matches(registered)) continue;
		list.splice(index, 1);
		registeredObserverCount--;
	}
}

/** A record of one mutation, as an observer's callback receives it. */
export class MutationRecord {
	#type: string;
	#target: Node;
	#addedNodes: NodeList;
	#removedNodes: NodeList;
	#previousSibling: Node | null;
	#nextSibling: Node | null;
	#attributeName: string | null;
	#attributeNamespace: string | null;
	#oldValue: string | null;

	constructor(
		type: string,
		target: Node,
		attributeName: string | null,
		attributeNamespace: string | null,
		oldValue: string | null,
		addedNodes: Node[],
		removedNodes: Node[],
		previousSibling: Node | null,
		nextSibling: Node | null,
	) {
		this.#type = type;
		this.#target = target;
		this.#attributeName = attributeName;
		this.#attributeNamespace = attributeNamespace;
		this.#oldValue = oldValue;
		this.#addedNodes = createStaticNodeList(addedNodes);
		this.#removedNodes = createStaticNodeList(removedNodes);
		this.#previousSibling = previousSibling;
		this.#nextSibling = nextSibling;
	}

	get type(): string {
		return this.#type;
	}

	get target(): Node {
		return this.#target;
	}

	get addedNodes(): NodeList {
		return this.#addedNodes;
	}

	get removedNodes(): NodeList {
		return this.#removedNodes;
	}

	get previousSibling(): Node | null {
		return this.#previousSibling;
	}

	get nextSibling(): Node | null {
		return this.#nextSibling;
	}

	get attributeName(): string | null {
		return this.#attributeName;
	}

	get attributeNamespace(): string | null {
		return this.#attributeNamespace;
	}

	get oldValue(): string | null {
		return this.#oldValue;
	}
}

Object.defineProperty(MutationRecord.prototype, Symbol.toStringTag, {
	value: "MutationRecord",
	configurable: true,
});

/**
 * An observe() options argument, defaulted and checked.
 *
 * Giving an old value or a filter is a way of asking for the mutations it
 * describes, so it turns its own kind of observation on; asking for an old
 * value of something explicitly not observed is a contradiction and throws.
 */
function normalizeObserverOptions(
	options: MutationObserverInit,
): ObserverOptions {
	const init = toDictionary<MutationObserverInit>(options, "Observe options");
	const attributeFilter =
		init.attributeFilter === undefined
			? undefined
			: toStringSequence(init.attributeFilter);
	const attributeOldValue =
		init.attributeOldValue === undefined
			? undefined
			: Boolean(init.attributeOldValue);
	const characterDataOldValue =
		init.characterDataOldValue === undefined
			? undefined
			: Boolean(init.characterDataOldValue);
	let attributes =
		init.attributes === undefined ? undefined : Boolean(init.attributes);
	let characterData =
		init.characterData === undefined ? undefined : Boolean(init.characterData);
	const childList = Boolean(init.childList);
	if (
		(attributeOldValue !== undefined || attributeFilter !== undefined) &&
		attributes === undefined
	) {
		attributes = true;
	}
	if (characterDataOldValue !== undefined && characterData === undefined) {
		characterData = true;
	}
	if (!childList && attributes !== true && characterData !== true) {
		throw new TypeError("observe needs childList, attributes or characterData");
	}
	if (attributeOldValue === true && attributes === false) {
		throw new TypeError("attributeOldValue needs attributes");
	}
	if (attributeFilter !== undefined && attributes === false) {
		throw new TypeError("attributeFilter needs attributes");
	}
	if (characterDataOldValue === true && characterData === false) {
		throw new TypeError("characterDataOldValue needs characterData");
	}
	return {
		childList,
		attributes,
		characterData,
		subtree: Boolean(init.subtree),
		attributeOldValue,
		characterDataOldValue,
		attributeFilter,
	};
}

/** A sequence<DOMString> argument, per Web IDL: anything iterable. */
function toStringSequence(value: Iterable<string>): string[] {
	if (
		value === null ||
		typeof value !== "object" ||
		typeof (value as {[Symbol.iterator]?: unknown})[Symbol.iterator] !==
			"function"
	) {
		throw new TypeError("That is not a sequence of strings");
	}
	return [...value].map((entry) => String(entry));
}

/** An observer of a tree: what it watches, and the records it has to deliver. */
export class MutationObserver {
	#callback: MutationCallback;
	#nodes: Array<WeakRef<Node>> = [];
	#records: MutationRecord[] = [];

	constructor(callback: MutationCallback) {
		if (arguments.length < 1) {
			throw new TypeError("MutationObserver needs a callback");
		}
		if (typeof callback !== "function") {
			throw new TypeError("A MutationObserver callback must be a function");
		}
		this.#callback = callback;
	}

	observe(target: Node, options: MutationObserverInit = {}): void {
		if (arguments.length < 1) {
			throw new TypeError("observe needs a target");
		}
		if (!(target instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const normalized = normalizeObserverOptions(options);
		const list = registeredObserverList(target);
		for (const registered of list) {
			if (registered.observer !== this || registered.source !== null) continue;
			for (const node of this.#liveNodes()) {
				removeTransientObservers(node, (entry) => entry.source === registered);
			}
			registered.options = normalized;
			return;
		}
		list.push({observer: this, options: normalized, source: null});
		registeredObserverCount++;
		this[kObserveNode](target);
	}

	disconnect(): void {
		for (const node of this.#liveNodes()) {
			const list = node[kRegisteredObservers];
			if (list === null) continue;
			for (let index = list.length - 1; index >= 0; index--) {
				if (list[index].observer !== this) continue;
				list.splice(index, 1);
				registeredObserverCount--;
			}
		}
		this.#nodes.length = 0;
		this.#records.length = 0;
	}

	takeRecords(): MutationRecord[] {
		const records = this.#records;
		this.#records = [];
		return records;
	}

	/** The nodes still alive whose registered observer list names this one. */
	#liveNodes(): Node[] {
		const nodes: Node[] = [];
		let write = 0;
		for (let read = 0; read < this.#nodes.length; read++) {
			const node = this.#nodes[read].deref();
			if (node === undefined) continue;
			this.#nodes[write++] = this.#nodes[read];
			nodes.push(node);
		}
		this.#nodes.length = write;
		return nodes;
	}

	[kObserveNode](node: Node): void {
		for (const reference of this.#nodes) {
			if (reference.deref() === node) return;
		}
		this.#nodes.push(new WeakRef(node));
	}

	[kEnqueueRecord](record: MutationRecord): void {
		this.#records.push(record);
	}

	[kNotifyObserver](): void {
		const records = this.#records;
		this.#records = [];
		for (const node of this.#liveNodes()) {
			removeTransientObservers(node, () => true);
		}
		if (records.length === 0) return;
		try {
			this.#callback.call(this, records, this);
		} catch (error) {
			reportError(error);
		}
	}
}

Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, {
	value: "MutationObserver",
	configurable: true,
});

/* --------------------------------------------------------- mutation record */

/**
 * Queue a record with every observer that asked for this kind of mutation.
 *
 * The walk is up the ancestor chain from the mutated node: a registration on
 * the node itself always matches, and one further up matches only if it was
 * made with subtree. An observer that matches more than once still gets one
 * record, carrying an old value if any of its matching registrations asked
 * for one.
 */
function queueMutationRecord(
	type: string,
	target: Node,
	name: string | null,
	namespace: string | null,
	oldValue: string | null,
	addedNodes: Node[],
	removedNodes: Node[],
	previousSibling: Node | null,
	nextSibling: Node | null,
): void {
	if (registeredObserverCount === 0) return;
	let interested: Map<MutationObserver, string | null> | null = null;
	for (let node: Node | null = target; node !== null; node = node[kParent]) {
		const list = node[kRegisteredObservers];
		if (list === null) continue;
		for (const registered of list) {
			const options = registered.options;
			if (node !== target && options.subtree !== true) continue;
			if (type === "attributes") {
				if (options.attributes !== true) continue;
				if (
					options.attributeFilter !== undefined &&
					(namespace !== null ||
						!options.attributeFilter.includes(name as string))
				) {
					continue;
				}
			} else if (type === "characterData") {
				if (options.characterData !== true) continue;
			} else if (!options.childList) {
				continue;
			}
			const observer = registered.observer;
			if (interested === null) interested = new Map();
			if (!interested.has(observer)) interested.set(observer, null);
			if (
				(type === "attributes" && options.attributeOldValue === true) ||
				(type === "characterData" && options.characterDataOldValue === true)
			) {
				interested.set(observer, oldValue);
			}
		}
	}
	if (interested === null) return;
	for (const [observer, mappedOldValue] of interested) {
		observer[kEnqueueRecord](
			new MutationRecord(
				type,
				target,
				name,
				namespace,
				mappedOldValue,
				addedNodes,
				removedNodes,
				previousSibling,
				nextSibling,
			),
		);
		pendingMutationObservers.add(observer);
	}
	queueMutationObserverMicrotask();
}

/** Queue a record for a change to a node's children. */
function queueTreeMutationRecord(
	target: Node,
	addedNodes: Node[],
	removedNodes: Node[],
	previousSibling: Node | null,
	nextSibling: Node | null,
): void {
	queueMutationRecord(
		"childList",
		target,
		null,
		null,
		null,
		addedNodes,
		removedNodes,
		previousSibling,
		nextSibling,
	);
}

/* ------------------------------------------------------- live collections */

const kEnsure = Symbol("recompute if stale");

/**
 * The list behind a live NodeList or HTMLCollection.
 *
 * Indexed access is an own accessor property rather than a proxy trap, so the
 * set of defined indices is resynchronized whenever the tree changes: a
 * collection that has been read once is registered, and every later mutation
 * recomputes it.
 */
abstract class LiveList implements Materializable {
	#version = -1;
	#items: Node[] = [];
	#defined = 0;
	#registered = false;
	#live: boolean;

	constructor(live: boolean) {
		this.#live = live;
	}

	abstract compute(): Node[];

	/** Extra own properties this collection exposes, by name. */
	namedProperties(_items: Node[]): Map<string, Node> | null {
		return null;
	}

	#names: string[] = [];

	[kEnsure](): Node[] {
		if (!this.#live) {
			if (this.#version === -1) {
				this.#version = 0;
				this.#items = this.compute();
				this.#materialize();
			}
			return this.#items;
		}
		if (!this.#registered) {
			this.#registered = true;
			registerMaterialized(this);
		}
		if (this.#version !== treeVersion) {
			this.#version = treeVersion;
			this.#items = this.compute();
			this.#materialize();
		}
		return this.#items;
	}

	[kSync](): void {
		if (!this.#registered) return;
		this.#version = treeVersion;
		this.#items = this.compute();
		this.#materialize();
	}

	#materialize(): void {
		const items = this.#items;
		const self = this as unknown as Record<number | string, unknown>;
		const list = this;
		for (let index = this.#defined; index < items.length; index++) {
			const at = index;
			Object.defineProperty(this, at, {
				// The recompute is reached through the captured method, not
				// through the prototype: a caller may replace the prototype,
				// and an indexed property is meant to survive that.
				get(): unknown {
					return ensureMethod.call(list)[at] ?? undefined;
				},
				enumerable: true,
				configurable: true,
			});
		}
		for (let index = items.length; index < this.#defined; index++) {
			delete self[index];
		}
		this.#defined = items.length;
		for (const name of this.#names) delete self[name];
		this.#names = [];
		const named = this.namedProperties(items);
		if (named !== null) {
			for (const [name, node] of named) {
				if (name === "" || Object.prototype.hasOwnProperty.call(self, name)) {
					continue;
				}
				if (name in (this.constructor as {prototype: object}).prototype) {
					continue;
				}
				this.#names.push(name);
				Object.defineProperty(this, name, {
					value: node,
					enumerable: false,
					configurable: true,
					writable: false,
				});
			}
		}
	}
}

const ensureMethod = (
	LiveList.prototype as unknown as Record<symbol, () => Node[]>
)[kEnsure];
const syncMethod = (
	LiveList.prototype as unknown as Record<symbol, () => void>
)[kSync];

export class NodeList extends LiveList {
	declare forEach: (
		callback: (node: Node, index: number, list: NodeList) => void,
		thisArg?: unknown,
	) => void;
	declare keys: () => IterableIterator<number>;
	declare values: () => IterableIterator<Node>;
	declare entries: () => IterableIterator<[number, Node]>;
	declare [Symbol.iterator]: () => IterableIterator<Node>;

	#compute: () => Node[];

	constructor(compute: () => Node[], live: boolean) {
		super(live);
		this.#compute = compute;
	}

	override compute(): Node[] {
		return this.#compute();
	}

	get length(): number {
		return this[kEnsure]().length;
	}

	item(index: number): Node | null {
		const items = this[kEnsure]();
		const at = toUnsignedLong(index);
		return at < items.length ? items[at] : null;
	}
}

Object.defineProperty(NodeList.prototype, Symbol.toStringTag, {
	value: "NodeList",
	configurable: true,
});

export class HTMLCollection extends LiveList {
	declare [Symbol.iterator]: () => IterableIterator<Element>;

	#compute: () => Element[];

	constructor(compute: () => Element[]) {
		super(true);
		this.#compute = compute;
	}

	override compute(): Node[] {
		return this.#compute();
	}

	override namedProperties(items: Node[]): Map<string, Node> {
		const named = new Map<string, Node>();
		for (const item of items) {
			const element = item as Element;
			const id = element.getAttribute("id");
			if (id !== null && id !== "" && !named.has(id)) named.set(id, element);
			if (element.namespaceURI === HTML_NAMESPACE) {
				const name = element.getAttribute("name");
				if (name !== null && name !== "" && !named.has(name)) {
					named.set(name, element);
				}
			}
		}
		return named;
	}

	get length(): number {
		return this[kEnsure]().length;
	}

	item(index: number): Element | null {
		const items = this[kEnsure]();
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Element) : null;
	}

	namedItem(name: string): Element | null {
		if (name === "") return null;
		const key = String(name);
		for (const item of this[kEnsure]()) {
			const element = item as Element;
			if (element.getAttribute("id") === key) return element;
			if (
				element.namespaceURI === HTML_NAMESPACE &&
				element.getAttribute("name") === key
			) {
				return element;
			}
		}
		return null;
	}
}

Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, {
	value: "HTMLCollection",
	configurable: true,
});

function toUnsignedLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	const truncated = Math.trunc(number);
	return ((truncated % 4294967296) + 4294967296) % 4294967296;
}

function createChildNodeList(node: Node): NodeList {
	const list = new NodeList(() => childNodeArray(node), true);
	list[kEnsure]();
	return list;
}

function createStaticNodeList(nodes: Node[]): NodeList {
	const list = new NodeList(() => nodes, false);
	list[kEnsure]();
	return list;
}

/** A collection cache keyed by kind and name, so identity is stable. */
function collectionCache(node: Node): Map<string, HTMLCollection> {
	const owner = node as unknown as Record<symbol, unknown>;
	let cache = owner[kCollectionCaches] as
		| Map<string, HTMLCollection>
		| undefined;
	if (cache === undefined) {
		cache = new Map();
		owner[kCollectionCaches] = cache;
	}
	return cache;
}

function elementChildren(parent: Node): Element[] {
	const elements: Element[] = [];
	for (let node = parent[kFirstChild]; node !== null; node = node[kNext]) {
		if (node.nodeType === ELEMENT_NODE) elements.push(node as Element);
	}
	return elements;
}

function elementsByTagName(root: Node, qualifiedName: string): HTMLCollection {
	const cache = collectionCache(root);
	const key = `tag:${qualifiedName}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const lowered = asciiLowercase(qualifiedName);
		collection = new HTMLCollection(() => {
			const all = descendantElements(root, []);
			if (qualifiedName === "*") return all;
			const found: Element[] = [];
			for (const element of all) {
				const name =
					element[kPrefix] === null
						? element[kLocalName]
						: `${element[kPrefix]}:${element[kLocalName]}`;
				if (element[kNamespace] === HTML_NAMESPACE) {
					if (name === lowered) found.push(element);
				} else if (name === qualifiedName) {
					found.push(element);
				}
			}
			return found;
		});
		collection[kEnsure]();
		cache.set(key, collection);
	}
	return collection;
}

function elementsByTagNameNS(
	root: Node,
	namespace: string | null,
	localName: string,
): HTMLCollection {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	const cache = collectionCache(root);
	const key = `tagns:${ns}:${localName}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		collection = new HTMLCollection(() => {
			const found: Element[] = [];
			for (const element of descendantElements(root, [])) {
				if (ns !== "*" && element[kNamespace] !== ns) continue;
				if (localName !== "*" && element[kLocalName] !== localName) continue;
				found.push(element);
			}
			return found;
		});
		collection[kEnsure]();
		cache.set(key, collection);
	}
	return collection;
}

function elementsByClassName(root: Node, classNames: string): HTMLCollection {
	const cache = collectionCache(root);
	const key = `class:${classNames}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const classes = splitOnAsciiWhitespace(classNames);
		const quirks =
			root[kDocument][kMode] === "quirks"
				? classes.map((name) => asciiLowercase(name))
				: classes;
		collection = new HTMLCollection(() => {
			const found: Element[] = [];
			if (classes.length === 0) return found;
			const isQuirks = root[kDocument][kMode] === "quirks";
			const wanted = isQuirks ? quirks : classes;
			for (const element of descendantElements(root, [])) {
				const value = element.getAttribute("class");
				if (value === null) continue;
				const tokens = splitOnAsciiWhitespace(
					isQuirks ? asciiLowercase(value) : value,
				);
				let all = true;
				for (const name of wanted) {
					if (!tokens.includes(name)) {
						all = false;
						break;
					}
				}
				if (all) found.push(element);
			}
			return found;
		});
		collection[kEnsure]();
		cache.set(key, collection);
	}
	return collection;
}

/* ------------------------------------------------------------ token lists */

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

function splitOnAsciiWhitespace(value: string): string[] {
	const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	if (trimmed === "") return [];
	return trimmed.split(ASCII_WHITESPACE);
}

function asciiLowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 32),
	);
}

function asciiUppercase(value: string): string {
	return value.replace(/[a-z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) - 32),
	);
}

export class DOMTokenList extends LiveList {
	declare forEach: (
		callback: (token: string, index: number, list: DOMTokenList) => void,
		thisArg?: unknown,
	) => void;
	declare keys: () => IterableIterator<number>;
	declare values: () => IterableIterator<string>;
	declare entries: () => IterableIterator<[number, string]>;
	declare [Symbol.iterator]: () => IterableIterator<string>;

	#element: Element;
	#attribute: string;
	#supported: Set<string> | null;

	constructor(element: Element, attribute: string, supported?: string[]) {
		super(true);
		this.#element = element;
		this.#attribute = attribute;
		this.#supported = supported === undefined ? null : new Set(supported);
	}

	override compute(): Node[] {
		const value = this.#element.getAttribute(this.#attribute);
		const tokens = value === null ? [] : splitOnAsciiWhitespace(value);
		const ordered: string[] = [];
		for (const token of tokens) {
			if (!ordered.includes(token)) ordered.push(token);
		}
		return ordered as unknown as Node[];
	}

	get #tokens(): string[] {
		return this[kEnsure]() as unknown as string[];
	}

	get length(): number {
		return this.#tokens.length;
	}

	item(index: number): string | null {
		const tokens = this.#tokens;
		const at = toUnsignedLong(index);
		return at < tokens.length ? tokens[at] : null;
	}

	contains(token: string): boolean {
		return this.#tokens.includes(String(token));
	}

	add(...tokens: string[]): void {
		validateTokens(tokens);
		const current = this.#tokens.slice();
		for (const token of tokens) {
			if (!current.includes(token)) current.push(String(token));
		}
		this.#write(current);
	}

	remove(...tokens: string[]): void {
		validateTokens(tokens);
		const current = this.#tokens.filter(
			(each) => !tokens.some((token) => String(token) === each),
		);
		this.#write(current);
	}

	toggle(token: string, force?: boolean): boolean {
		validateTokens([token]);
		const name = String(token);
		const current = this.#tokens.slice();
		const index = current.indexOf(name);
		if (index !== -1) {
			if (force === undefined || force === false) {
				current.splice(index, 1);
				this.#write(current);
				return false;
			}
			return true;
		}
		if (force === undefined || force === true) {
			current.push(name);
			this.#write(current);
			return true;
		}
		return false;
	}

	replace(token: string, newToken: string): boolean {
		validateTokens([token, newToken]);
		const name = String(token);
		const replacement = String(newToken);
		const current = this.#tokens.slice();
		if (!current.includes(name)) return false;
		// The ordered set replacement: the first of either token becomes the
		// replacement, and every other instance of either is dropped.
		const first = Math.min(
			...[current.indexOf(name), current.indexOf(replacement)].filter(
				(index) => index !== -1,
			),
		);
		const replaced: string[] = [];
		for (let index = 0; index < current.length; index++) {
			if (index === first) {
				replaced.push(replacement);
			} else if (current[index] !== name && current[index] !== replacement) {
				replaced.push(current[index]);
			}
		}
		this.#write(replaced);
		return true;
	}

	supports(token: string): boolean {
		if (this.#supported === null) {
			throw new TypeError(`${this.#attribute} has no supported tokens`);
		}
		return this.#supported.has(asciiLowercase(String(token)));
	}

	get value(): string {
		return this.#element.getAttribute(this.#attribute) ?? "";
	}

	set value(value: string) {
		this.#element.setAttribute(this.#attribute, String(value));
	}

	override toString(): string {
		return this.value;
	}

	#write(tokens: string[]): void {
		if (this.#element.getAttributeNode(this.#attribute) === null) {
			if (tokens.length === 0) return;
		}
		this.#element.setAttribute(this.#attribute, tokens.join(" "));
	}
}

Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, {
	value: "DOMTokenList",
	configurable: true,
});

/**
 * The Array iteration functions, on the collections WebIDL says get them.
 *
 * An interface with an indexed property getter and a length takes
 * %Array.prototype%'s own functions -- the same function objects, not
 * lookalikes -- so a caller comparing them finds them equal, and iteration
 * reads length and index on each step, which keeps it live.
 */
function installArrayIteration(
	prototype: object,
	valueIterator: boolean,
): void {
	const members: Record<string | symbol, unknown> = {
		[Symbol.iterator]: Array.prototype[Symbol.iterator],
	};
	if (valueIterator) {
		members.keys = Array.prototype.keys;
		members.values = Array.prototype.values;
		members.entries = Array.prototype.entries;
		members.forEach = Array.prototype.forEach;
	}
	for (const key of Reflect.ownKeys(members)) {
		Object.defineProperty(prototype, key, {
			value: members[key as string],
			writable: true,
			enumerable: typeof key === "string",
			configurable: true,
		});
	}
}

function validateTokens(tokens: string[]): void {
	for (const token of tokens) {
		if (String(token) === "") {
			throw domError("SyntaxError", "A token cannot be the empty string");
		}
	}
	for (const token of tokens) {
		if (/[\t\n\f\r ]/.test(String(token))) {
			throw domError(
				"InvalidCharacterError",
				"A token cannot contain ASCII whitespace",
			);
		}
	}
}

/* --------------------------------------------------------- character data */

const kData = Symbol("data");

export class CharacterData extends Node {
	[kData]: string;

	constructor(data: string) {
		super();
		this[kData] = data;
	}

	get data(): string {
		return this[kData];
	}

	set data(value: string) {
		replaceData(
			this,
			0,
			this[kData].length,
			value === null ? "" : String(value),
		);
	}

	get length(): number {
		return this[kData].length;
	}

	override get nodeValue(): string | null {
		return this[kData];
	}

	override set nodeValue(value: string | null) {
		replaceData(this, 0, this[kData].length, nullableString(value));
	}

	override get textContent(): string | null {
		return this[kData];
	}

	override set textContent(value: string | null) {
		replaceData(this, 0, this[kData].length, nullableString(value));
	}

	substringData(offset: number, count: number): string {
		if (arguments.length < 2) {
			throw new TypeError("substringData needs an offset and a count");
		}
		const length = this[kData].length;
		const start = toUnsignedLong(offset);
		if (start > length) throw indexSizeError("The offset is past the end");
		const size = toUnsignedLong(count);
		if (start + size > length) return this[kData].slice(start);
		return this[kData].slice(start, start + size);
	}

	appendData(data: string): void {
		if (arguments.length < 1) throw new TypeError("appendData needs data");
		replaceData(this, this[kData].length, 0, String(data));
	}

	insertData(offset: number, data: string): void {
		if (arguments.length < 2) {
			throw new TypeError("insertData needs an offset and data");
		}
		replaceData(this, toUnsignedLong(offset), 0, String(data));
	}

	deleteData(offset: number, count: number): void {
		if (arguments.length < 2) {
			throw new TypeError("deleteData needs an offset and a count");
		}
		replaceData(this, toUnsignedLong(offset), toUnsignedLong(count), "");
	}

	replaceData(offset: number, count: number, data: string): void {
		if (arguments.length < 3) {
			throw new TypeError("replaceData needs an offset, a count and data");
		}
		replaceData(
			this,
			toUnsignedLong(offset),
			toUnsignedLong(count),
			String(data),
		);
	}
}

Object.defineProperty(CharacterData.prototype, Symbol.toStringTag, {
	value: "CharacterData",
	configurable: true,
});

/** A nullable DOMString: null and undefined are both the empty string. */
function nullableString(value: string | null | undefined): string {
	return value == null ? "" : String(value);
}

/** The spec's "replace data" algorithm. */
function replaceData(
	node: CharacterData,
	offset: number,
	count: number,
	data: string,
): void {
	const length = node[kData].length;
	if (offset > length) throw indexSizeError("The offset is past the end");
	const size = offset + count > length ? length - offset : count;
	const oldValue = node[kData];
	node[kData] =
		oldValue.slice(0, offset) + data + oldValue.slice(offset + size);
	queueCharacterDataMutationRecord(node, oldValue);
	bumpVersion();
	const parent = node[kParent];
	if (parent !== null) parent[kChildrenChanged]();
}

/** Queue a record for a change to a node's data. */
function queueCharacterDataMutationRecord(
	node: CharacterData,
	oldValue: string,
): void {
	queueMutationRecord(
		"characterData",
		node,
		null,
		null,
		oldValue,
		[],
		[],
		null,
		null,
	);
}

export class Text extends CharacterData {
	[kAssignedSlot]: HTMLSlotElement | null = null;
	[kManualSlot]: HTMLSlotElement | null = null;

	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kDocument] = currentDocument();
	}

	/** A slottable that is assigned reaches its slot before its parent. */
	override [kGetTheParent](_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent];
	}

	get assignedSlot(): HTMLSlotElement | null {
		return findASlot(this, true);
	}

	override get nodeType(): number {
		return TEXT_NODE;
	}

	override get nodeName(): string {
		return "#text";
	}

	splitText(offset: number): Text {
		if (arguments.length < 1) throw new TypeError("splitText needs an offset");
		const start = toUnsignedLong(offset);
		const length = this[kData].length;
		if (start > length) throw indexSizeError("The offset is past the end");
		const count = length - start;
		const data = this.substringData(start, count);
		const created = new Text(data);
		created[kDocument] = this[kDocument];
		const parent = this[kParent];
		if (parent !== null) {
			insertNode(created, parent, this[kNext], false);
		}
		replaceData(this, start, count, "");
		return created;
	}

	get wholeText(): string {
		let start: Node = this;
		while (
			start[kPrevious] !== null &&
			isExclusiveText(start[kPrevious] as Node)
		) {
			start = start[kPrevious] as Node;
		}
		let text = "";
		for (
			let node: Node | null = start;
			node !== null && isExclusiveText(node);
			node = node[kNext]
		) {
			text += (node as CharacterData)[kData];
		}
		return text;
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new Text(this[kData]);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Text.prototype, Symbol.toStringTag, {
	value: "Text",
	configurable: true,
});

export class CDATASection extends Text {
	override get nodeType(): number {
		return CDATA_SECTION_NODE;
	}

	override get nodeName(): string {
		return "#cdata-section";
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new CDATASection(this[kData]);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(CDATASection.prototype, Symbol.toStringTag, {
	value: "CDATASection",
	configurable: true,
});

export class Comment extends CharacterData {
	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kDocument] = currentDocument();
	}

	override get nodeType(): number {
		return COMMENT_NODE;
	}

	override get nodeName(): string {
		return "#comment";
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new Comment(this[kData]);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Comment.prototype, Symbol.toStringTag, {
	value: "Comment",
	configurable: true,
});

const kTarget = Symbol("processing instruction target");

export class ProcessingInstruction extends CharacterData {
	[kTarget]: string;

	constructor(target: string, data: string) {
		super(data);
		this[kTarget] = target;
	}

	get target(): string {
		return this[kTarget];
	}

	override get nodeType(): number {
		return PROCESSING_INSTRUCTION_NODE;
	}

	override get nodeName(): string {
		return this[kTarget];
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new ProcessingInstruction(this[kTarget], this[kData]);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(ProcessingInstruction.prototype, Symbol.toStringTag, {
	value: "ProcessingInstruction",
	configurable: true,
});

/* ------------------------------------------------------------- doctype etc */

const kName = Symbol("doctype name");
const kPublicId = Symbol("public id");
const kSystemId = Symbol("system id");

export class DocumentType extends Node {
	[kName]: string;
	[kPublicId]: string;
	[kSystemId]: string;

	constructor(name: string, publicId: string, systemId: string) {
		super();
		this[kName] = name;
		this[kPublicId] = publicId;
		this[kSystemId] = systemId;
	}

	get name(): string {
		return this[kName];
	}

	get publicId(): string {
		return this[kPublicId];
	}

	get systemId(): string {
		return this[kSystemId];
	}

	override get nodeType(): number {
		return DOCUMENT_TYPE_NODE;
	}

	override get nodeName(): string {
		return this[kName];
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new DocumentType(
			this[kName],
			this[kPublicId],
			this[kSystemId],
		);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(DocumentType.prototype, Symbol.toStringTag, {
	value: "DocumentType",
	configurable: true,
});

export class DocumentFragment extends Node {
	[kHost]: Element | null = null;

	constructor() {
		super();
		this[kDocument] = currentDocument();
	}

	override get nodeType(): number {
		return DOCUMENT_FRAGMENT_NODE;
	}

	override get nodeName(): string {
		return "#document-fragment";
	}

	override get textContent(): string | null {
		return descendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	getElementById(elementId: string): Element | null {
		const id = String(elementId);
		if (id === "") return null;
		for (const node of descendants(this)) {
			if (node.nodeType === ELEMENT_NODE) {
				if ((node as Element).getAttribute("id") === id) return node as Element;
			}
		}
		return null;
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new DocumentFragment();
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(DocumentFragment.prototype, Symbol.toStringTag, {
	value: "DocumentFragment",
	configurable: true,
});

function descendantText(node: Node): string {
	let text = "";
	let current = node[kFirstChild];
	while (current !== null) {
		const type = current.nodeType;
		if (type === TEXT_NODE || type === CDATA_SECTION_NODE) {
			text += (current as CharacterData)[kData];
		}
		current = nextInTree(current, node);
	}
	return text;
}

function setDescendantText(node: Node, value: string | null): void {
	const string = nullableString(value);
	let replacement: Node | null = null;
	if (string !== "") {
		replacement = new Text(string);
		replacement[kDocument] = node[kDocument];
	}
	replaceAll(replacement, node);
}

/* ------------------------------------------------------------------- attrs */

const kNamespace = Symbol("namespace");
const kPrefix = Symbol("prefix");
const kLocalName = Symbol("local name");
const kValue = Symbol("attribute value");
const kOwnerElement = Symbol("owner element");
const kAttributeList = Symbol("attribute list");
const kQualifiedName = Symbol("qualified name");

export class Attr extends Node {
	[kNamespace]: string | null;
	[kPrefix]: string | null;
	[kLocalName]: string;
	[kValue]: string;
	[kOwnerElement]: Element | null = null;

	constructor(
		namespace: string | null,
		prefix: string | null,
		localName: string,
		value: string,
	) {
		super();
		this[kNamespace] = namespace;
		this[kPrefix] = prefix;
		this[kLocalName] = localName;
		this[kValue] = value;
	}

	get namespaceURI(): string | null {
		return this[kNamespace];
	}

	get prefix(): string | null {
		return this[kPrefix];
	}

	get localName(): string {
		return this[kLocalName];
	}

	get name(): string {
		return this[kQualifiedName];
	}

	get [kQualifiedName](): string {
		return this[kPrefix] === null
			? this[kLocalName]
			: `${this[kPrefix]}:${this[kLocalName]}`;
	}

	get value(): string {
		return this[kValue];
	}

	set value(value: string) {
		setExistingAttributeValue(this, value === null ? "null" : String(value));
	}

	get ownerElement(): Element | null {
		return this[kOwnerElement];
	}

	get specified(): boolean {
		return true;
	}

	override get nodeType(): number {
		return ATTRIBUTE_NODE;
	}

	override get nodeName(): string {
		return this[kQualifiedName];
	}

	override get nodeValue(): string | null {
		return this[kValue];
	}

	override set nodeValue(value: string | null) {
		setExistingAttributeValue(this, nullableString(value));
	}

	override get textContent(): string | null {
		return this[kValue];
	}

	override set textContent(value: string | null) {
		setExistingAttributeValue(this, nullableString(value));
	}

	override [kCloneSingle](document: Document): Node {
		const copy = new Attr(
			this[kNamespace],
			this[kPrefix],
			this[kLocalName],
			this[kValue],
		);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Attr.prototype, Symbol.toStringTag, {
	value: "Attr",
	configurable: true,
});

/** Set an existing attribute's value, running the attribute change steps. */
function setExistingAttributeValue(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement];
	if (element === null) {
		attribute[kValue] = value;
		return;
	}
	changeAttribute(attribute, value);
}

function changeAttribute(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement] as Element;
	const oldValue = attribute[kValue];
	queueAttributeMutationRecord(element, attribute, oldValue);
	element[kAttributeChanged](
		attribute[kLocalName],
		oldValue,
		value,
		attribute[kNamespace],
	);
	attribute[kValue] = value;
	bumpVersion();
}

function appendAttribute(element: Element, attribute: Attr): void {
	queueAttributeMutationRecord(element, attribute, null);
	element[kAttributeChanged](
		attribute[kLocalName],
		null,
		attribute[kValue],
		attribute[kNamespace],
	);
	element[kAttributeList].push(attribute);
	attribute[kOwnerElement] = element;
	bumpVersion();
}

function removeAttributeNode(element: Element, attribute: Attr): void {
	queueAttributeMutationRecord(element, attribute, attribute[kValue]);
	element[kAttributeChanged](
		attribute[kLocalName],
		attribute[kValue],
		null,
		attribute[kNamespace],
	);
	const list = element[kAttributeList];
	const index = list.indexOf(attribute);
	if (index !== -1) list.splice(index, 1);
	attribute[kOwnerElement] = null;
	bumpVersion();
}

function replaceAttribute(
	element: Element,
	oldAttribute: Attr,
	newAttribute: Attr,
): void {
	queueAttributeMutationRecord(element, oldAttribute, oldAttribute[kValue]);
	element[kAttributeChanged](
		newAttribute[kLocalName],
		oldAttribute[kValue],
		newAttribute[kValue],
		newAttribute[kNamespace],
	);
	const list = element[kAttributeList];
	list[list.indexOf(oldAttribute)] = newAttribute;
	newAttribute[kOwnerElement] = element;
	oldAttribute[kOwnerElement] = null;
	bumpVersion();
}

/** Queue a record for a change to an element's attribute. */
function queueAttributeMutationRecord(
	element: Element,
	attribute: Attr,
	oldValue: string | null,
): void {
	queueMutationRecord(
		"attributes",
		element,
		attribute[kLocalName],
		attribute[kNamespace],
		oldValue,
		[],
		[],
		null,
		null,
	);
}

function getAttributeByName(
	element: Element,
	qualifiedName: string,
): Attr | null {
	let name = qualifiedName;
	if (
		element[kNamespace] === HTML_NAMESPACE &&
		isHTMLDocument(element[kDocument])
	) {
		name = asciiLowercase(name);
	}
	for (const attribute of element[kAttributeList]) {
		if (attribute[kQualifiedName] === name) return attribute;
	}
	return null;
}

function getAttributeByNamespace(
	element: Element,
	namespace: string | null,
	localName: string,
): Attr | null {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	for (const attribute of element[kAttributeList]) {
		if (attribute[kNamespace] === ns && attribute[kLocalName] === localName) {
			return attribute;
		}
	}
	return null;
}

function setAttributeNode(element: Element, attribute: Attr): Attr | null {
	if (
		attribute[kOwnerElement] !== null &&
		attribute[kOwnerElement] !== element
	) {
		throw domError(
			"InUseAttributeError",
			"That attribute already belongs to an element",
		);
	}
	const existing = getAttributeByNamespace(
		element,
		attribute[kNamespace],
		attribute[kLocalName],
	);
	if (existing === attribute) return attribute;
	if (existing !== null) {
		replaceAttribute(element, existing, attribute);
		return existing;
	}
	appendAttribute(element, attribute);
	return null;
}

export class NamedNodeMap extends LiveList {
	declare [Symbol.iterator]: () => IterableIterator<Attr>;

	#element: Element;

	constructor(element: Element) {
		super(true);
		this.#element = element;
	}

	override compute(): Node[] {
		return this.#element[kAttributeList].slice();
	}

	override namedProperties(items: Node[]): Map<string, Node> {
		const named = new Map<string, Node>();
		const html =
			this.#element[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this.#element[kDocument]);
		for (const item of items) {
			const attribute = item as Attr;
			const name = attribute[kQualifiedName];
			if (html && asciiLowercase(name) !== name) continue;
			if (!named.has(name)) named.set(name, attribute);
		}
		return named;
	}

	get length(): number {
		return this[kEnsure]().length;
	}

	item(index: number): Attr | null {
		const items = this[kEnsure]();
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Attr) : null;
	}

	getNamedItem(qualifiedName: string): Attr | null {
		return getAttributeByName(this.#element, String(qualifiedName));
	}

	getNamedItemNS(namespace: string | null, localName: string): Attr | null {
		return getAttributeByNamespace(this.#element, namespace, String(localName));
	}

	setNamedItem(attr: Attr): Attr | null {
		return setAttributeNode(this.#element, attr);
	}

	setNamedItemNS(attr: Attr): Attr | null {
		return setAttributeNode(this.#element, attr);
	}

	removeNamedItem(qualifiedName: string): Attr {
		const attribute = getAttributeByName(this.#element, String(qualifiedName));
		if (attribute === null) throw notFoundError("There is no such attribute");
		removeAttributeNode(this.#element, attribute);
		return attribute;
	}

	removeNamedItemNS(namespace: string | null, localName: string): Attr {
		const attribute = getAttributeByNamespace(
			this.#element,
			namespace,
			String(localName),
		);
		if (attribute === null) throw notFoundError("There is no such attribute");
		removeAttributeNode(this.#element, attribute);
		return attribute;
	}
}

Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, {
	value: "NamedNodeMap",
	configurable: true,
});

installArrayIteration(NodeList.prototype, true);
installArrayIteration(DOMTokenList.prototype, true);
installArrayIteration(HTMLCollection.prototype, false);
installArrayIteration(NamedNodeMap.prototype, false);

/* ---------------------------------------------------------------- elements */

const kCustomState = Symbol("custom element state");
const kDefinition = Symbol("element definition");
const kIsValue = Symbol("is value");
const kClassList = Symbol("classList");
const kAttributesMap = Symbol("attributes");

type CustomElementState =
	| "uncustomized"
	| "undefined"
	| "failed"
	| "custom"
	| "precustomized";

/**
 * The interface an element name is built through.
 *
 * A name the DOM Standard gives behavior of its own -- slot, and the template
 * whose content fragment the parser fills -- is created through the class that
 * carries that behavior; every other name lands on one of the four namespace
 * interfaces. An author's definitions live in a CustomElementRegistry, which
 * is a separate table with a separate lifetime.
 */
class ElementRegistry {
	#byName = new Map<string, new () => Element>();

	define(
		namespace: string | null,
		localName: string,
		constructor: new () => Element,
	): void {
		this.#byName.set(`${namespace}|${localName}`, constructor);
	}

	lookup(
		namespace: string | null,
		localName: string,
	): (new () => Element) | null {
		return this.#byName.get(`${namespace}|${localName}`) ?? null;
	}
}

const builtinRegistry = new ElementRegistry();

/**
 * Whether the tree is building an element itself.
 *
 * The HTML element constructor is an author-facing algorithm: it asks which
 * custom element definition `new.target` names and throws when there is none.
 * The tree's own creation path needs the same classes with none of that, and
 * this flag is how the constructor tells the two apart.
 */
let internalConstruction = false;

/**
 * The HTML elements the HTML Standard gives no interface of their own: they
 * are HTMLElement, and every other unknown name is HTMLUnknownElement.
 */
const HTML_ELEMENT_NAMES = new Set([
	"abbr",
	"address",
	"article",
	"aside",
	"b",
	"bdi",
	"bdo",
	"cite",
	"code",
	"dd",
	"dfn",
	"dt",
	"em",
	"figcaption",
	"figure",
	"footer",
	"header",
	"hgroup",
	"i",
	"kbd",
	"main",
	"mark",
	"nav",
	"noscript",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"search",
	"section",
	"small",
	"strong",
	"sub",
	"summary",
	"sup",
	"u",
	"var",
	"wbr",
]);

/**
 * The names HTML gives an interface of their own. Those interfaces are the
 * HTML Standard's, not the DOM Standard's: here every one of them is
 * HTMLElement, which is what an element with no HTML behavior attached is.
 */
const HTML_KNOWN_NAMES = new Set([
	"a",
	"area",
	"audio",
	"base",
	"blockquote",
	"body",
	"br",
	"button",
	"canvas",
	"caption",
	"col",
	"colgroup",
	"data",
	"datalist",
	"del",
	"details",
	"dialog",
	"div",
	"dl",
	"embed",
	"fieldset",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"hr",
	"html",
	"iframe",
	"img",
	"input",
	"ins",
	"label",
	"legend",
	"li",
	"link",
	"map",
	"menu",
	"meta",
	"meter",
	"object",
	"ol",
	"optgroup",
	"option",
	"output",
	"p",
	"param",
	"picture",
	"pre",
	"progress",
	"q",
	"script",
	"select",
	"slot",
	"source",
	"span",
	"style",
	"table",
	"tbody",
	"td",
	"template",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"time",
	"title",
	"tr",
	"track",
	"ul",
	"video",
	// The obsolete names that still have an interface.
	"acronym",
	"basefont",
	"big",
	"center",
	"dir",
	"font",
	"frame",
	"frameset",
	"isindex",
	"keygen",
	"listing",
	"marquee",
	"nobr",
	"noembed",
	"noframes",
	"plaintext",
	"rb",
	"rtc",
	"strike",
	"tt",
	"xmp",
]);

export class Element extends Node {
	[kNamespace]: string | null = null;
	[kPrefix]: string | null = null;
	[kLocalName] = "";
	[kAttributeList]: Attr[] = [];
	[kCustomState]: CustomElementState = "uncustomized";
	[kDefinition]: CustomElementDefinition | null = null;
	[kIsValue]: string | null = null;
	[kClassList]: DOMTokenList | null = null;
	[kAttributesMap]: NamedNodeMap | null = null;
	[kChildren]: HTMLCollection | null = null;
	[kShadowRoot]: ShadowRoot | null = null;
	[kSlottableName] = "";
	[kAssignedSlot]: HTMLSlotElement | null = null;
	[kManualSlot]: HTMLSlotElement | null = null;
	[kReactionQueue]: Reaction[] | null = null;
	[kPseudoElements]: Map<string, Element> | null = null;

	constructor() {
		super();
		this[kDocument] = currentDocument();
	}

	/** A slottable that is assigned reaches its slot before its parent. */
	override [kGetTheParent](_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent];
	}

	override get nodeType(): number {
		return ELEMENT_NODE;
	}

	override get nodeName(): string {
		return this.tagName;
	}

	get [kQualifiedName](): string {
		return this[kPrefix] === null
			? this[kLocalName]
			: `${this[kPrefix]}:${this[kLocalName]}`;
	}

	get namespaceURI(): string | null {
		return this[kNamespace];
	}

	get prefix(): string | null {
		return this[kPrefix];
	}

	get localName(): string {
		return this[kLocalName];
	}

	get tagName(): string {
		const qualified = this[kQualifiedName];
		return this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument])
			? asciiUppercase(qualified)
			: qualified;
	}

	get id(): string {
		return this.getAttribute("id") ?? "";
	}

	set id(value: string) {
		this.setAttribute("id", String(value));
	}

	get className(): string {
		return this.getAttribute("class") ?? "";
	}

	set className(value: string) {
		this.setAttribute("class", String(value));
	}

	get classList(): DOMTokenList {
		let list = this[kClassList];
		if (list === null) {
			list = new DOMTokenList(this, "class");
			list[kEnsure]();
			this[kClassList] = list;
		}
		return list;
	}

	set classList(value: string) {
		this.setAttribute("class", String(value));
	}

	get slot(): string {
		return this.getAttribute("slot") ?? "";
	}

	set slot(value: string) {
		this.setAttribute("slot", String(value));
	}

	get assignedSlot(): HTMLSlotElement | null {
		return findASlot(this, true);
	}

	attachShadow(init: ShadowRootInit): ShadowRoot {
		const options = toDictionary<ShadowRootInit>(init, "A ShadowRootInit");
		const mode = String(options.mode);
		if (mode !== "open" && mode !== "closed") {
			throw new TypeError(`${mode} is not a shadow root mode`);
		}
		const slotAssignment =
			options.slotAssignment === undefined
				? "named"
				: String(options.slotAssignment);
		if (slotAssignment !== "named" && slotAssignment !== "manual") {
			throw new TypeError(`${slotAssignment} is not a slot assignment mode`);
		}
		attachShadowRoot(
			this,
			mode,
			Boolean(options.clonable),
			Boolean(options.serializable),
			Boolean(options.delegatesFocus),
			slotAssignment,
		);
		return this[kShadowRoot] as ShadowRoot;
	}

	get shadowRoot(): ShadowRoot | null {
		const shadow = this[kShadowRoot];
		if (shadow === null || shadow[kShadowMode] !== "open") return null;
		return shadow;
	}

	get attributes(): NamedNodeMap {
		let map = this[kAttributesMap];
		if (map === null) {
			map = new NamedNodeMap(this);
			map[kEnsure]();
			this[kAttributesMap] = map;
		}
		return map;
	}

	hasAttributes(): boolean {
		return this[kAttributeList].length > 0;
	}

	getAttributeNames(): string[] {
		return this[kAttributeList].map((attribute) => attribute[kQualifiedName]);
	}

	getAttribute(qualifiedName: string): string | null {
		const attribute = getAttributeByName(this, String(qualifiedName));
		return attribute === null ? null : attribute[kValue];
	}

	getAttributeNS(namespace: string | null, localName: string): string | null {
		const attribute = getAttributeByNamespace(
			this,
			namespace,
			String(localName),
		);
		return attribute === null ? null : attribute[kValue];
	}

	setAttribute(qualifiedName: string, value: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setAttribute needs a name and a value");
		}
		let name = String(qualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument])
		) {
			name = asciiLowercase(name);
		}
		const string = value === null ? "null" : String(value);
		for (const attribute of this[kAttributeList]) {
			if (attribute[kQualifiedName] === name) {
				changeAttribute(attribute, string);
				return;
			}
		}
		const attribute = new Attr(null, null, name, string);
		attribute[kDocument] = this[kDocument];
		appendAttribute(this, attribute);
	}

	setAttributeNS(
		namespace: string | null,
		qualifiedName: string,
		value: string,
	): void {
		if (arguments.length < 3) {
			throw new TypeError("setAttributeNS needs a namespace, name and value");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
			true,
		);
		setAttributeValue(
			this,
			extracted.localName,
			value === null ? "null" : String(value),
			extracted.prefix,
			extracted.namespace,
		);
	}

	removeAttribute(qualifiedName: string): void {
		const attribute = getAttributeByName(this, String(qualifiedName));
		if (attribute !== null) removeAttributeNode(this, attribute);
	}

	removeAttributeNS(namespace: string | null, localName: string): void {
		const attribute = getAttributeByNamespace(
			this,
			namespace,
			String(localName),
		);
		if (attribute !== null) removeAttributeNode(this, attribute);
	}

	toggleAttribute(qualifiedName: string, force?: boolean): boolean {
		let name = String(qualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument])
		) {
			name = asciiLowercase(name);
		}
		const attribute = getAttributeByName(this, name);
		if (attribute === null) {
			if (force === undefined || force === true) {
				const created = new Attr(null, null, name, "");
				created[kDocument] = this[kDocument];
				appendAttribute(this, created);
				return true;
			}
			return false;
		}
		if (force === undefined || force === false) {
			removeAttributeNode(this, attribute);
			return false;
		}
		return true;
	}

	hasAttribute(qualifiedName: string): boolean {
		let name = String(qualifiedName);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument])
		) {
			name = asciiLowercase(name);
		}
		for (const attribute of this[kAttributeList]) {
			if (attribute[kQualifiedName] === name) return true;
		}
		return false;
	}

	hasAttributeNS(namespace: string | null, localName: string): boolean {
		return getAttributeByNamespace(this, namespace, String(localName)) !== null;
	}

	getAttributeNode(qualifiedName: string): Attr | null {
		return getAttributeByName(this, String(qualifiedName));
	}

	getAttributeNodeNS(namespace: string | null, localName: string): Attr | null {
		return getAttributeByNamespace(this, namespace, String(localName));
	}

	setAttributeNode(attr: Attr): Attr | null {
		if (!(attr instanceof Attr)) throw new TypeError("That is not an Attr");
		return setAttributeNode(this, attr);
	}

	setAttributeNodeNS(attr: Attr): Attr | null {
		if (!(attr instanceof Attr)) throw new TypeError("That is not an Attr");
		return setAttributeNode(this, attr);
	}

	removeAttributeNode(attr: Attr): Attr {
		if (!(attr instanceof Attr)) throw new TypeError("That is not an Attr");
		if (!this[kAttributeList].includes(attr)) {
			throw notFoundError("That attribute is not on this element");
		}
		removeAttributeNode(this, attr);
		return attr;
	}

	getElementsByTagName(qualifiedName: string): HTMLCollection {
		return elementsByTagName(this, String(qualifiedName));
	}

	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollection {
		return elementsByTagNameNS(this, namespace, String(localName));
	}

	getElementsByClassName(classNames: string): HTMLCollection {
		return elementsByClassName(this, String(classNames));
	}

	override get textContent(): string | null {
		return descendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	get innerHTML(): string {
		return serializeFragment(this, false);
	}

	set innerHTML(value: string) {
		const fragment = parseFragmentHTML(String(value ?? ""), this);
		replaceAll(fragment, this);
	}

	getHTML(options?: {
		serializableShadowRoots?: boolean;
		shadowRoots?: ShadowRoot[];
	}): string {
		const init = toDictionary<{
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		}>(options ?? {}, "A GetHTMLOptions");
		return serializeFragment(
			this,
			Boolean(init.serializableShadowRoots),
			init.shadowRoots ?? [],
		);
	}

	setHTMLUnsafe(html: string): void {
		const fragment = parseFragmentHTML(String(html ?? ""), this, true);
		replaceAll(fragment, this);
	}

	get outerHTML(): string {
		return serializeOuterHTML(this);
	}

	set outerHTML(value: string) {
		const parent = this[kParent];
		if (parent === null) return;
		if (parent.nodeType === DOCUMENT_NODE) {
			throw domError(
				"NoModificationAllowedError",
				"A document element has no outer HTML to replace",
			);
		}
		const context =
			parent.nodeType === DOCUMENT_FRAGMENT_NODE
				? createElementInternal(this[kDocument], "body", HTML_NAMESPACE)
				: (parent as Element);
		const fragment = parseFragmentHTML(String(value ?? ""), context);
		replaceChild(this, fragment, parent);
	}

	insertAdjacentElement(where: string, element: Element): Element | null {
		return insertAdjacent(this, String(where), element) as Element | null;
	}

	insertAdjacentText(where: string, data: string): void {
		const text = new Text(String(data));
		text[kDocument] = this[kDocument];
		insertAdjacent(this, String(where), text);
	}

	insertAdjacentHTML(position: string, text: string): void {
		const where = asciiLowercase(String(position));
		let context: Node;
		switch (where) {
			case "beforebegin":
			case "afterend": {
				const parent = this[kParent];
				if (parent === null || parent.nodeType === DOCUMENT_NODE) {
					throw domError(
						"NoModificationAllowedError",
						"There is nowhere to insert that HTML",
					);
				}
				context =
					parent.nodeType === ELEMENT_NODE
						? parent
						: createElementInternal(this[kDocument], "body", HTML_NAMESPACE);
				break;
			}
			case "afterbegin":
			case "beforeend":
				context = this;
				break;
			default:
				throw domError("SyntaxError", `"${position}" is not a position`);
		}
		let element = context as Element;
		if (
			element.nodeType !== ELEMENT_NODE ||
			(isHTMLDocument(element[kDocument]) &&
				element[kLocalName] === "html" &&
				element[kNamespace] === HTML_NAMESPACE)
		) {
			element = createElementInternal(this[kDocument], "body", HTML_NAMESPACE);
		}
		const fragment = parseFragmentHTML(String(text), element);
		switch (where) {
			case "beforebegin":
				preInsert(fragment, this[kParent] as Node, this);
				break;
			case "afterbegin":
				preInsert(fragment, this, this[kFirstChild]);
				break;
			case "beforeend":
				preInsert(fragment, this, null);
				break;
			case "afterend":
				preInsert(fragment, this[kParent] as Node, this[kNext]);
				break;
		}
	}

	override [kInsertionSteps](): void {
		const root = getRoot(this);
		if (root.nodeType === DOCUMENT_NODE) {
			addToIdMap(root as Document, this);
		}
	}

	override [kRemovingSteps](oldParent: Node): void {
		const root = getRoot(oldParent);
		if (root.nodeType === DOCUMENT_NODE) {
			removeFromIdMap(root as Document, this);
		}
	}

	[kAttributeChanged](
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		if (localName === "id" && namespace === null) {
			const root = getRoot(this);
			if (root.nodeType === DOCUMENT_NODE) {
				const document = root as Document;
				if (oldValue !== null) removeIdEntry(document, oldValue, this);
				if (value !== null && value !== "") addIdEntry(document, value, this);
			}
		}
		if (namespace === null && localName === "slot") {
			updateSlottableName(this, oldValue, value);
		}
		if (
			namespace === null &&
			localName === "name" &&
			this instanceof HTMLSlotElement
		) {
			updateSlotName(this, oldValue, value);
		}
		if (this[kCustomState] === "custom") {
			enqueueCallbackReaction(this, "attributeChangedCallback", [
				localName,
				oldValue,
				value,
				namespace,
			]);
		}
	}

	override [kCloneSingle](document: Document): Node {
		const copy = createElementInternal(
			document,
			this[kLocalName],
			this[kNamespace],
			this[kPrefix],
			this[kIsValue],
			false,
		);
		for (const attribute of this[kAttributeList]) {
			const copiedAttribute = new Attr(
				attribute[kNamespace],
				attribute[kPrefix],
				attribute[kLocalName],
				attribute[kValue],
			);
			copiedAttribute[kDocument] = document;
			appendAttribute(copy, copiedAttribute);
		}
		return copy;
	}
}

Object.defineProperty(Element.prototype, Symbol.toStringTag, {
	value: "Element",
	configurable: true,
});

/**
 * The HTML element constructor.
 *
 * `new.target` is the whole mechanism: an author's class reaches this through
 * `super()`, and what it gets back depends on why it is running. Called while
 * an upgrade is in flight, it hands back the element already in the tree --
 * the construction stack's last entry -- so the author's constructor decorates
 * the node the parser built. Called on its own, it builds a fresh element with
 * the author's prototype. Either way the element is this class's, so an author
 * never sees a second object.
 *
 * The tree's own creation path does not come through here at all: it needs an
 * HTMLElement for every name HTML knows, and this constructor throws for a
 * new.target it cannot find a definition for.
 */
export class HTMLElement extends Element {
	constructor() {
		if (internalConstruction) {
			super();
			return;
		}
		// The checks come before the object. A constructor that names no
		// definition throws without anything having been allocated, and an
		// upgrade never allocates at all: it hands back the element already in
		// the tree, so super() runs only on the branch that builds one.
		const target = new.target as unknown as CustomElementConstructor;
		if (target === (HTMLElement as unknown as CustomElementConstructor)) {
			throw new TypeError("Illegal constructor");
		}
		const definition = globalCustomElements[kDefinitionFor](target);
		if (definition === null) {
			throw new TypeError("This constructor is not a custom element's");
		}
		if (definition.localName !== definition.name) {
			throw new TypeError(
				"A customized built-in element is not implemented here",
			);
		}
		const stack = definition.constructionStack;
		if (stack.length > 0) {
			// A prototype that is not an object is the interface's own, which is
			// what allocating from this constructor would have given the element.
			const named = (target as unknown as {prototype: unknown}).prototype;
			const prototype =
				named !== null && typeof named === "object"
					? (named as object)
					: HTMLElement.prototype;
			const element = stack[stack.length - 1];
			if (element === alreadyConstructed) {
				throw domError(
					"InvalidStateError",
					"That custom element is already being constructed",
				);
			}
			Object.setPrototypeOf(element, prototype);
			stack[stack.length - 1] = alreadyConstructed;
			// eslint-disable-next-line no-constructor-return
			return element as HTMLElement;
		}
		super();
		this[kNamespace] = HTML_NAMESPACE;
		this[kPrefix] = null;
		this[kLocalName] = definition.localName;
		this[kCustomState] = "custom";
		this[kDefinition] = definition;
		this[kIsValue] = null;
	}
}

Object.defineProperty(HTMLElement.prototype, Symbol.toStringTag, {
	value: "HTMLElement",
	configurable: true,
});

export class HTMLUnknownElement extends HTMLElement {}

Object.defineProperty(HTMLUnknownElement.prototype, Symbol.toStringTag, {
	value: "HTMLUnknownElement",
	configurable: true,
});

export class SVGElement extends Element {}

Object.defineProperty(SVGElement.prototype, Symbol.toStringTag, {
	value: "SVGElement",
	configurable: true,
});

export class MathMLElement extends Element {}

Object.defineProperty(MathMLElement.prototype, Symbol.toStringTag, {
	value: "MathMLElement",
	configurable: true,
});

/** Set an attribute value, creating the attribute where there is none. */
function setAttributeValue(
	element: Element,
	localName: string,
	value: string,
	prefix: string | null,
	namespace: string | null,
): void {
	const attribute = getAttributeByNamespace(element, namespace, localName);
	if (attribute === null) {
		const created = new Attr(namespace, prefix, localName, value);
		created[kDocument] = element[kDocument];
		appendAttribute(element, created);
		return;
	}
	changeAttribute(attribute, value);
}

/** The interface a name and a namespace are built through. */
function elementInterface(
	namespace: string | null,
	localName: string,
): new () => Element {
	const builtin = builtinRegistry.lookup(namespace, localName);
	if (builtin !== null) return builtin;
	if (namespace === HTML_NAMESPACE) {
		return HTML_KNOWN_NAMES.has(localName) ||
			HTML_ELEMENT_NAMES.has(localName) ||
			isValidCustomElementName(localName)
			? HTMLElement
			: HTMLUnknownElement;
	}
	if (namespace === SVG_NAMESPACE) return SVGElement;
	if (namespace === MATHML_NAMESPACE) return MathMLElement;
	return Element;
}

/** Build an element of an interface without running an author's constructor. */
function buildElement(
	document: Document,
	constructor: new () => Element,
	localName: string,
	namespace: string | null,
	prefix: string | null,
	is: string | null,
): Element {
	const previousDocument = currentDocumentForConstruction;
	const previousInternal = internalConstruction;
	currentDocumentForConstruction = document;
	internalConstruction = true;
	let element: Element;
	try {
		element = new constructor();
	} finally {
		currentDocumentForConstruction = previousDocument;
		internalConstruction = previousInternal;
	}
	element[kDocument] = document;
	element[kNamespace] = namespace;
	element[kPrefix] = prefix;
	element[kLocalName] = localName;
	element[kIsValue] = is;
	return element;
}

/**
 * The spec's "create an element" algorithm.
 *
 * With the synchronous flag set -- createElement and its kin -- an author's
 * constructor runs here and its result is checked to be a bare element of the
 * right name. Without it -- the parser -- the element is created undefined and
 * an upgrade reaction is enqueued, so the parser never re-enters script.
 */
function createElementInternal(
	document: Document,
	localName: string,
	namespace: string | null,
	prefix: string | null = null,
	is: string | null = null,
	synchronous = true,
): Element {
	const definition = lookUpCustomElementDefinition(namespace, localName, is);
	if (definition !== null && definition.name !== definition.localName) {
		throw domError(
			"NotSupportedError",
			"A customized built-in element is not implemented here",
		);
	}
	if (definition !== null) {
		if (!synchronous) {
			const element = buildElement(
				document,
				elementInterface(namespace, localName),
				localName,
				namespace,
				prefix,
				is,
			);
			element[kCustomState] = "undefined";
			enqueueUpgradeReaction(element, definition);
			return element;
		}
		let result: Element;
		try {
			result = constructCustomElement(definition);
			if (result[kCustomState] !== "custom" || result[kDefinition] === null) {
				throw new TypeError("That constructor did not build a custom element");
			}
			if (result[kAttributeList].length > 0) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not set attributes",
				);
			}
			if (result[kFirstChild] !== null) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not append children",
				);
			}
			if (result[kParent] !== null) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not insert the element",
				);
			}
			if (result[kDocument] !== document) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the node document",
				);
			}
			if (result[kNamespace] !== HTML_NAMESPACE) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the namespace",
				);
			}
			if (result[kLocalName] !== localName) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the local name",
				);
			}
		} catch (error) {
			reportError(error);
			const failed = buildElement(
				document,
				elementInterface(namespace, localName),
				localName,
				namespace,
				prefix,
				null,
			);
			failed[kCustomState] = "failed";
			return failed;
		}
		result[kPrefix] = prefix;
		result[kIsValue] = null;
		return result;
	}
	const element = buildElement(
		document,
		elementInterface(namespace, localName),
		localName,
		namespace,
		prefix,
		is,
	);
	element[kCustomState] =
		namespace === HTML_NAMESPACE &&
		(isValidCustomElementName(localName) || is !== null)
			? "undefined"
			: "uncustomized";
	return element;
}

const RESERVED_CUSTOM_NAMES = new Set([
	"annotation-xml",
	"color-profile",
	"font-face",
	"font-face-src",
	"font-face-uri",
	"font-face-format",
	"font-face-name",
	"missing-glyph",
]);

/**
 * A valid custom element name: a local name the parser will read as a tag,
 * beginning with a lower-case letter, carrying a hyphen and no upper-case
 * letter, and not one of the hyphenated names SVG and MathML already own.
 */
function isValidCustomElementName(name: string): boolean {
	return (
		VALID_ELEMENT_LOCAL_NAME.test(name) &&
		name.charCodeAt(0) >= 0x61 &&
		name.charCodeAt(0) <= 0x7a &&
		!/[A-Z]/.test(name) &&
		name.includes("-") &&
		!RESERVED_CUSTOM_NAMES.has(name)
	);
}

/* --------------------------------------------------- custom element reactions */

const kDefinitionFor = Symbol("the definition a constructor defines");
const kLookUp = Symbol("look up a custom element definition");

/** The marker an entry in a construction stack becomes once super() ran. */
const alreadyConstructed = Symbol("already constructed");

type CustomElementConstructor = new () => Element;

interface CustomElementDefinition {
	name: string;
	localName: string;
	constructor: CustomElementConstructor;
	observedAttributes: Set<string>;
	lifecycleCallbacks: Map<string, ((...args: unknown[]) => void) | null>;
	constructionStack: Array<Element | typeof alreadyConstructed>;
	formAssociated: boolean;
	disableInternals: boolean;
	disableShadow: boolean;
}

type Reaction =
	| {upgrade: CustomElementDefinition}
	| {callback: (...args: unknown[]) => void; args: unknown[]};

/**
 * The custom element reactions stack.
 *
 * Author code must see a lifecycle callback after the mutation that caused it
 * has finished, never in the middle of one: a queue is pushed when an API the
 * IDL marks [CEReactions] is entered and drained when it returns, so a script
 * that appends a subtree gets one connectedCallback per element, in tree
 * order, after the whole subtree is in place.
 */
const reactionsStack: Element[][] = [];

/**
 * Where a reaction goes when nothing on the stack claims it -- a mutation the
 * tree makes on its own behalf. The queue drains on a microtask, and the flag
 * keeps a reaction enqueued by that drain from starting a second one.
 */
const backupElementQueue: Element[] = [];
let processingBackupElementQueue = false;

function enqueueOnAppropriateElementQueue(element: Element): void {
	if (reactionsStack.length === 0) {
		backupElementQueue.push(element);
		if (processingBackupElementQueue) return;
		processingBackupElementQueue = true;
		queueMicrotask(() => {
			invokeReactions(backupElementQueue);
			processingBackupElementQueue = false;
		});
		return;
	}
	reactionsStack[reactionsStack.length - 1].push(element);
}

function elementReactionQueue(element: Element): Reaction[] {
	let queue = element[kReactionQueue];
	if (queue === null) {
		queue = [];
		element[kReactionQueue] = queue;
	}
	return queue;
}

function enqueueCallbackReaction(
	element: Element,
	callbackName: string,
	args: unknown[],
): void {
	const definition = element[kDefinition];
	if (definition === null) return;
	const callback = definition.lifecycleCallbacks.get(callbackName) ?? null;
	if (callback === null) return;
	if (
		callbackName === "attributeChangedCallback" &&
		!definition.observedAttributes.has(args[0] as string)
	) {
		return;
	}
	elementReactionQueue(element).push({callback, args});
	enqueueOnAppropriateElementQueue(element);
}

function enqueueUpgradeReaction(
	element: Element,
	definition: CustomElementDefinition,
): void {
	elementReactionQueue(element).push({upgrade: definition});
	enqueueOnAppropriateElementQueue(element);
}

/** Run every reaction every element in a queue has waiting. */
function invokeReactions(queue: Element[]): void {
	while (queue.length > 0) {
		const element = queue.shift() as Element;
		const reactions = element[kReactionQueue];
		if (reactions === null) continue;
		while (reactions.length > 0) {
			const reaction = reactions.shift() as Reaction;
			try {
				if ("upgrade" in reaction) {
					upgradeElement(element, reaction.upgrade);
				} else {
					reaction.callback.apply(element, reaction.args);
				}
			} catch (error) {
				reportError(error);
			}
		}
	}
}

/** The steps [CEReactions] adds around an operation. */
function withReactions<T>(steps: () => T): T {
	reactionsStack.push([]);
	try {
		return steps();
	} finally {
		invokeReactions(reactionsStack.pop() as Element[]);
	}
}

/**
 * Wrap the members the IDL marks [CEReactions] so that each is a reactions
 * boundary. A getter is never one -- the extended attribute cannot appear on a
 * readonly attribute -- so only values and setters are wrapped.
 */
function ceReactions(prototype: object, names: string[]): void {
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor === undefined) continue;
		if (typeof descriptor.value === "function") {
			descriptor.value = wrapWithReactions(
				descriptor.value as (...args: unknown[]) => unknown,
			);
		} else if (typeof descriptor.set === "function") {
			descriptor.set = wrapWithReactions(descriptor.set) as (
				value: unknown,
			) => void;
		} else {
			continue;
		}
		Object.defineProperty(prototype, name, descriptor);
	}
}

function wrapWithReactions(
	steps: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
	function wrapper(this: unknown, ...args: unknown[]): unknown {
		return withReactions(() => steps.apply(this, args));
	}
	Object.defineProperty(wrapper, "length", {
		value: steps.length,
		configurable: true,
	});
	Object.defineProperty(wrapper, "name", {
		value: steps.name,
		configurable: true,
	});
	return wrapper;
}

/* ---------------------------------------------------- custom element registry */

function isConstructor(value: unknown): boolean {
	if (typeof value !== "function") return false;
	try {
		Reflect.construct(function () {}, [], value as new () => unknown);
		return true;
	} catch {
		return false;
	}
}

/** Convert a value to sequence<DOMString>, as the IDL binding would. */
function toStringSequenceStrict(value: unknown, what: string): string[] {
	if (value === null || typeof value !== "object") {
		if (typeof value !== "string") throw new TypeError(`${what} is not a list`);
	}
	const iterator = (value as Iterable<unknown>)[Symbol.iterator];
	if (typeof iterator !== "function") {
		throw new TypeError(`${what} is not a list`);
	}
	const strings: string[] = [];
	for (const entry of value as Iterable<unknown>) strings.push(String(entry));
	return strings;
}

function toCallback(
	value: unknown,
	name: string,
): ((...args: unknown[]) => void) | null {
	if (value === undefined) return null;
	if (typeof value !== "function") {
		throw new TypeError(`${name} is not callable`);
	}
	return value as (...args: unknown[]) => void;
}

const LIFECYCLE_CALLBACK_NAMES = [
	"connectedCallback",
	"disconnectedCallback",
	"connectedMoveCallback",
	"adoptedCallback",
	"attributeChangedCallback",
];

const FORM_CALLBACK_NAMES = [
	"formAssociatedCallback",
	"formResetCallback",
	"formDisabledCallback",
	"formStateRestoreCallback",
];

export class CustomElementRegistry {
	#definitions: CustomElementDefinition[] = [];
	#definitionIsRunning = false;
	#whenDefined = new Map<
		string,
		{
			promise: Promise<CustomElementConstructor>;
			resolve: (value: CustomElementConstructor) => void;
		}
	>();

	define(
		name: string,
		constructor: CustomElementConstructor,
		options?: {extends?: string},
	): void {
		if (arguments.length < 2) {
			throw new TypeError("define needs a name and a constructor");
		}
		if (!isConstructor(constructor)) {
			throw new TypeError("That is not a constructor");
		}
		const localName = String(name);
		if (!isValidCustomElementName(localName)) {
			throw domError(
				"SyntaxError",
				`"${localName}" is not a valid custom element name`,
			);
		}
		if (this.#definitions.some((entry) => entry.name === localName)) {
			throw domError("NotSupportedError", `"${localName}" is already defined`);
		}
		if (this.#definitions.some((entry) => entry.constructor === constructor)) {
			throw domError(
				"NotSupportedError",
				"That constructor is already defining an element",
			);
		}
		const init = toDictionary<{extends?: string}>(
			options ?? {},
			"An ElementDefinitionOptions",
		);
		if (init.extends !== undefined && init.extends !== null) {
			throw domError(
				"NotSupportedError",
				"A customized built-in element is not implemented here",
			);
		}
		if (this.#definitionIsRunning) {
			throw domError("NotSupportedError", "A definition is already being read");
		}
		this.#definitionIsRunning = true;
		let observedAttributes: string[] = [];
		let formAssociated = false;
		let disableInternals = false;
		let disableShadow = false;
		const lifecycleCallbacks = new Map<
			string,
			((...args: unknown[]) => void) | null
		>();
		try {
			const source = constructor as unknown as Record<string, unknown>;
			const prototype = source.prototype;
			if (
				prototype === null ||
				(typeof prototype !== "object" && typeof prototype !== "function")
			) {
				throw new TypeError("That constructor has no prototype object");
			}
			const proto = prototype as Record<string, unknown>;
			for (const callbackName of LIFECYCLE_CALLBACK_NAMES) {
				lifecycleCallbacks.set(
					callbackName,
					toCallback(proto[callbackName], callbackName),
				);
			}
			if (lifecycleCallbacks.get("attributeChangedCallback") !== null) {
				const observed = source.observedAttributes;
				if (observed !== undefined) {
					observedAttributes = toStringSequenceStrict(
						observed,
						"observedAttributes",
					);
				}
			}
			const disabled = source.disabledFeatures;
			if (disabled !== undefined) {
				const features = toStringSequenceStrict(disabled, "disabledFeatures");
				disableInternals = features.includes("internals");
				disableShadow = features.includes("shadow");
			}
			formAssociated = Boolean(source.formAssociated);
			if (formAssociated) {
				for (const callbackName of FORM_CALLBACK_NAMES) {
					lifecycleCallbacks.set(
						callbackName,
						toCallback(proto[callbackName], callbackName),
					);
				}
			}
		} finally {
			this.#definitionIsRunning = false;
		}
		const definition: CustomElementDefinition = {
			name: localName,
			localName,
			constructor,
			observedAttributes: new Set(observedAttributes),
			lifecycleCallbacks,
			constructionStack: [],
			formAssociated,
			disableInternals,
			disableShadow,
		};
		this.#definitions.push(definition);
		const document = currentDocument();
		for (const candidate of shadowIncludingInclusiveDescendants(document)) {
			if (candidate.nodeType !== ELEMENT_NODE) continue;
			const element = candidate as Element;
			if (element[kNamespace] !== HTML_NAMESPACE) continue;
			if (element[kLocalName] !== localName) continue;
			enqueueUpgradeReaction(element, definition);
		}
		const pending = this.#whenDefined.get(localName);
		if (pending !== undefined) {
			pending.resolve(constructor);
			this.#whenDefined.delete(localName);
		}
	}

	get(name: string): CustomElementConstructor | undefined {
		const localName = String(name);
		const definition = this.#definitions.find(
			(entry) => entry.name === localName,
		);
		return definition === undefined ? undefined : definition.constructor;
	}

	getName(constructor: CustomElementConstructor): string | null {
		const definition = this.#definitions.find(
			(entry) => entry.constructor === constructor,
		);
		return definition === undefined ? null : definition.name;
	}

	whenDefined(name: string): Promise<CustomElementConstructor> {
		const localName = String(name);
		if (!isValidCustomElementName(localName)) {
			return Promise.reject(
				domError(
					"SyntaxError",
					`"${localName}" is not a valid custom element name`,
				),
			);
		}
		const defined = this.#definitions.find((entry) => entry.name === localName);
		if (defined !== undefined) return Promise.resolve(defined.constructor);
		let pending = this.#whenDefined.get(localName);
		if (pending === undefined) {
			let resolve: (value: CustomElementConstructor) => void = () => {};
			const promise = new Promise<CustomElementConstructor>((settle) => {
				resolve = settle;
			});
			pending = {promise, resolve};
			this.#whenDefined.set(localName, pending);
		}
		return pending.promise;
	}

	upgrade(root: Node): void {
		if (!(root instanceof Node)) throw new TypeError("That is not a node");
		for (const candidate of shadowIncludingInclusiveDescendants(root)) {
			if (candidate.nodeType !== ELEMENT_NODE) continue;
			tryToUpgrade(candidate as Element);
		}
	}

	[kDefinitionFor](
		constructor: CustomElementConstructor,
	): CustomElementDefinition | null {
		return (
			this.#definitions.find((entry) => entry.constructor === constructor) ??
			null
		);
	}

	[kLookUp](
		namespace: string | null,
		localName: string,
		is: string | null,
	): CustomElementDefinition | null {
		if (namespace !== HTML_NAMESPACE) return null;
		for (const definition of this.#definitions) {
			if (definition.name === localName && definition.localName === localName) {
				return definition;
			}
		}
		for (const definition of this.#definitions) {
			if (definition.name === is && definition.localName === localName) {
				return definition;
			}
		}
		return null;
	}
}

Object.defineProperty(CustomElementRegistry.prototype, Symbol.toStringTag, {
	value: "CustomElementRegistry",
	configurable: true,
});

/**
 * The registry every document in this realm shares.
 *
 * The spec hangs one off each Window; there is no Window here, and a document
 * reaches this one through the algorithms below rather than through a global,
 * so the tree stays standalone.
 */
export const customElements = new CustomElementRegistry();

const globalCustomElements = customElements;

function lookUpCustomElementDefinition(
	namespace: string | null,
	localName: string,
	is: string | null,
): CustomElementDefinition | null {
	return globalCustomElements[kLookUp](namespace, localName, is);
}

/** Construct a definition's constructor, as the spec's Construct(C) does. */
function constructCustomElement(definition: CustomElementDefinition): Element {
	return Reflect.construct(
		definition.constructor,
		[],
		definition.constructor,
	) as Element;
}

/**
 * The upgrade algorithm.
 *
 * The element is already in the tree; what changes is its prototype, its
 * state, and the callbacks it owes. The reactions for the attributes it
 * already carries and for being connected are enqueued before the constructor
 * runs, so an author's constructor sees them arrive afterwards.
 */
function upgradeElement(
	element: Element,
	definition: CustomElementDefinition,
): void {
	const state = element[kCustomState];
	if (state !== "undefined" && state !== "uncustomized") return;
	element[kDefinition] = definition;
	element[kCustomState] = "failed";
	for (const attribute of element[kAttributeList]) {
		enqueueCallbackReaction(element, "attributeChangedCallback", [
			attribute[kLocalName],
			null,
			attribute[kValue],
			attribute[kNamespace],
		]);
	}
	if (element.isConnected) {
		enqueueCallbackReaction(element, "connectedCallback", []);
	}
	definition.constructionStack.push(element);
	try {
		if (definition.disableShadow && element[kShadowRoot] !== null) {
			throw domError(
				"NotSupportedError",
				"That definition disabled shadow roots",
			);
		}
		element[kCustomState] = "precustomized";
		const result = constructCustomElement(definition);
		if (result !== element) {
			throw new TypeError("That constructor built a different element");
		}
	} catch (error) {
		// A constructor that threw leaves the element failed, with the callbacks
		// it had not run yet dropped. The definition stays: the element is that
		// definition's, and failed is a state of it rather than the absence of
		// one. The exception is reported by whoever runs the reaction.
		definition.constructionStack.pop();
		element[kCustomState] = "failed";
		element[kReactionQueue] = null;
		throw error;
	}
	definition.constructionStack.pop();
	element[kCustomState] = "custom";
}

function tryToUpgrade(element: Element): void {
	const definition = lookUpCustomElementDefinition(
		element[kNamespace],
		element[kLocalName],
		element[kIsValue],
	);
	if (definition !== null) enqueueUpgradeReaction(element, definition);
}

/* --------------------------------------------------------------- shadow trees */

/** The element names a shadow root may be attached to. */
const SHADOW_HOST_NAMES = new Set([
	"article",
	"aside",
	"blockquote",
	"body",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"main",
	"nav",
	"p",
	"section",
	"span",
]);

interface ShadowRootInit {
	mode: "open" | "closed";
	delegatesFocus?: boolean;
	slotAssignment?: "named" | "manual";
	clonable?: boolean;
	serializable?: boolean;
}

/**
 * A shadow root: the root of a tree a host element carries beside its
 * children.
 *
 * It is a document fragment with a host, which is what makes every algorithm
 * that already steps from a fragment to its host -- pre-insertion validity,
 * retargeting, the composed path -- work across it without a second concept.
 */
export class ShadowRoot extends DocumentFragment {
	[kShadowMode]: "open" | "closed" = "open";
	[kDelegatesFocus] = false;
	[kSlotAssignment]: "named" | "manual" = "named";
	[kClonable] = false;
	[kSerializable] = false;
	[kDeclarative] = false;
	[kAvailableToInternals] = false;

	constructor() {
		super();
		if (!internalConstruction) throw new TypeError("Illegal constructor");
	}

	get mode(): "open" | "closed" {
		return this[kShadowMode];
	}

	get delegatesFocus(): boolean {
		return this[kDelegatesFocus];
	}

	get slotAssignment(): "named" | "manual" {
		return this[kSlotAssignment];
	}

	get clonable(): boolean {
		return this[kClonable];
	}

	get serializable(): boolean {
		return this[kSerializable];
	}

	get host(): Element {
		return this[kHost] as Element;
	}

	get innerHTML(): string {
		return serializeFragment(this, false);
	}

	set innerHTML(value: string) {
		const fragment = parseFragmentHTML(
			String(value ?? ""),
			this[kHost] as Element,
			false,
		);
		replaceAll(fragment, this);
	}

	getHTML(options?: {
		serializableShadowRoots?: boolean;
		shadowRoots?: ShadowRoot[];
	}): string {
		const init = toDictionary<{
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		}>(options ?? {}, "A GetHTMLOptions");
		return serializeFragment(
			this,
			Boolean(init.serializableShadowRoots),
			init.shadowRoots ?? [],
		);
	}

	setHTMLUnsafe(html: string): void {
		const fragment = parseFragmentHTML(
			String(html ?? ""),
			this[kHost] as Element,
			true,
		);
		replaceAll(fragment, this);
	}

	/**
	 * A dispatch leaves a shadow tree through the host, unless the event was
	 * dispatched inside this very tree and is not composed.
	 */
	override [kGetTheParent](event: Event): EventTarget | null {
		const path = event[kDispatchState].path;
		if (
			!event.composed &&
			path.length > 0 &&
			path[0].invocationTarget instanceof Node &&
			getRoot(path[0].invocationTarget) === this
		) {
			return null;
		}
		return this[kHost];
	}

	override [kCloneSingle](_document: Document): Node {
		throw domError("NotSupportedError", "A shadow root cannot be cloned");
	}
}

Object.defineProperty(ShadowRoot.prototype, Symbol.toStringTag, {
	value: "ShadowRoot",
	configurable: true,
});

/** The spec's "attach a shadow root" algorithm. */
function attachShadowRoot(
	element: Element,
	mode: "open" | "closed",
	clonable: boolean,
	serializable: boolean,
	delegatesFocus: boolean,
	slotAssignment: "named" | "manual",
): void {
	if (element[kNamespace] !== HTML_NAMESPACE) {
		throw domError(
			"NotSupportedError",
			"Only an HTML element can host a shadow tree",
		);
	}
	const localName = element[kLocalName];
	if (
		!SHADOW_HOST_NAMES.has(localName) &&
		!isValidCustomElementName(localName)
	) {
		throw domError(
			"NotSupportedError",
			`A ${localName} cannot host a shadow tree`,
		);
	}
	if (isValidCustomElementName(localName) || element[kIsValue] !== null) {
		const definition = lookUpCustomElementDefinition(
			element[kNamespace],
			localName,
			element[kIsValue],
		);
		if (definition !== null && definition.disableShadow) {
			throw domError(
				"NotSupportedError",
				"That definition disabled shadow roots",
			);
		}
	}
	const existing = element[kShadowRoot];
	if (existing !== null) {
		if (!existing[kDeclarative] || existing[kShadowMode] !== mode) {
			throw domError(
				"NotSupportedError",
				"That element already hosts a shadow tree",
			);
		}
		for (const child of childNodeArray(existing)) removeNode(child);
		existing[kDeclarative] = false;
		return;
	}
	const previous = internalConstruction;
	internalConstruction = true;
	let shadow: ShadowRoot;
	try {
		shadow = new ShadowRoot();
	} finally {
		internalConstruction = previous;
	}
	shadow[kDocument] = element[kDocument];
	shadow[kHost] = element;
	shadow[kShadowMode] = mode;
	shadow[kDelegatesFocus] = delegatesFocus;
	const state = element[kCustomState];
	shadow[kAvailableToInternals] =
		state === "precustomized" || state === "custom";
	shadow[kSlotAssignment] = slotAssignment;
	shadow[kDeclarative] = false;
	shadow[kClonable] = clonable;
	shadow[kSerializable] = serializable;
	element[kShadowRoot] = shadow;
}

/* ---------------------------------------------------------------------- slots */

type Slottable = Element | Text;

function isSlottable(node: Node): boolean {
	return node.nodeType === ELEMENT_NODE || node.nodeType === TEXT_NODE;
}

function isAssigned(target: EventTarget | null): boolean {
	return (
		target instanceof Node &&
		isSlottable(target) &&
		(target as Slottable)[kAssignedSlot] !== null
	);
}

/** A slottable's name: an element's slot attribute, and "" for text. */
function slottableName(slottable: Slottable): string {
	return slottable.nodeType === ELEMENT_NODE
		? (slottable as Element)[kSlottableName]
		: "";
}

function hasInclusiveDescendantSlot(node: Node): boolean {
	if (node instanceof HTMLSlotElement) return true;
	for (const descendant of descendants(node)) {
		if (descendant instanceof HTMLSlotElement) return true;
	}
	return false;
}

/** The spec's "find a slot" algorithm. */
function findASlot(slottable: Slottable, open = false): HTMLSlotElement | null {
	const parent = slottable[kParent];
	if (parent === null || parent.nodeType !== ELEMENT_NODE) return null;
	const shadow = (parent as Element)[kShadowRoot];
	if (shadow === null) return null;
	if (open && shadow[kShadowMode] !== "open") return null;
	if (shadow[kSlotAssignment] === "manual") {
		for (const descendant of descendants(shadow)) {
			if (
				descendant instanceof HTMLSlotElement &&
				descendant[kManualAssignment].includes(slottable)
			) {
				return descendant;
			}
		}
		return null;
	}
	const name = slottableName(slottable);
	for (const descendant of descendants(shadow)) {
		if (
			descendant instanceof HTMLSlotElement &&
			descendant[kSlotName] === name
		) {
			return descendant;
		}
	}
	return null;
}

/** The spec's "find slottables" algorithm. */
function findSlottables(slot: HTMLSlotElement): Slottable[] {
	const result: Slottable[] = [];
	const root = getRoot(slot);
	if (!isShadowRoot(root)) return result;
	const shadow = root as ShadowRoot;
	const host = shadow[kHost] as Element;
	if (shadow[kSlotAssignment] === "manual") {
		for (const slottable of slot[kManualAssignment]) {
			if (slottable[kParent] === host) result.push(slottable);
		}
		return result;
	}
	for (let child = host[kFirstChild]; child !== null; child = child[kNext]) {
		if (!isSlottable(child)) continue;
		if (findASlot(child as Slottable) === slot) result.push(child as Slottable);
	}
	return result;
}

/** The spec's "find flattened slottables" algorithm. */
function findFlattenedSlottables(slot: HTMLSlotElement): Slottable[] {
	const result: Slottable[] = [];
	if (!isShadowRoot(getRoot(slot))) return result;
	let slottables = findSlottables(slot);
	if (slottables.length === 0) {
		slottables = [];
		for (let child = slot[kFirstChild]; child !== null; child = child[kNext]) {
			if (isSlottable(child)) slottables.push(child as Slottable);
		}
	}
	for (const node of slottables) {
		if (node instanceof HTMLSlotElement && isShadowRoot(getRoot(node))) {
			result.push(...findFlattenedSlottables(node));
		} else {
			result.push(node);
		}
	}
	return result;
}

/** The spec's "assign slottables" algorithm. */
function assignSlottables(slot: HTMLSlotElement): void {
	const slottables = findSlottables(slot);
	const assigned = slot[kAssignedNodes];
	const identical =
		slottables.length === assigned.length &&
		slottables.every((node, index) => node === assigned[index]);
	if (!identical) signalASlotChange(slot);
	for (const previous of assigned) {
		if (previous[kAssignedSlot] === slot && !slottables.includes(previous)) {
			previous[kAssignedSlot] = null;
		}
	}
	slot[kAssignedNodes] = slottables;
	for (const slottable of slottables) slottable[kAssignedSlot] = slot;
}

/** The spec's "assign slottables for a tree" algorithm. */
function assignSlottablesForTree(root: Node): void {
	for (const node of inclusiveDescendants(root)) {
		if (node instanceof HTMLSlotElement) assignSlottables(node);
	}
}

/** The spec's "assign a slot" algorithm. */
function assignASlot(slottable: Slottable): void {
	const slot = findASlot(slottable);
	if (slot !== null) assignSlottables(slot);
}

/**
 * The slots whose assignment changed since the last microtask checkpoint.
 *
 * slotchange is signalled here rather than fired here: the spec fires it from
 * the same microtask that delivers mutation records, and after them, so a
 * script that observes both sees the records first.
 */
const signalSlots: HTMLSlotElement[] = [];

function signalASlotChange(slot: HTMLSlotElement): void {
	if (!signalSlots.includes(slot)) signalSlots.push(slot);
	queueMutationObserverMicrotask();
}

/** The attribute change steps that keep a slottable's name current. */
function updateSlottableName(
	element: Element,
	oldValue: string | null,
	value: string | null,
): void {
	if (value === oldValue) return;
	if (value === null && oldValue === "") return;
	if (value === "" && oldValue === null) return;
	element[kSlottableName] = value === null || value === "" ? "" : value;
	const assigned = element[kAssignedSlot];
	if (assigned !== null) assignSlottables(assigned);
	assignASlot(element);
}

/** The attribute change steps that keep a slot's name current. */
function updateSlotName(
	slot: HTMLSlotElement,
	oldValue: string | null,
	value: string | null,
): void {
	if (value === oldValue) return;
	if (value === null && oldValue === "") return;
	if (value === "" && oldValue === null) return;
	slot[kSlotName] = value === null || value === "" ? "" : value;
	assignSlottablesForTree(getRoot(slot));
}

/**
 * A slot: the place in a shadow tree where a host's children are rendered.
 *
 * Assignment is recomputed rather than incrementally patched, because every
 * input to it -- the host's children, their slot attributes, the slot names in
 * the tree -- can change from any of a dozen mutation entry points, and one
 * recomputation per changed tree is both the spec's shape and the only one
 * that cannot drift.
 */
export class HTMLSlotElement extends HTMLElement {
	[kSlotName] = "";
	[kAssignedNodes]: Slottable[] = [];
	[kManualAssignment]: Slottable[] = [];

	get name(): string {
		return this.getAttribute("name") ?? "";
	}

	set name(value: string) {
		this.setAttribute("name", String(value));
	}

	assignedNodes(options?: {flatten?: boolean}): Node[] {
		const init = toDictionary<{flatten?: boolean}>(
			options ?? {},
			"An AssignedNodesOptions",
		);
		if (!init.flatten) return [...this[kAssignedNodes]];
		return findFlattenedSlottables(this);
	}

	assignedElements(options?: {flatten?: boolean}): Element[] {
		return this.assignedNodes(options).filter(
			(node) => node.nodeType === ELEMENT_NODE,
		) as Element[];
	}

	/**
	 * The assignment is recomputed over every tree a slot in it lost or gained
	 * a node: the spec's own step covers this slot's tree, and a node taken
	 * from a slot in another shadow tree leaves that tree's assignment stale
	 * until its slots are recomputed too.
	 */
	assign(...nodes: Slottable[]): void {
		for (const node of nodes) {
			if (!(node instanceof Node) || !isSlottable(node)) {
				throw new TypeError("Only an element or a text node can be assigned");
			}
		}
		const roots: Node[] = [getRoot(this)];
		for (const slottable of this[kManualAssignment]) {
			slottable[kManualSlot] = null;
		}
		const assigned: Slottable[] = [];
		for (const node of nodes) {
			const slottable = node as Slottable;
			if (assigned.includes(slottable)) continue;
			const previous = slottable[kManualSlot];
			if (previous !== null && previous !== this) {
				const index = previous[kManualAssignment].indexOf(slottable);
				if (index >= 0) previous[kManualAssignment].splice(index, 1);
				const root = getRoot(previous);
				if (!roots.includes(root)) roots.push(root);
			}
			slottable[kManualSlot] = this;
			assigned.push(slottable);
		}
		this[kManualAssignment] = assigned;
		for (const root of roots) assignSlottablesForTree(root);
	}
}

Object.defineProperty(HTMLSlotElement.prototype, Symbol.toStringTag, {
	value: "HTMLSlotElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "slot", HTMLSlotElement);

/**
 * A template: an element whose children are parsed into a fragment beside it
 * rather than into the tree.
 *
 * The fragment is the shape a shadow tree is written in -- a declarative
 * shadow root is a template, and every test that builds one builds it from a
 * template's content -- so the element that owns that fragment belongs beside
 * the slot rather than a phase later. Its host is the template, which is what
 * stops a template from being appended into its own contents.
 */
export class HTMLTemplateElement extends HTMLElement {
	[kTemplateContent]: DocumentFragment | null = null;

	get content(): DocumentFragment {
		let content = this[kTemplateContent];
		if (content === null) {
			content = new DocumentFragment();
			content[kDocument] = this[kDocument];
			content[kHost] = this;
			this[kTemplateContent] = content;
		}
		return content;
	}

	get shadowRootMode(): string {
		const value = this.getAttribute("shadowrootmode");
		if (value === null) return "";
		const mode = asciiLowercase(value);
		return mode === "open" || mode === "closed" ? mode : "";
	}

	set shadowRootMode(value: string) {
		this.setAttribute("shadowrootmode", String(value));
	}

	get shadowRootDelegatesFocus(): boolean {
		return this.hasAttribute("shadowrootdelegatesfocus");
	}

	set shadowRootDelegatesFocus(value: boolean) {
		this.toggleAttribute("shadowrootdelegatesfocus", Boolean(value));
	}

	get shadowRootClonable(): boolean {
		return this.hasAttribute("shadowrootclonable");
	}

	set shadowRootClonable(value: boolean) {
		this.toggleAttribute("shadowrootclonable", Boolean(value));
	}

	get shadowRootSerializable(): boolean {
		return this.hasAttribute("shadowrootserializable");
	}

	set shadowRootSerializable(value: boolean) {
		this.toggleAttribute("shadowrootserializable", Boolean(value));
	}

	override [kAdoptingSteps](_oldDocument: Document): void {
		const content = this[kTemplateContent];
		if (content !== null) adoptNode(content, this[kDocument]);
	}

	override [kCloningSteps](
		copy: Node,
		document: Document,
		_deep: boolean,
	): void {
		const content = this[kTemplateContent];
		if (content === null) return;
		const target = (copy as HTMLTemplateElement).content;
		for (
			let child = content[kFirstChild];
			child !== null;
			child = child[kNext]
		) {
			appendNode(cloneNode(child, document, true), target);
		}
	}
}

Object.defineProperty(HTMLTemplateElement.prototype, Symbol.toStringTag, {
	value: "HTMLTemplateElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "template", HTMLTemplateElement);

/* ------------------------------------------------- user-agent pseudo-elements */

/**
 * The pseudo-element slots an element carries.
 *
 * A ::before, ::after or ::marker box needs a node to hang style and children
 * off, and the engine's compositor needs to walk to it; the DOM Standard has
 * no such node, and an author must never find one. These live in a map keyed
 * by the pseudo-element's name, reachable only through the two functions
 * below, which the engine's composition pass is the sole caller of. Nothing
 * links them into the tree: their parent stays null, so childNodes, the tree
 * walkers, the collections and the selector engine cannot reach them, and no
 * mutation record or slot assignment ever names one.
 *
 * The element a slot holds is an ordinary Element of the host's document, so
 * everything the engine already does with an element -- computed style, a box,
 * text children -- works on it unchanged.
 */
export function pseudoElement(host: Element, name: string): Element | null {
	const slots = host[kPseudoElements];
	return slots === undefined || slots === null
		? null
		: (slots.get(name) ?? null);
}

/**
 * Give an element its pseudo-element node for a name, building one the first
 * time it is asked for. The node is an element named after the pseudo-element
 * so a debugger's dump reads plainly; it is never serialized.
 */
export function ensurePseudoElement(host: Element, name: string): Element {
	let slots = host[kPseudoElements];
	if (slots === null) {
		slots = new Map<string, Element>();
		host[kPseudoElements] = slots;
	}
	let element = slots.get(name);
	if (element === undefined) {
		element = createElementInternal(host[kDocument], name, HTML_NAMESPACE);
		slots.set(name, element);
	}
	return element;
}

/** Drop an element's pseudo-element node for a name. */
export function clearPseudoElement(host: Element, name: string): void {
	host[kPseudoElements]?.delete(name);
}

/* --------------------------------------------------------------- document */

const kDocumentURL = Symbol("document URL");
const kMode = Symbol("document mode");
const kType = Symbol("document type");
const kContentType = Symbol("content type");
const kEncoding = Symbol("encoding");
const kIdMap = Symbol("id map");
const kNodeIterators = Symbol("node iterators");
const kNwsapi = Symbol("selector engine");

let currentDocumentForConstruction: Document | null = null;
let ambientDocument: Document | null = null;

/**
 * The document a constructor with no document of its own belongs to.
 *
 * With no window there is no "current global object", so a bare `new Text()`
 * belongs to whichever document was last made ambient, or to one made here.
 */
function currentDocument(): Document {
	if (currentDocumentForConstruction !== null) {
		return currentDocumentForConstruction;
	}
	if (ambientDocument === null) {
		const document = new Document();
		ambientDocument = document;
		fillHTMLDocument(document, "");
	}
	return ambientDocument;
}

/** Make a document the one bare node constructors belong to. */
export function setAmbientDocument(document: Document): void {
	ambientDocument = document;
}

function isHTMLDocument(document: Document): boolean {
	return document[kType] === "html";
}

export class Document extends Node {
	[kDocumentURL] = "about:blank";
	[kMode]: "no-quirks" | "quirks" | "limited-quirks" = "no-quirks";
	[kType]: "xml" | "html" = "xml";
	[kContentType] = "application/xml";
	[kEncoding] = "UTF-8";
	[kIdMap] = new Map<string, Element[]>();
	[kNodeIterators]: Array<WeakRef<NodeIterator>> = [];
	[kNwsapi]: ReturnType<typeof NWSAPI> | null = null;
	[kChildren]: HTMLCollection | null = null;

	/** Parse a document, declarative shadow roots included. */
	static parseHTMLUnsafe(html: string): Document {
		return parseHTMLUnsafe(String(html));
	}

	override get nodeType(): number {
		return DOCUMENT_NODE;
	}

	override get nodeName(): string {
		return "#document";
	}

	get URL(): string {
		return this[kDocumentURL];
	}

	get documentURI(): string {
		return this[kDocumentURL];
	}

	get compatMode(): string {
		return this[kMode] === "quirks" ? "BackCompat" : "CSS1Compat";
	}

	get characterSet(): string {
		return this[kEncoding];
	}

	get charset(): string {
		return this[kEncoding];
	}

	get inputEncoding(): string {
		return this[kEncoding];
	}

	get contentType(): string {
		return this[kContentType];
	}

	get implementation(): DOMImplementation {
		let implementation = this.#implementation;
		if (implementation === null) {
			implementation = new DOMImplementation(this);
			this.#implementation = implementation;
		}
		return implementation;
	}

	#implementation: DOMImplementation | null = null;

	get doctype(): DocumentType | null {
		for (let node = this[kFirstChild]; node !== null; node = node[kNext]) {
			if (node.nodeType === DOCUMENT_TYPE_NODE) return node as DocumentType;
		}
		return null;
	}

	get defaultView(): null {
		return null;
	}

	get location(): null {
		return null;
	}

	/**
	 * head, body and title come from the HTML Standard, not the DOM Standard.
	 * They are here because a document with no way to name its body is not a
	 * document any DOM test can be written against; each follows the HTML
	 * Standard's own definition.
	 */
	get head(): Element | null {
		const root = this.documentElement;
		if (root === null) return null;
		for (let node = root[kFirstChild]; node !== null; node = node[kNext]) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				(node as Element)[kLocalName] === "head"
			) {
				return node as Element;
			}
		}
		return null;
	}

	get body(): Element | null {
		const root = this.documentElement;
		if (root === null) return null;
		for (let node = root[kFirstChild]; node !== null; node = node[kNext]) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				((node as Element)[kLocalName] === "body" ||
					(node as Element)[kLocalName] === "frameset")
			) {
				return node as Element;
			}
		}
		return null;
	}

	set body(value: Element | null) {
		if (
			value == null ||
			value.nodeType !== ELEMENT_NODE ||
			value[kNamespace] !== HTML_NAMESPACE ||
			(value[kLocalName] !== "body" && value[kLocalName] !== "frameset")
		) {
			throw hierarchyRequestError("That element cannot be a document body");
		}
		const existing = this.body;
		if (existing === value) return;
		const root = this.documentElement;
		if (root === null) {
			throw hierarchyRequestError("There is no document element");
		}
		if (existing !== null) {
			replaceChild(existing, value, root);
		} else {
			appendNode(value, root);
		}
	}

	get title(): string {
		const root = this.documentElement;
		let element: Element | null = null;
		if (
			root !== null &&
			root[kNamespace] === SVG_NAMESPACE &&
			root[kLocalName] === "svg"
		) {
			for (const node of descendants(root)) {
				if (
					node.nodeType === ELEMENT_NODE &&
					(node as Element)[kNamespace] === SVG_NAMESPACE &&
					(node as Element)[kLocalName] === "title"
				) {
					element = node as Element;
					break;
				}
			}
		} else {
			for (const node of descendants(this)) {
				if (
					node.nodeType === ELEMENT_NODE &&
					(node as Element)[kNamespace] === HTML_NAMESPACE &&
					(node as Element)[kLocalName] === "title"
				) {
					element = node as Element;
					break;
				}
			}
		}
		if (element === null) return "";
		return stripAndCollapseWhitespace(descendantText(element));
	}

	set title(value: string) {
		const root = this.documentElement;
		if (root === null) return;
		let element: Element | null = null;
		for (const node of descendants(this)) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				(node as Element)[kLocalName] === "title"
			) {
				element = node as Element;
				break;
			}
		}
		if (element === null) {
			const head = this.head;
			if (head === null) return;
			element = createElementInternal(this, "title", HTML_NAMESPACE);
			appendNode(element, head);
		}
		setDescendantText(element, String(value));
	}

	get documentElement(): Element | null {
		for (let node = this[kFirstChild]; node !== null; node = node[kNext]) {
			if (node.nodeType === ELEMENT_NODE) return node as Element;
		}
		return null;
	}

	getElementsByTagName(qualifiedName: string): HTMLCollection {
		return elementsByTagName(this, String(qualifiedName));
	}

	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollection {
		return elementsByTagNameNS(this, namespace, String(localName));
	}

	getElementsByClassName(classNames: string): HTMLCollection {
		return elementsByClassName(this, String(classNames));
	}

	getElementById(elementId: string): Element | null {
		const id = String(elementId);
		const entries = this[kIdMap].get(id);
		if (entries === undefined || entries.length === 0) return null;
		if (entries.length === 1) return entries[0];
		let first = entries[0];
		for (let index = 1; index < entries.length; index++) {
			if (precedesInTree(entries[index], first)) first = entries[index];
		}
		return first;
	}

	createElement(localName: string, options?: {is?: string} | string): Element {
		if (arguments.length < 1) {
			throw new TypeError("createElement needs a name");
		}
		let name = String(localName);
		validateElementLocalName(name);
		if (isHTMLDocument(this)) name = asciiLowercase(name);
		const is = extractIs(options);
		const namespace =
			isHTMLDocument(this) || this[kContentType] === "application/xhtml+xml"
				? HTML_NAMESPACE
				: null;
		return createElementInternal(this, name, namespace, null, is);
	}

	createElementNS(
		namespace: string | null,
		qualifiedName: string,
		options?: {is?: string} | string,
	): Element {
		if (arguments.length < 2) {
			throw new TypeError("createElementNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
			false,
		);
		return createElementInternal(
			this,
			extracted.localName,
			extracted.namespace,
			extracted.prefix,
			extractIs(options),
		);
	}

	createDocumentFragment(): DocumentFragment {
		const fragment = new DocumentFragment();
		fragment[kDocument] = this;
		return fragment;
	}

	createTextNode(data: string): Text {
		if (arguments.length < 1) throw new TypeError("createTextNode needs data");
		const text = new Text(String(data));
		text[kDocument] = this;
		return text;
	}

	createCDATASection(data: string): CDATASection {
		if (isHTMLDocument(this)) {
			throw domError(
				"NotSupportedError",
				"An HTML document has no CDATA sections",
			);
		}
		const string = String(data);
		if (string.includes("]]>")) {
			throw domError(
				"InvalidCharacterError",
				"A CDATA section cannot contain ]]>",
			);
		}
		const section = new CDATASection(string);
		section[kDocument] = this;
		return section;
	}

	createComment(data: string): Comment {
		if (arguments.length < 1) throw new TypeError("createComment needs data");
		const comment = new Comment(String(data));
		comment[kDocument] = this;
		return comment;
	}

	createProcessingInstruction(
		target: string,
		data: string,
	): ProcessingInstruction {
		if (arguments.length < 2) {
			throw new TypeError(
				"createProcessingInstruction needs a target and data",
			);
		}
		const name = String(target);
		validateXMLName(name);
		const string = String(data);
		if (string.includes("?>")) {
			throw domError(
				"InvalidCharacterError",
				"A processing instruction cannot contain ?>",
			);
		}
		const instruction = new ProcessingInstruction(name, string);
		instruction[kDocument] = this;
		return instruction;
	}

	importNode(node: Node, deep = false): Node {
		if (!(node instanceof Node)) throw new TypeError("That is not a node");
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be imported");
		}
		if (isShadowRoot(node)) {
			throw domError("NotSupportedError", "A shadow root cannot be imported");
		}
		return cloneNode(node, this, Boolean(deep));
	}

	adoptNode(node: Node): Node {
		if (!(node instanceof Node)) throw new TypeError("That is not a node");
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be adopted");
		}
		if (isShadowRoot(node)) {
			throw hierarchyRequestError("A shadow root cannot be adopted");
		}
		adoptNode(node, this);
		return node;
	}

	createAttribute(localName: string): Attr {
		if (arguments.length < 1) {
			throw new TypeError("createAttribute needs a name");
		}
		let name = String(localName);
		validateAttributeLocalName(name);
		if (isHTMLDocument(this)) name = asciiLowercase(name);
		const attribute = new Attr(null, null, name, "");
		attribute[kDocument] = this;
		return attribute;
	}

	createAttributeNS(namespace: string | null, qualifiedName: string): Attr {
		if (arguments.length < 2) {
			throw new TypeError("createAttributeNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
			true,
		);
		const attribute = new Attr(
			extracted.namespace,
			extracted.prefix,
			extracted.localName,
			"",
		);
		attribute[kDocument] = this;
		return attribute;
	}

	/**
	 * Build an uninitialized event of a legacy interface name.
	 *
	 * The event comes back with an empty type and its initialized flag unset,
	 * so it cannot be dispatched until initEvent gives it one.
	 */
	createEvent(interfaceName: string): Event {
		if (arguments.length < 1) {
			throw new TypeError("createEvent needs an interface name");
		}
		const name = asciiLowercase(String(interfaceName));
		let event: Event;
		if (name === "customevent") {
			event = new CustomEvent("");
		} else if (
			name === "event" ||
			name === "events" ||
			name === "htmlevents" ||
			name === "svgevents"
		) {
			event = new Event("");
		} else {
			throw domError(
				"NotSupportedError",
				`No event interface is named "${interfaceName}"`,
			);
		}
		event[kDispatchState].initialized = false;
		return event;
	}

	createNodeIterator(
		root: Node,
		whatToShow = 0xffffffff,
		filter: NodeFilterInput = null,
	): NodeIterator {
		if (!(root instanceof Node)) throw new TypeError("That is not a node");
		const iterator = new NodeIterator(root, toUnsignedLong(whatToShow), filter);
		// The spec keys the pre-removing steps off the root's node document,
		// which need not be the document the iterator was created from.
		const iterators = root[kDocument][kNodeIterators];
		let write = 0;
		for (let read = 0; read < iterators.length; read++) {
			if (iterators[read].deref() !== undefined) {
				iterators[write++] = iterators[read];
			}
		}
		iterators.length = write;
		iterators.push(new WeakRef(iterator));
		return iterator;
	}

	createTreeWalker(
		root: Node,
		whatToShow = 0xffffffff,
		filter: NodeFilterInput = null,
	): TreeWalker {
		if (!(root instanceof Node)) throw new TypeError("That is not a node");
		return new TreeWalker(root, toUnsignedLong(whatToShow), filter);
	}

	override [kCloneSingle](_document: Document): Node {
		const copy = new Document();
		copyDocumentState(this, copy);
		return copy;
	}
}

Object.defineProperty(Document.prototype, Symbol.toStringTag, {
	value: "Document",
	configurable: true,
});

export class XMLDocument extends Document {
	override [kCloneSingle](_document: Document): Node {
		const copy = new XMLDocument();
		copyDocumentState(this, copy);
		return copy;
	}
}

Object.defineProperty(XMLDocument.prototype, Symbol.toStringTag, {
	value: "XMLDocument",
	configurable: true,
});

function stripAndCollapseWhitespace(value: string): string {
	return value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
}

function copyDocumentState(from: Document, to: Document): void {
	to[kType] = from[kType];
	to[kContentType] = from[kContentType];
	to[kEncoding] = from[kEncoding];
	to[kDocumentURL] = from[kDocumentURL];
	to[kMode] = from[kMode];
}

function extractIs(options: {is?: string} | string | undefined): string | null {
	if (options == null) return null;
	if (typeof options === "string") return null;
	const is = (options as {is?: unknown}).is;
	return is === undefined ? null : String(is);
}

/* ------------------------------------------------------------------ id map */

function addToIdMap(document: Document, element: Element): void {
	const id = element.getAttribute("id");
	if (id !== null && id !== "") addIdEntry(document, id, element);
}

function removeFromIdMap(document: Document, element: Element): void {
	const id = element.getAttribute("id");
	if (id !== null && id !== "") removeIdEntry(document, id, element);
}

function addIdEntry(document: Document, id: string, element: Element): void {
	const entries = document[kIdMap].get(id);
	if (entries === undefined) {
		document[kIdMap].set(id, [element]);
	} else if (!entries.includes(element)) {
		entries.push(element);
	}
}

function removeIdEntry(document: Document, id: string, element: Element): void {
	const entries = document[kIdMap].get(id);
	if (entries === undefined) return;
	const index = entries.indexOf(element);
	if (index !== -1) entries.splice(index, 1);
	if (entries.length === 0) document[kIdMap].delete(id);
}

/* ------------------------------------------------------------ implementation */

export class DOMImplementation {
	#document: Document;

	constructor(document: Document) {
		this.#document = document;
	}

	createDocumentType(
		qualifiedName: string,
		publicId: string,
		systemId: string,
	): DocumentType {
		if (arguments.length < 3) {
			throw new TypeError("createDocumentType needs three arguments");
		}
		const name = String(qualifiedName);
		validateDoctypeName(name);
		const doctype = new DocumentType(name, String(publicId), String(systemId));
		doctype[kDocument] = this.#document;
		return doctype;
	}

	createDocument(
		namespace: string | null,
		qualifiedName: string | null,
		doctype: DocumentType | null = null,
	): XMLDocument {
		if (arguments.length < 2) {
			throw new TypeError("createDocument needs a namespace and a name");
		}
		const document = new XMLDocument();
		document[kType] = "xml";
		document[kContentType] = "application/xml";
		let element: Element | null = null;
		const name = qualifiedName === null ? "" : String(qualifiedName);
		if (name !== "") {
			element = document.createElementNS(
				namespace == null ? null : String(namespace),
				name,
			);
		}
		if (doctype != null) appendNode(doctype, document);
		if (element !== null) appendNode(element, document);
		const ns = namespace === "" || namespace == null ? null : String(namespace);
		if (ns === HTML_NAMESPACE) {
			document[kContentType] = "application/xhtml+xml";
		} else if (ns === SVG_NAMESPACE) {
			document[kContentType] = "image/svg+xml";
		}
		return document;
	}

	createHTMLDocument(title?: string): Document {
		return createHTMLDocument(title === undefined ? undefined : String(title));
	}

	hasFeature(): boolean {
		return true;
	}
}

Object.defineProperty(DOMImplementation.prototype, Symbol.toStringTag, {
	value: "DOMImplementation",
	configurable: true,
});

/** A document with the html/head/body skeleton the HTML Standard builds. */
export function createHTMLDocument(
	title?: string,
	url = "about:blank",
): Document {
	const document = new Document();
	fillHTMLDocument(document, title);
	document[kDocumentURL] = url;
	return document;
}

function fillHTMLDocument(document: Document, title?: string): void {
	const previous = currentDocumentForConstruction;
	currentDocumentForConstruction = document;
	try {
		buildHTMLSkeleton(document, title);
	} finally {
		currentDocumentForConstruction = previous;
	}
}

function buildHTMLSkeleton(document: Document, title?: string): void {
	document[kType] = "html";
	document[kContentType] = "text/html";
	const doctype = new DocumentType("html", "", "");
	doctype[kDocument] = document;
	appendNode(doctype, document);
	const html = createElementInternal(document, "html", HTML_NAMESPACE);
	appendNode(html, document);
	const head = createElementInternal(document, "head", HTML_NAMESPACE);
	appendNode(head, html);
	if (title !== undefined) {
		const titleElement = createElementInternal(
			document,
			"title",
			HTML_NAMESPACE,
		);
		appendNode(titleElement, head);
		const text = new Text(title);
		text[kDocument] = document;
		appendNode(text, titleElement);
	}
	const body = createElementInternal(document, "body", HTML_NAMESPACE);
	appendNode(body, html);
}

/* ----------------------------------------------------------------- mixins */

type Insertable = Node | string;

function convertNodesIntoNode(nodes: Insertable[], document: Document): Node {
	if (nodes.length === 1 && nodes[0] instanceof Node) return nodes[0];
	const converted = nodes.map((node) => {
		if (node instanceof Node) return node;
		const text = new Text(String(node));
		text[kDocument] = document;
		return text as Node;
	});
	if (converted.length === 1) return converted[0];
	const fragment = document.createDocumentFragment();
	for (const node of converted) appendNode(node, fragment);
	return fragment;
}

const parentNodeMembers = {
	children: {
		get(this: Node): HTMLCollection {
			const owner = this as unknown as Record<symbol, HTMLCollection | null>;
			let collection = owner[kChildren];
			if (collection == null) {
				collection = new HTMLCollection(() => elementChildren(this));
				collection[kEnsure]();
				owner[kChildren] = collection;
			}
			return collection;
		},
		configurable: true,
		enumerable: true,
	},
	firstElementChild: {
		get(this: Node): Element | null {
			for (let node = this[kFirstChild]; node !== null; node = node[kNext]) {
				if (node.nodeType === ELEMENT_NODE) return node as Element;
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	lastElementChild: {
		get(this: Node): Element | null {
			for (let node = this[kLastChild]; node !== null; node = node[kPrevious]) {
				if (node.nodeType === ELEMENT_NODE) return node as Element;
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	childElementCount: {
		get(this: Node): number {
			let count = 0;
			for (let node = this[kFirstChild]; node !== null; node = node[kNext]) {
				if (node.nodeType === ELEMENT_NODE) count++;
			}
			return count;
		},
		configurable: true,
		enumerable: true,
	},
	prepend: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			preInsert(node, this, this[kFirstChild]);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	append: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			preInsert(node, this, null);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	replaceChildren: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			ensurePreInsertionValidity(node, this, null, true);
			replaceAll(node, this);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	querySelector: {
		value(this: Node, selectors: string): Element | null {
			return selectorEngine(this[kDocument]).first(
				String(selectors),
				this as never,
			) as Element | null;
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	querySelectorAll: {
		value(this: Node, selectors: string): NodeList {
			const found = selectorEngine(this[kDocument]).select(
				String(selectors),
				this as never,
			) as unknown as Node[];
			return createStaticNodeList(found.slice());
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
};

const childNodeMembers = {
	before: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent];
			if (parent === null) return;
			let viable = this[kPrevious];
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kPrevious];
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			if (viable === null) {
				preInsert(node, parent, parent[kFirstChild]);
			} else {
				preInsert(node, parent, viable[kNext]);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	after: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent];
			if (parent === null) return;
			let viable = this[kNext];
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kNext];
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			preInsert(node, parent, viable);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	replaceWith: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent];
			if (parent === null) return;
			let viable = this[kNext];
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kNext];
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]);
			if (this[kParent] === parent) {
				replaceChild(this, node, parent);
			} else {
				preInsert(node, parent, viable);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	remove: {
		value(this: Node): void {
			if (this[kParent] === null) return;
			removeNode(this);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
};

const nonDocumentTypeChildNodeMembers = {
	previousElementSibling: {
		get(this: Node): Element | null {
			for (let node = this[kPrevious]; node !== null; node = node[kPrevious]) {
				if (node.nodeType === ELEMENT_NODE) return node as Element;
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	nextElementSibling: {
		get(this: Node): Element | null {
			for (let node = this[kNext]; node !== null; node = node[kNext]) {
				if (node.nodeType === ELEMENT_NODE) return node as Element;
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
};

for (const prototype of [
	Document.prototype,
	DocumentFragment.prototype,
	Element.prototype,
]) {
	Object.defineProperties(prototype, parentNodeMembers);
}
for (const prototype of [
	DocumentType.prototype,
	Element.prototype,
	CharacterData.prototype,
]) {
	Object.defineProperties(prototype, childNodeMembers);
}
for (const prototype of [Element.prototype, CharacterData.prototype]) {
	Object.defineProperties(prototype, nonDocumentTypeChildNodeMembers);
}

/**
 * The mixin members the IDL marks [Unscopable], so a `with` statement over a
 * node does not shadow a variable named after one of them.
 */
function markUnscopable(prototype: object, names: string[]): void {
	const existing = (prototype as Record<symbol, Record<string, true>>)[
		Symbol.unscopables
	];
	const unscopables: Record<string, true> =
		existing === undefined ? Object.create(null) : existing;
	for (const name of names) unscopables[name] = true;
	Object.defineProperty(prototype, Symbol.unscopables, {
		value: unscopables,
		configurable: true,
	});
}

const PARENT_NODE_UNSCOPABLES = ["append", "prepend", "replaceChildren"];
const CHILD_NODE_UNSCOPABLES = ["after", "before", "remove", "replaceWith"];

markUnscopable(Document.prototype, PARENT_NODE_UNSCOPABLES);
markUnscopable(DocumentFragment.prototype, PARENT_NODE_UNSCOPABLES);
markUnscopable(Element.prototype, [
	...PARENT_NODE_UNSCOPABLES,
	...CHILD_NODE_UNSCOPABLES,
	"slot",
]);
markUnscopable(CharacterData.prototype, CHILD_NODE_UNSCOPABLES);
markUnscopable(DocumentType.prototype, CHILD_NODE_UNSCOPABLES);

Object.defineProperties(Element.prototype, {
	matches: {
		value(this: Element, selectors: string): boolean {
			return selectorEngine(this[kDocument]).match(
				String(selectors),
				this as never,
			);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	webkitMatchesSelector: {
		value(this: Element, selectors: string): boolean {
			return selectorEngine(this[kDocument]).match(
				String(selectors),
				this as never,
			);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	closest: {
		value(this: Element, selectors: string): Element | null {
			const engine = selectorEngine(this[kDocument]);
			const selector = String(selectors);
			// A bad selector throws before any ancestor is examined.
			engine.match(selector, this as never);
			let node: Node | null = this;
			while (node !== null && node.nodeType === ELEMENT_NODE) {
				if (engine.match(selector, node as never)) return node as Element;
				node = node[kParent];
			}
			return null;
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
});

/** The spec's "insert adjacent" algorithm, shared by element and text. */
function insertAdjacent(
	element: Element,
	where: string,
	node: Node,
): Node | null {
	switch (asciiLowercase(where)) {
		case "beforebegin": {
			const parent = element[kParent];
			if (parent === null) return null;
			preInsert(node, parent, element);
			return node;
		}
		case "afterbegin":
			preInsert(node, element, element[kFirstChild]);
			return node;
		case "beforeend":
			preInsert(node, element, null);
			return node;
		case "afterend": {
			const parent = element[kParent];
			if (parent === null) return null;
			preInsert(node, parent, element[kNext]);
			return node;
		}
		default:
			throw domError("SyntaxError", `"${where}" is not a position`);
	}
}

/* ------------------------------------------------------ clone and equality */

function cloneNode(
	node: Node,
	document: Document | undefined,
	deep: boolean,
): Node {
	const target = document ?? node[kDocument];
	const copy = node[kCloneSingle](target);
	if (copy.nodeType === DOCUMENT_NODE) copy[kDocument] = copy as Document;
	node[kCloningSteps](copy, target, deep);
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot];
		if (shadow !== null && shadow[kClonable]) {
			attachShadowRoot(
				copy as Element,
				shadow[kShadowMode],
				true,
				shadow[kSerializable],
				shadow[kDelegatesFocus],
				shadow[kSlotAssignment],
			);
			const copiedShadow = (copy as Element)[kShadowRoot] as ShadowRoot;
			copiedShadow[kDeclarative] = shadow[kDeclarative];
			for (
				let child = shadow[kFirstChild];
				child !== null;
				child = child[kNext]
			) {
				appendNode(
					cloneNode(child, copiedShadow[kDocument], true),
					copiedShadow,
				);
			}
		}
	}
	if (deep) {
		for (let child = node[kFirstChild]; child !== null; child = child[kNext]) {
			appendNode(cloneNode(child, copy[kDocument], true), copy);
		}
	}
	return copy;
}

function equalNodes(a: Node, b: Node): boolean {
	if (a.nodeType !== b.nodeType) return false;
	switch (a.nodeType) {
		case DOCUMENT_TYPE_NODE: {
			const one = a as DocumentType;
			const two = b as DocumentType;
			if (
				one[kName] !== two[kName] ||
				one[kPublicId] !== two[kPublicId] ||
				one[kSystemId] !== two[kSystemId]
			) {
				return false;
			}
			break;
		}
		case ELEMENT_NODE: {
			const one = a as Element;
			const two = b as Element;
			if (
				one[kNamespace] !== two[kNamespace] ||
				one[kPrefix] !== two[kPrefix] ||
				one[kLocalName] !== two[kLocalName] ||
				one[kAttributeList].length !== two[kAttributeList].length
			) {
				return false;
			}
			for (const attribute of one[kAttributeList]) {
				const other = getAttributeByNamespace(
					two,
					attribute[kNamespace],
					attribute[kLocalName],
				);
				if (other === null || other[kValue] !== attribute[kValue]) return false;
			}
			break;
		}
		case ATTRIBUTE_NODE: {
			const one = a as Attr;
			const two = b as Attr;
			if (
				one[kNamespace] !== two[kNamespace] ||
				one[kLocalName] !== two[kLocalName] ||
				one[kValue] !== two[kValue]
			) {
				return false;
			}
			break;
		}
		case PROCESSING_INSTRUCTION_NODE: {
			const one = a as ProcessingInstruction;
			const two = b as ProcessingInstruction;
			if (one[kTarget] !== two[kTarget] || one[kData] !== two[kData]) {
				return false;
			}
			break;
		}
		case TEXT_NODE:
		case CDATA_SECTION_NODE:
		case COMMENT_NODE:
			if ((a as CharacterData)[kData] !== (b as CharacterData)[kData]) {
				return false;
			}
			break;
		default:
			break;
	}
	let childA = a[kFirstChild];
	let childB = b[kFirstChild];
	while (childA !== null && childB !== null) {
		if (!equalNodes(childA, childB)) return false;
		childA = childA[kNext];
		childB = childB[kNext];
	}
	return childA === null && childB === null;
}

/* ------------------------------------------------------------- namespaces */

function locateNamespacePrefix(
	element: Element,
	namespace: string,
): string | null {
	if (element[kNamespace] === namespace && element[kPrefix] !== null) {
		return element[kPrefix];
	}
	for (const attribute of element[kAttributeList]) {
		if (attribute[kPrefix] === "xmlns" && attribute[kValue] === namespace) {
			return attribute[kLocalName];
		}
	}
	const parent = element.parentElement;
	return parent === null ? null : locateNamespacePrefix(parent, namespace);
}

function locateNamespace(node: Node, prefix: string | null): string | null {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
			// The two prefixes the XML specifications bind for good.
			if (prefix === "xml") return XML_NAMESPACE;
			if (prefix === "xmlns") return XMLNS_NAMESPACE;
			const element = node as Element;
			if (element[kNamespace] !== null && element[kPrefix] === prefix) {
				return element[kNamespace];
			}
			for (const attribute of element[kAttributeList]) {
				if (
					attribute[kNamespace] === XMLNS_NAMESPACE &&
					attribute[kPrefix] === "xmlns" &&
					attribute[kLocalName] === prefix
				) {
					return attribute[kValue] === "" ? null : attribute[kValue];
				}
				if (
					attribute[kNamespace] === XMLNS_NAMESPACE &&
					attribute[kPrefix] === null &&
					attribute[kLocalName] === "xmlns" &&
					prefix === null
				) {
					return attribute[kValue] === "" ? null : attribute[kValue];
				}
			}
			const parent = element.parentElement;
			return parent === null ? null : locateNamespace(parent, prefix);
		}
		case DOCUMENT_NODE: {
			const element = (node as Document).documentElement;
			return element === null ? null : locateNamespace(element, prefix);
		}
		case DOCUMENT_TYPE_NODE:
		case DOCUMENT_FRAGMENT_NODE:
			return null;
		case ATTRIBUTE_NODE: {
			const owner = (node as Attr).ownerElement;
			return owner === null ? null : locateNamespace(owner, prefix);
		}
		default: {
			const parent = node.parentElement;
			return parent === null ? null : locateNamespace(parent, prefix);
		}
	}
}

/* -------------------------------------------------------------- traversal */

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

export type NodeFilterInput =
	| ((node: Node) => number)
	| {acceptNode(node: Node): number}
	| null
	| undefined;

export const NodeFilter = {
	FILTER_ACCEPT,
	FILTER_REJECT,
	FILTER_SKIP,
	SHOW_ALL: 0xffffffff,
	SHOW_ELEMENT: 0x1,
	SHOW_ATTRIBUTE: 0x2,
	SHOW_TEXT: 0x4,
	SHOW_CDATA_SECTION: 0x8,
	SHOW_ENTITY_REFERENCE: 0x10,
	SHOW_ENTITY: 0x20,
	SHOW_PROCESSING_INSTRUCTION: 0x40,
	SHOW_COMMENT: 0x80,
	SHOW_DOCUMENT: 0x100,
	SHOW_DOCUMENT_TYPE: 0x200,
	SHOW_DOCUMENT_FRAGMENT: 0x400,
	SHOW_NOTATION: 0x800,
};

Object.freeze(NodeFilter);

/** Run a traverser's filter over a node. */
function filterNode(
	traverser: {
		root: Node;
		whatToShow: number;
		filter: NodeFilterInput;
		active: {value: boolean};
	},
	node: Node,
): number {
	if (traverser.active.value) {
		throw domError("InvalidStateError", "The filter is already running");
	}
	if (((1 << (node.nodeType - 1)) & traverser.whatToShow) === 0) {
		return FILTER_SKIP;
	}
	const filter = traverser.filter;
	if (filter == null) return FILTER_ACCEPT;
	traverser.active.value = true;
	let result: unknown;
	try {
		result =
			typeof filter === "function"
				? filter(node)
				: (filter as {acceptNode(node: Node): number}).acceptNode(node);
	} finally {
		traverser.active.value = false;
	}
	return toUnsignedLong(result);
}

/** The next node in tree order after a node, inside a root. */
function followingWithin(node: Node, root: Node): Node | null {
	return nextInTree(node, root);
}

/** The node preceding a node in tree order, inside a root. */
function precedingWithin(node: Node, root: Node): Node | null {
	if (node === root) return null;
	let previous = node[kPrevious];
	if (previous === null) return node[kParent];
	while (previous[kLastChild] !== null) previous = previous[kLastChild] as Node;
	return previous;
}

const kPreRemove = Symbol("node iterator pre-removing steps");

export class NodeIterator {
	#root: Node;
	#reference: Node;
	#pointerBefore = true;
	#whatToShow: number;
	#filter: NodeFilterInput;
	#active = {value: false};

	constructor(root: Node, whatToShow: number, filter: NodeFilterInput) {
		this.#root = root;
		this.#reference = root;
		this.#whatToShow = whatToShow;
		this.#filter = filter ?? null;
	}

	get root(): Node {
		return this.#root;
	}

	get referenceNode(): Node {
		return this.#reference;
	}

	get pointerBeforeReferenceNode(): boolean {
		return this.#pointerBefore;
	}

	get whatToShow(): number {
		return this.#whatToShow;
	}

	get filter(): NodeFilterInput {
		return this.#filter;
	}

	nextNode(): Node | null {
		return this.#traverse(true);
	}

	previousNode(): Node | null {
		return this.#traverse(false);
	}

	detach(): void {
		// The spec keeps this as a no-op.
	}

	#traverse(forward: boolean): Node | null {
		let node: Node | null = this.#reference;
		let before = this.#pointerBefore;
		const state = {
			root: this.#root,
			whatToShow: this.#whatToShow,
			filter: this.#filter,
			active: this.#active,
		};
		for (;;) {
			if (forward) {
				if (!before) {
					node = followingWithin(node as Node, this.#root);
					if (node === null) return null;
				} else {
					before = false;
				}
			} else {
				if (before) {
					node = precedingWithin(node as Node, this.#root);
					if (node === null) return null;
				} else {
					before = true;
				}
			}
			if (filterNode(state, node as Node) === FILTER_ACCEPT) {
				// A filter that removed the very node it was filtering leaves
				// the reference where the pre-removing steps put it: a node
				// outside the root can never be the reference.
				if (isInclusiveAncestor(this.#root, node as Node)) {
					this.#reference = node as Node;
					this.#pointerBefore = before;
				}
				break;
			}
		}
		return node;
	}

	/** The spec's NodeIterator pre-removing steps. */
	[kPreRemove](toBeRemoved: Node): void {
		if (
			!isInclusiveAncestor(toBeRemoved, this.#reference) ||
			isInclusiveAncestor(toBeRemoved, this.#root)
		) {
			return;
		}
		if (this.#pointerBefore) {
			let next = followingWithin(toBeRemoved, this.#root);
			while (next !== null && isInclusiveAncestor(toBeRemoved, next)) {
				next = followingWithin(next, this.#root);
			}
			if (next !== null) {
				this.#reference = next;
				return;
			}
			this.#pointerBefore = false;
		}
		const previous = toBeRemoved[kPrevious];
		if (previous === null) {
			this.#reference = toBeRemoved[kParent] as Node;
			return;
		}
		let last: Node = previous;
		while (last[kLastChild] !== null) last = last[kLastChild] as Node;
		this.#reference = last;
	}
}

function preRemoveFromIterator(iterator: NodeIterator, node: Node): void {
	iterator[kPreRemove](node);
}

Object.defineProperty(NodeIterator.prototype, Symbol.toStringTag, {
	value: "NodeIterator",
	configurable: true,
});

export class TreeWalker {
	#root: Node;
	#current: Node;
	#whatToShow: number;
	#filter: NodeFilterInput;
	#active = {value: false};

	constructor(root: Node, whatToShow: number, filter: NodeFilterInput) {
		this.#root = root;
		this.#current = root;
		this.#whatToShow = whatToShow;
		this.#filter = filter ?? null;
	}

	get root(): Node {
		return this.#root;
	}

	get whatToShow(): number {
		return this.#whatToShow;
	}

	get filter(): NodeFilterInput {
		return this.#filter;
	}

	get currentNode(): Node {
		return this.#current;
	}

	set currentNode(node: Node) {
		if (!(node instanceof Node)) throw new TypeError("That is not a node");
		this.#current = node;
	}

	get #state(): {
		root: Node;
		whatToShow: number;
		filter: NodeFilterInput;
		active: {value: boolean};
	} {
		return {
			root: this.#root,
			whatToShow: this.#whatToShow,
			filter: this.#filter,
			active: this.#active,
		};
	}

	parentNode(): Node | null {
		let node: Node | null = this.#current;
		while (node !== null && node !== this.#root) {
			node = node[kParent];
			if (node !== null && filterNode(this.#state, node) === FILTER_ACCEPT) {
				this.#current = node;
				return node;
			}
		}
		return null;
	}

	firstChild(): Node | null {
		return this.#traverseChildren(true);
	}

	lastChild(): Node | null {
		return this.#traverseChildren(false);
	}

	previousSibling(): Node | null {
		return this.#traverseSiblings(false);
	}

	nextSibling(): Node | null {
		return this.#traverseSiblings(true);
	}

	previousNode(): Node | null {
		let node = this.#current;
		while (node !== this.#root) {
			let sibling = node[kPrevious];
			while (sibling !== null) {
				node = sibling;
				let result = filterNode(this.#state, node);
				while (result !== FILTER_REJECT && node[kLastChild] !== null) {
					node = node[kLastChild] as Node;
					result = filterNode(this.#state, node);
				}
				if (result === FILTER_ACCEPT) {
					this.#current = node;
					return node;
				}
				sibling = node[kPrevious];
			}
			const parent = node[kParent];
			if (node === this.#root || parent === null) return null;
			node = parent;
			if (filterNode(this.#state, node) === FILTER_ACCEPT) {
				this.#current = node;
				return node;
			}
		}
		return null;
	}

	nextNode(): Node | null {
		let node = this.#current;
		let result = FILTER_ACCEPT;
		for (;;) {
			while (result !== FILTER_REJECT && node[kFirstChild] !== null) {
				node = node[kFirstChild] as Node;
				result = filterNode(this.#state, node);
				if (result === FILTER_ACCEPT) {
					this.#current = node;
					return node;
				}
			}
			let sibling: Node | null = null;
			let temporary: Node | null = node;
			while (temporary !== null) {
				if (temporary === this.#root) return null;
				sibling = temporary[kNext];
				if (sibling !== null) break;
				temporary = temporary[kParent];
			}
			if (sibling === null) return null;
			node = sibling;
			result = filterNode(this.#state, node);
			if (result === FILTER_ACCEPT) {
				this.#current = node;
				return node;
			}
		}
	}

	#traverseChildren(first: boolean): Node | null {
		let node: Node | null = first
			? this.#current[kFirstChild]
			: this.#current[kLastChild];
		while (node !== null) {
			const result = filterNode(this.#state, node);
			if (result === FILTER_ACCEPT) {
				this.#current = node;
				return node;
			}
			if (result === FILTER_SKIP) {
				const child = first ? node[kFirstChild] : node[kLastChild];
				if (child !== null) {
					node = child;
					continue;
				}
			}
			for (;;) {
				const sibling = first ? node[kNext] : node[kPrevious];
				if (sibling !== null) {
					node = sibling;
					break;
				}
				const parent: Node | null = node[kParent];
				if (
					parent === null ||
					parent === this.#root ||
					parent === this.#current
				) {
					return null;
				}
				node = parent;
			}
		}
		return null;
	}

	#traverseSiblings(next: boolean): Node | null {
		let node = this.#current;
		if (node === this.#root) return null;
		for (;;) {
			let sibling = next ? node[kNext] : node[kPrevious];
			while (sibling !== null) {
				node = sibling;
				const result = filterNode(this.#state, node);
				if (result === FILTER_ACCEPT) {
					this.#current = node;
					return node;
				}
				sibling = next ? node[kFirstChild] : node[kLastChild];
				if (result === FILTER_REJECT || sibling === null) {
					sibling = next ? node[kNext] : node[kPrevious];
				}
			}
			const parent = node[kParent];
			if (parent === null || parent === this.#root) return null;
			node = parent;
			if (filterNode(this.#state, node) === FILTER_ACCEPT) return null;
		}
	}
}

Object.defineProperty(TreeWalker.prototype, Symbol.toStringTag, {
	value: "TreeWalker",
	configurable: true,
});

/* --------------------------------------------------------------- selectors */

interface SelectorEngine {
	match(selector: string, element: never): boolean;
	first(selector: string, context: never): unknown;
	select(selector: string, context: never): unknown[];
	configure(options: Record<string, boolean>): void;
}

/** The selector engine a document queries through, built on first use. */
function selectorEngine(document: Document): SelectorEngine {
	let engine = document[kNwsapi];
	if (engine === null) {
		engine = NWSAPI({
			document: document as never,
			DOMException: PlatformDOMException as never,
		});
		engine.configure({
			LOGERRORS: false,
			IDS_DUPES: true,
			MIXEDCASE: true,
		});
		if (document.documentElement !== null) {
			document[kNwsapi] = engine;
		}
	}
	return engine as unknown as SelectorEngine;
}

/* ----------------------------------------------------------------- parsing */

interface ParseAttribute {
	name: string;
	value: string;
	namespace?: string;
	prefix?: string;
}

/**
 * The tree adapter parse5 builds through.
 *
 * Every node it creates belongs to the document the adapter was made for, and
 * every insertion runs the same algorithm a script's appendChild runs, so a
 * parsed tree and a scripted tree are the same tree.
 */
function treeAdapterFor(document: Document | null) {
	let target = document;
	const adapter = {
		createDocument(): Document {
			const created = new Document();
			created[kType] = "html";
			created[kContentType] = "text/html";
			if (target === null) target = created;
			return created;
		},
		createDocumentFragment(): DocumentFragment {
			return (target as Document).createDocumentFragment();
		},
		createElement(
			tagName: string,
			namespaceURI: string,
			attrs: ParseAttribute[],
		): Element {
			const element = createElementInternal(
				target as Document,
				tagName,
				namespaceURI,
				null,
				null,
				false,
			);
			adapter.adoptAttributes(element, attrs);
			return element;
		},
		createCommentNode(data: string): Comment {
			return (target as Document).createComment(data);
		},
		createTextNode(value: string): Text {
			return (target as Document).createTextNode(value);
		},
		appendChild(parentNode: Node, newNode: Node): void {
			insertNode(newNode, parentNode, null, true);
		},
		insertBefore(parentNode: Node, newNode: Node, referenceNode: Node): void {
			insertNode(newNode, parentNode, referenceNode, true);
		},
		setTemplateContent(
			templateElement: Element,
			contentElement: DocumentFragment,
		): void {
			contentElement[kHost] = templateElement;
			(templateElement as HTMLTemplateElement)[kTemplateContent] =
				contentElement;
		},
		getTemplateContent(templateElement: Element): DocumentFragment {
			return (templateElement as HTMLTemplateElement).content;
		},
		setDocumentType(
			documentNode: Document,
			name: string,
			publicId: string,
			systemId: string,
		): void {
			const existing = documentNode.doctype;
			if (existing !== null) {
				existing[kName] = name;
				existing[kPublicId] = publicId;
				existing[kSystemId] = systemId;
				return;
			}
			const doctype = new DocumentType(name, publicId, systemId);
			doctype[kDocument] = documentNode;
			insertNode(doctype, documentNode, null, true);
		},
		setDocumentMode(
			documentNode: Document,
			mode: "no-quirks" | "quirks" | "limited-quirks",
		): void {
			documentNode[kMode] = mode;
		},
		getDocumentMode(documentNode: Document): string {
			return documentNode[kMode];
		},
		detachNode(node: Node): void {
			removeNode(node, true);
		},
		insertText(parentNode: Node, text: string): void {
			const last = parentNode[kLastChild];
			if (last !== null && last.nodeType === TEXT_NODE) {
				(last as CharacterData)[kData] += text;
				return;
			}
			adapter.appendChild(
				parentNode,
				(target as Document).createTextNode(text),
			);
		},
		insertTextBefore(
			parentNode: Node,
			text: string,
			referenceNode: Node,
		): void {
			const previous = referenceNode[kPrevious];
			if (previous !== null && previous.nodeType === TEXT_NODE) {
				(previous as CharacterData)[kData] += text;
				return;
			}
			adapter.insertBefore(
				parentNode,
				(target as Document).createTextNode(text),
				referenceNode,
			);
		},
		adoptAttributes(recipient: Element, attrs: ParseAttribute[]): void {
			for (const attribute of attrs) {
				const namespace = attribute.namespace ?? null;
				const prefix = attribute.prefix ?? null;
				const localName = attribute.name;
				if (getAttributeByNamespace(recipient, namespace, localName) !== null) {
					continue;
				}
				const created = new Attr(namespace, prefix, localName, attribute.value);
				created[kDocument] = recipient[kDocument];
				appendAttribute(recipient, created);
			}
		},
		getFirstChild(node: Node): Node | null {
			return node[kFirstChild];
		},
		getChildNodes(node: Node): Node[] {
			return childNodeArray(node);
		},
		getParentNode(node: Node): Node | null {
			return node[kParent];
		},
		getAttrList(element: Element): ParseAttribute[] {
			return element[kAttributeList].map((attribute) => ({
				name: attribute[kQualifiedName],
				value: attribute[kValue],
				namespace: attribute[kNamespace] ?? undefined,
				prefix: attribute[kPrefix] ?? undefined,
			}));
		},
		getTagName(element: Element): string {
			return element[kQualifiedName];
		},
		getNamespaceURI(element: Element): string {
			return element[kNamespace] as string;
		},
		getTextNodeContent(textNode: CharacterData): string {
			return textNode[kData];
		},
		getCommentNodeContent(commentNode: CharacterData): string {
			return commentNode[kData];
		},
		getDocumentTypeNodeName(doctypeNode: DocumentType): string {
			return doctypeNode[kName];
		},
		getDocumentTypeNodePublicId(doctypeNode: DocumentType): string {
			return doctypeNode[kPublicId];
		},
		getDocumentTypeNodeSystemId(doctypeNode: DocumentType): string {
			return doctypeNode[kSystemId];
		},
		isTextNode(node: Node): boolean {
			return node.nodeType === TEXT_NODE;
		},
		isCommentNode(node: Node): boolean {
			return node.nodeType === COMMENT_NODE;
		},
		isDocumentTypeNode(node: Node): boolean {
			return node.nodeType === DOCUMENT_TYPE_NODE;
		},
		isElementNode(node: Node): boolean {
			return node.nodeType === ELEMENT_NODE;
		},
		setNodeSourceCodeLocation(): void {},
		getNodeSourceCodeLocation(): undefined {
			return undefined;
		},
		updateNodeSourceCodeLocation(): void {},
	};
	return adapter;
}

/**
 * Turn the templates a declarative shadow root was parsed as into shadow
 * trees.
 *
 * The HTML parser attaches a shadow root the moment it sees a template whose
 * shadowrootmode names a mode; parse5 has no such step, so the templates land
 * as templates and this walk converts them afterwards. The walk is depth-first
 * over the tree it is given and then over each shadow tree it creates, which
 * reaches a nested declarative root inside one. A template whose parent cannot
 * host a shadow tree, or whose parent already hosts one, stays a template --
 * the parser's own error handling.
 */
function attachDeclarativeShadowRoots(root: Node): void {
	for (const child of childNodeArray(root)) {
		if (child.nodeType !== ELEMENT_NODE) continue;
		const element = child as Element;
		if (
			element[kNamespace] === HTML_NAMESPACE &&
			element[kLocalName] === "template"
		) {
			if (!attachDeclarativeShadowRoot(element as HTMLTemplateElement)) {
				attachDeclarativeShadowRoots((element as HTMLTemplateElement).content);
			}
			continue;
		}
		attachDeclarativeShadowRoots(element);
	}
}

/** Turn one template into its host's shadow root, if it names a mode. */
function attachDeclarativeShadowRoot(template: HTMLTemplateElement): boolean {
	const named = template.getAttribute("shadowrootmode");
	if (named === null) return false;
	const mode = asciiLowercase(named);
	if (mode !== "open" && mode !== "closed") return false;
	const host = template[kParent];
	if (host === null || host.nodeType !== ELEMENT_NODE) return false;
	try {
		attachShadowRoot(
			host as Element,
			mode,
			template.hasAttribute("shadowrootclonable"),
			template.hasAttribute("shadowrootserializable"),
			template.hasAttribute("shadowrootdelegatesfocus"),
			"named",
		);
	} catch {
		return false;
	}
	const shadow = (host as Element)[kShadowRoot] as ShadowRoot;
	shadow[kDeclarative] = true;
	const content = template[kTemplateContent];
	removeNode(template);
	if (content !== null) {
		for (const child of childNodeArray(content)) {
			insertNode(child, shadow, null, true);
		}
	}
	attachDeclarativeShadowRoots(shadow);
	return true;
}

/** Parse an HTML document, per the HTML Standard's parsing algorithm. */
export function parseHTMLDocument(
	html: string,
	url = "about:blank",
	allowDeclarativeShadowRoots = true,
): Document {
	const adapter = treeAdapterFor(null);
	const document = parse5Parse(html, {
		treeAdapter: adapter as never,
	}) as unknown as Document;
	document[kDocumentURL] = url;
	if (allowDeclarativeShadowRoots) attachDeclarativeShadowRoots(document);
	return document;
}

/**
 * The HTML fragment parsing algorithm, with a context element.
 *
 * A declarative shadow root only becomes one where the caller allowed it:
 * innerHTML does not, and setHTMLUnsafe and parseHTMLUnsafe do.
 */
function parseFragmentHTML(
	markup: string,
	context: Element,
	allowDeclarativeShadowRoots = false,
): DocumentFragment {
	const document = context[kDocument];
	const adapter = treeAdapterFor(document);
	const parsed = parseFragment(context as never, markup, {
		treeAdapter: adapter as never,
	}) as unknown as DocumentFragment;
	const fragment = document.createDocumentFragment();
	for (const child of childNodeArray(parsed)) {
		insertNode(child, fragment, null, true);
	}
	if (allowDeclarativeShadowRoots) attachDeclarativeShadowRoots(fragment);
	return fragment;
}

/** Parse a whole document, declarative shadow roots and all. */
export function parseHTMLUnsafe(html: string): Document {
	return parseHTMLDocument(String(html));
}

export class DOMParser {
	parseFromString(string: string, type: string): Document {
		const contentType = String(type);
		if (contentType === "text/html") {
			return parseHTMLDocument(String(string), "about:blank", false);
		}
		if (
			contentType === "text/xml" ||
			contentType === "application/xml" ||
			contentType === "application/xhtml+xml" ||
			contentType === "image/svg+xml"
		) {
			// There is no XML parser here. The spec's own answer to a fatal XML
			// parse error is a document holding a parsererror element, which is
			// what every XML string gets.
			const document = new XMLDocument();
			document[kType] = "xml";
			document[kContentType] = contentType;
			const error = createElementInternal(
				document,
				"parsererror",
				"http://www.mozilla.org/newlayout/xml/parsererror.xml",
			);
			appendNode(error, document);
			const text = document.createTextNode(
				"XML parsing is not implemented in this DOM.",
			);
			appendNode(text, error);
			return document;
		}
		throw new TypeError(`"${type}" is not a supported content type`);
	}
}

Object.defineProperty(DOMParser.prototype, Symbol.toStringTag, {
	value: "DOMParser",
	configurable: true,
});

/* ----------------------------------------------------------- serialization */

const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"basefont",
	"bgsound",
	"br",
	"col",
	"embed",
	"frame",
	"hr",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

const RAW_TEXT_PARENTS = new Set([
	"style",
	"script",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
	"noscript",
]);

function escapeText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/\u00a0/g, "&nbsp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/\u00a0/g, "&nbsp;")
		.replace(/"/g, "&quot;");
}

function attributeSerializedName(attribute: Attr): string {
	const namespace = attribute[kNamespace];
	if (namespace === null) return attribute[kLocalName];
	if (namespace === XML_NAMESPACE) return `xml:${attribute[kLocalName]}`;
	if (namespace === XMLNS_NAMESPACE) {
		return attribute[kLocalName] === "xmlns"
			? "xmlns"
			: `xmlns:${attribute[kLocalName]}`;
	}
	if (namespace === XLINK_NAMESPACE) return `xlink:${attribute[kLocalName]}`;
	return attribute[kQualifiedName];
}

/**
 * The HTML fragment serialization algorithm, over a node's children.
 *
 * A shadow root is written out as the template the parser reads back, but only
 * where the caller asked for it: getHTML's options say whether a serializable
 * root counts and name the closed roots to include. innerHTML asks for none,
 * so a shadow tree stays invisible to it.
 */
function serializeFragment(
	node: Node,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[] = [],
): string {
	let children = node;
	if (
		node.nodeType === ELEMENT_NODE &&
		(node as Element)[kNamespace] === HTML_NAMESPACE &&
		(node as Element)[kLocalName] === "template"
	) {
		const content = (node as HTMLTemplateElement)[kTemplateContent];
		if (content !== null && content !== undefined) children = content;
	}
	let html = "";
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot];
		if (
			shadow !== null &&
			((serializableShadowRoots && shadow[kSerializable]) ||
				shadowRoots.includes(shadow))
		) {
			html += serializeShadowRoot(shadow, serializableShadowRoots, shadowRoots);
		}
	}
	for (
		let child = children[kFirstChild];
		child !== null;
		child = child[kNext]
	) {
		html += serializeNode(child, serializableShadowRoots, shadowRoots);
	}
	return html;
}

function serializeOuterHTML(element: Element): string {
	return serializeNode(element, false, []);
}

/** The template a declarative shadow root serializes as. */
function serializeShadowRoot(
	shadow: ShadowRoot,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[],
): string {
	let html = `<template shadowrootmode="${shadow[kShadowMode]}"`;
	if (shadow[kDelegatesFocus]) html += ' shadowrootdelegatesfocus=""';
	if (shadow[kSerializable]) html += ' shadowrootserializable=""';
	if (shadow[kClonable]) html += ' shadowrootclonable=""';
	html += ">";
	html += serializeFragment(shadow, serializableShadowRoots, shadowRoots);
	html += "</template>";
	return html;
}

function serializeNode(
	node: Node,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[],
): string {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
			const element = node as Element;
			const namespace = element[kNamespace];
			const tagName =
				namespace === HTML_NAMESPACE ||
				namespace === MATHML_NAMESPACE ||
				namespace === SVG_NAMESPACE
					? element[kLocalName]
					: element[kQualifiedName];
			let html = `<${tagName}`;
			for (const attribute of element[kAttributeList]) {
				html += ` ${attributeSerializedName(attribute)}="${escapeAttribute(
					attribute[kValue],
				)}"`;
			}
			html += ">";
			if (namespace === HTML_NAMESPACE && VOID_ELEMENTS.has(tagName)) {
				return html;
			}
			html += serializeFragment(element, serializableShadowRoots, shadowRoots);
			html += `</${tagName}>`;
			return html;
		}
		case TEXT_NODE: {
			const parent = node[kParent];
			if (
				parent !== null &&
				parent.nodeType === ELEMENT_NODE &&
				(parent as Element)[kNamespace] === HTML_NAMESPACE &&
				RAW_TEXT_PARENTS.has((parent as Element)[kLocalName])
			) {
				return (node as CharacterData)[kData];
			}
			return escapeText((node as CharacterData)[kData]);
		}
		case CDATA_SECTION_NODE:
			return `<![CDATA[${(node as CharacterData)[kData]}]]>`;
		case COMMENT_NODE:
			return `<!--${(node as CharacterData)[kData]}-->`;
		case PROCESSING_INSTRUCTION_NODE:
			return `<?${(node as ProcessingInstruction)[kTarget]} ${
				(node as CharacterData)[kData]
			}>`;
		case DOCUMENT_TYPE_NODE:
			return `<!DOCTYPE ${(node as DocumentType)[kName]}>`;
		default: {
			let html = "";
			for (
				let child = node[kFirstChild];
				child !== null;
				child = child[kNext]
			) {
				html += serializeNode(child, serializableShadowRoots, shadowRoots);
			}
			return html;
		}
	}
}

/* --------------------------------------------------- custom element boundaries */

/**
 * Every member the IDL marks [CEReactions], wrapped once the prototypes are
 * complete.
 *
 * The list is the extended attribute's, read off the interfaces this DOM has:
 * anything that can insert, remove, rename or restyle a node is here, and
 * nothing else is. A member missing from this list would run an author's
 * callback in the middle of the mutation that caused it instead of after it.
 */
ceReactions(Node.prototype, [
	"appendChild",
	"insertBefore",
	"removeChild",
	"replaceChild",
	"normalize",
	"cloneNode",
	"nodeValue",
	"textContent",
]);
ceReactions(Element.prototype, [
	"after",
	"append",
	"attachShadow",
	"before",
	"className",
	"id",
	"innerHTML",
	"insertAdjacentElement",
	"insertAdjacentHTML",
	"insertAdjacentText",
	"outerHTML",
	"prepend",
	"remove",
	"removeAttribute",
	"removeAttributeNS",
	"removeAttributeNode",
	"replaceChildren",
	"replaceWith",
	"setAttribute",
	"setAttributeNS",
	"setAttributeNode",
	"setAttributeNodeNS",
	"setHTMLUnsafe",
	"slot",
	"toggleAttribute",
]);
ceReactions(ShadowRoot.prototype, ["innerHTML", "setHTMLUnsafe"]);
ceReactions(HTMLSlotElement.prototype, ["assign", "name"]);
ceReactions(DocumentFragment.prototype, [
	"append",
	"prepend",
	"replaceChildren",
]);
ceReactions(Document.prototype, [
	"adoptNode",
	"append",
	"createElement",
	"createElementNS",
	"importNode",
	"prepend",
	"replaceChildren",
	"title",
]);
ceReactions(CharacterData.prototype, [
	"after",
	"appendData",
	"before",
	"data",
	"deleteData",
	"insertData",
	"remove",
	"replaceData",
	"replaceWith",
]);
ceReactions(DocumentType.prototype, [
	"after",
	"before",
	"remove",
	"replaceWith",
]);
ceReactions(Attr.prototype, ["nodeValue", "textContent", "value"]);
ceReactions(NamedNodeMap.prototype, [
	"removeNamedItem",
	"removeNamedItemNS",
	"setNamedItem",
	"setNamedItemNS",
]);
ceReactions(DOMTokenList.prototype, [
	"add",
	"remove",
	"replace",
	"toggle",
	"value",
]);
ceReactions(CustomElementRegistry.prototype, ["define", "upgrade"]);
