/**
 * The DOM Standard's node tree, standalone.
 *
 * This is TermDOM's own implementation of the tree half of the DOM: Node and
 * its subclasses, the mutation algorithms, attributes, live collections,
 * traversal, the ParentNode/ChildNode mixins, HTML parsing and serialization
 * through parse5, and selector matching through nwsapi.
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
		throw domError("NamespaceError", "The xmlns name needs the XMLNS namespace");
	}
	if (
		ns === XMLNS_NAMESPACE &&
		qualifiedName !== "xmlns" &&
		prefix !== "xmlns"
	) {
		throw domError("NamespaceError", "The XMLNS namespace needs the xmlns name");
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

interface DispatchState {
	target: EventTarget | null;
	currentTarget: EventTarget | null;
	eventPhase: number;
	path: EventTarget[];
	dispatch: boolean;
	stopPropagation: boolean;
	stopImmediate: boolean;
	trusted: boolean;
}

/**
 * An event, with a dispatch that walks the tree.
 *
 * Phase 1 carries the propagation path, the three phases, and the flags a
 * listener sets. The parts of the dispatch algorithm that exist for shadow
 * trees, activation behavior and the event loop belong to later phases.
 */
export class Event {
	#type: string;
	#bubbles: boolean;
	#cancelable: boolean;
	#composed: boolean;
	#defaultPrevented = false;
	#timeStamp: number;
	#state: DispatchState = {
		target: null,
		currentTarget: null,
		eventPhase: NONE,
		path: [],
		dispatch: false,
		stopPropagation: false,
		stopImmediate: false,
		trusted: false,
	};

	static readonly NONE = NONE;
	static readonly CAPTURING_PHASE = CAPTURING_PHASE;
	static readonly AT_TARGET = AT_TARGET;
	static readonly BUBBLING_PHASE = BUBBLING_PHASE;

	constructor(type: string, eventInitDict: EventInit = {}) {
		if (arguments.length < 1) {
			throw new TypeError("Event constructor needs a type");
		}
		this.#type = String(type);
		this.#bubbles = Boolean(eventInitDict && eventInitDict.bubbles);
		this.#cancelable = Boolean(eventInitDict && eventInitDict.cancelable);
		this.#composed = Boolean(eventInitDict && eventInitDict.composed);
		this.#timeStamp = Date.now();
	}

	get [kDispatchState](): DispatchState {
		return this.#state;
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
		return this.#defaultPrevented;
	}

	get isTrusted(): boolean {
		return this.#state.trusted;
	}

	get timeStamp(): number {
		return this.#timeStamp;
	}

	get returnValue(): boolean {
		return !this.#defaultPrevented;
	}

	set returnValue(value: boolean) {
		if (!value) this.preventDefault();
	}

	get cancelBubble(): boolean {
		return this.#state.stopPropagation;
	}

	set cancelBubble(value: boolean) {
		if (value) this.#state.stopPropagation = true;
	}

	composedPath(): EventTarget[] {
		return this.#state.path.slice();
	}

	stopPropagation(): void {
		this.#state.stopPropagation = true;
	}

	stopImmediatePropagation(): void {
		this.#state.stopPropagation = true;
		this.#state.stopImmediate = true;
	}

	preventDefault(): void {
		if (this.#cancelable) this.#defaultPrevented = true;
	}

	initEvent(type: string, bubbles = false, cancelable = false): void {
		if (this.#state.dispatch) return;
		this.#type = String(type);
		this.#bubbles = Boolean(bubbles);
		this.#cancelable = Boolean(cancelable);
		this.#state.target = null;
		this.#defaultPrevented = false;
		this.#state.stopPropagation = false;
		this.#state.stopImmediate = false;
	}
}

Object.defineProperties(Event.prototype, {
	NONE: {value: NONE, enumerable: true},
	CAPTURING_PHASE: {value: CAPTURING_PHASE, enumerable: true},
	AT_TARGET: {value: AT_TARGET, enumerable: true},
	BUBBLING_PHASE: {value: BUBBLING_PHASE, enumerable: true},
	[Symbol.toStringTag]: {value: "Event", configurable: true},
});

export class CustomEvent<T = unknown> extends Event {
	#detail: T | null;

	constructor(type: string, eventInitDict: CustomEventInit<T> = {}) {
		super(type, eventInitDict);
		this.#detail = (eventInitDict && eventInitDict.detail) ?? null;
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
		this.initEvent(type, bubbles, cancelable);
		this.#detail = detail;
	}
}

export type EventListenerOrEventListenerObject =
	| ((event: Event) => void)
	| {handleEvent(event: Event): void};

export interface AddEventListenerOptions {
	capture?: boolean;
	once?: boolean;
	passive?: boolean;
	signal?: {aborted: boolean; addEventListener(type: string, cb: () => void): void};
}

interface Listener {
	type: string;
	callback: EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;
}

function normalizeOptions(
	options: boolean | AddEventListenerOptions | undefined,
): {capture: boolean; once: boolean; passive: boolean; signal: AddEventListenerOptions["signal"]} {
	if (typeof options === "boolean" || options == null) {
		return {
			capture: Boolean(options),
			once: false,
			passive: false,
			signal: undefined,
		};
	}
	return {
		capture: Boolean(options.capture),
		once: Boolean(options.once),
		passive: Boolean(options.passive),
		signal: options.signal,
	};
}

/**
 * An event target: a listener list, and a dispatch that walks the ancestor
 * chain of a node.
 */
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
		if (callback == null) return;
		const {capture, once, passive, signal} = normalizeOptions(options);
		if (signal && signal.aborted) return;
		const name = String(type);
		for (const listener of this.#listeners) {
			if (
				listener.type === name &&
				listener.callback === callback &&
				listener.capture === capture &&
				!listener.removed
			) {
				return;
			}
		}
		const listener: Listener = {
			type: name,
			callback,
			capture,
			once,
			passive,
			removed: false,
		};
		this.#listeners.push(listener);
		if (signal) {
			signal.addEventListener("abort", () => {
				listener.removed = true;
				const index = this.#listeners.indexOf(listener);
				if (index !== -1) this.#listeners.splice(index, 1);
			});
		}
	}

	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("removeEventListener needs a type and a callback");
		}
		if (callback == null) return;
		const {capture} = normalizeOptions(options);
		const name = String(type);
		for (let i = 0; i < this.#listeners.length; i++) {
			const listener = this.#listeners[i];
			if (
				listener.type === name &&
				listener.callback === callback &&
				listener.capture === capture
			) {
				listener.removed = true;
				this.#listeners.splice(i, 1);
				return;
			}
		}
	}

	dispatchEvent(event: Event): boolean {
		if (!(event instanceof Event)) {
			throw new TypeError("dispatchEvent needs an Event");
		}
		const state = event[kDispatchState];
		if (state.dispatch || state.eventPhase !== NONE) {
			throw domError(
				"InvalidStateError",
				"That event is already being dispatched",
			);
		}
		state.trusted = false;
		return dispatchEvent(this, event);
	}

	/** The listeners this target holds, for the dispatch algorithm. */
	get [kListeners](): Listener[] {
		return this.#listeners;
	}
}

Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, {
	value: "EventTarget",
	configurable: true,
});

/** The propagation path: the target and its ancestors, root last. */
function eventPath(target: EventTarget): EventTarget[] {
	const path: EventTarget[] = [target];
	let current: unknown = target;
	while (current instanceof Node) {
		const parent: Node | null = current.parentNode;
		if (parent === null) break;
		path.push(parent);
		current = parent;
	}
	return path;
}

function invokeListeners(
	event: Event,
	target: EventTarget,
	phase: number,
): void {
	const state = event[kDispatchState];
	state.currentTarget = target;
	state.eventPhase = phase;
	const listeners = target[kListeners].slice();
	for (const listener of listeners) {
		if (listener.removed) continue;
		if (listener.type !== event.type) continue;
		if (phase === CAPTURING_PHASE && !listener.capture) continue;
		if (phase === BUBBLING_PHASE && listener.capture) continue;
		if (listener.once) {
			listener.removed = true;
			const live = target[kListeners];
			const index = live.indexOf(listener);
			if (index !== -1) live.splice(index, 1);
		}
		try {
			if (typeof listener.callback === "function") {
				listener.callback.call(target, event);
			} else {
				listener.callback.handleEvent(event);
			}
		} catch (error) {
			reportError(error);
		}
		if (state.stopImmediate) return;
	}
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

/** Dispatch an event at a target, walking the ancestor chain both ways. */
function dispatchEvent(target: EventTarget, event: Event): boolean {
	const state = event[kDispatchState];
	state.dispatch = true;
	state.target = target;
	state.stopPropagation = false;
	state.stopImmediate = false;
	const path = eventPath(target);
	state.path = path;
	for (let i = path.length - 1; i > 0; i--) {
		if (state.stopPropagation) break;
		invokeListeners(event, path[i], CAPTURING_PHASE);
		state.stopImmediate = false;
	}
	if (!state.stopPropagation) {
		invokeListeners(event, target, AT_TARGET);
		state.stopImmediate = false;
	}
	if (event.bubbles) {
		for (let i = 1; i < path.length; i++) {
			if (state.stopPropagation) break;
			invokeListeners(event, path[i], BUBBLING_PHASE);
			state.stopImmediate = false;
		}
	}
	state.eventPhase = NONE;
	state.currentTarget = null;
	state.dispatch = false;
	state.path = [];
	return !event.defaultPrevented;
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
		if (collection !== undefined) collection[kSync]();
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
		return getRoot(this).nodeType === DOCUMENT_NODE;
	}

	get ownerDocument(): Document | null {
		return this.nodeType === DOCUMENT_NODE
			? null
			: (this[kDocument] as Document);
	}

	getRootNode(options?: {composed?: boolean}): Node {
		void options;
		return getRoot(this);
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
		if (
			node1 === null ||
			node2 === null ||
			getRoot(node1) !== getRoot(node2)
		) {
			const first = node1 === null || node2 === null
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
				return parent === null ? null : locateNamespacePrefix(parent, namespace);
			}
		}
	}

	lookupNamespaceURI(prefix: string | null): string | null {
		return locateNamespace(this, prefix === "" ? null : prefix);
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

function childIndex(node: Node): number {
	let index = 0;
	let current = node[kPrevious];
	while (current !== null) {
		index++;
		current = current[kPrevious];
	}
	return index;
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
	if (type === DOCUMENT_FRAGMENT_NODE) {
		const elementCount = countChildren(node, ELEMENT_NODE);
		if (elementCount > 1 || countChildren(node, TEXT_NODE) > 0) {
			throw hierarchyRequestError("That fragment cannot go in a document");
		}
		if (
			elementCount === 1 &&
			(countChildren(parent, ELEMENT_NODE) > 0 ||
				(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
				hasFollowing(child, DOCUMENT_TYPE_NODE))
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === ELEMENT_NODE) {
		if (
			countChildren(parent, ELEMENT_NODE) > 0 ||
			(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
			hasFollowing(child, DOCUMENT_TYPE_NODE)
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === DOCUMENT_TYPE_NODE) {
		if (
			countChildren(parent, DOCUMENT_TYPE_NODE) > 0 ||
			(child !== null && hasPreceding(child, ELEMENT_NODE)) ||
			(child === null && countChildren(parent, ELEMENT_NODE) > 0)
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
	const previousSibling = child !== null ? child[kPrevious] : parent[kLastChild];
	const document = parent[kDocument];
	for (const inserted of nodes) {
		adoptNode(inserted, document);
		linkChild(inserted, parent, child);
		for (const descendant of inclusiveDescendants(inserted)) {
			descendant[kInsertionSteps]();
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
	for (const descendant of inclusiveDescendants(node)) {
		descendant[kRemovingSteps](parent);
	}
	bumpVersion();
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
	for (const descendant of inclusiveDescendants(node)) {
		descendant[kDocument] = document;
		if (descendant.nodeType === ELEMENT_NODE) {
			for (const attr of (descendant as Element)[kAttributeList]) {
				attr[kDocument] = document;
			}
		}
	}
	for (const descendant of inclusiveDescendants(node)) {
		descendant[kAdoptingSteps](oldDocument);
	}
}

/* --------------------------------------------------------- mutation record */

/**
 * Where a queued mutation record goes.
 *
 * MutationObserver is a later phase; the call sites the spec names exist here
 * so that phase has one place to land, and so the engine can observe a tree
 * change without a second traversal.
 */
function queueTreeMutationRecord(
	_target: Node,
	_addedNodes: Node[],
	_removedNodes: Node[],
	_previousSibling: Node | null,
	_nextSibling: Node | null,
): void {}

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
		for (let index = this.#defined; index < items.length; index++) {
			const at = index;
			Object.defineProperty(this, at, {
				get(this: LiveList) {
					return this[kEnsure]()[at] ?? undefined;
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

export class NodeList extends LiveList {
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

	forEach(
		callback: (node: Node, index: number, list: NodeList) => void,
		thisArg?: unknown,
	): void {
		const items = this[kEnsure]();
		for (let index = 0; index < items.length; index++) {
			callback.call(thisArg, items[index], index, this);
		}
	}

	*keys(): IterableIterator<number> {
		const items = this[kEnsure]();
		for (let index = 0; index < items.length; index++) yield index;
	}

	*values(): IterableIterator<Node> {
		yield* this[kEnsure]().slice();
	}

	*entries(): IterableIterator<[number, Node]> {
		const items = this[kEnsure]().slice();
		for (let index = 0; index < items.length; index++) yield [index, items[index]];
	}

	[Symbol.iterator](): IterableIterator<Node> {
		return this.values();
	}
}

Object.defineProperty(NodeList.prototype, Symbol.toStringTag, {
	value: "NodeList",
	configurable: true,
});

export class HTMLCollection extends LiveList {
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

	*[Symbol.iterator](): IterableIterator<Element> {
		yield* this[kEnsure]().slice() as Element[];
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
	let cache = owner[kCollectionCaches] as Map<string, HTMLCollection> | undefined;
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
			const found: Element[] = [];
			for (const node of descendants(root)) {
				if (node.nodeType !== ELEMENT_NODE) continue;
				const element = node as Element;
				if (qualifiedName === "*") {
					found.push(element);
				} else if (element.namespaceURI === HTML_NAMESPACE) {
					if (element[kQualifiedName] === lowered) found.push(element);
				} else if (element[kQualifiedName] === qualifiedName) {
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
			for (const node of descendants(root)) {
				if (node.nodeType !== ELEMENT_NODE) continue;
				const element = node as Element;
				if (ns !== "*" && element.namespaceURI !== ns) continue;
				if (localName !== "*" && element.localName !== localName) continue;
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
			for (const node of descendants(root)) {
				if (node.nodeType !== ELEMENT_NODE) continue;
				const element = node as Element;
				const tokens = element.classList;
				let all = true;
				for (const name of wanted) {
					if (!tokens[kHasToken](name, isQuirks)) {
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

const kHasToken = Symbol("token membership");

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

	[kHasToken](token: string, caseInsensitive: boolean): boolean {
		const tokens = this.#tokens;
		if (!caseInsensitive) return tokens.includes(token);
		const lowered = asciiLowercase(token);
		return tokens.some((each) => asciiLowercase(each) === lowered);
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
		for (const token of tokens) validateToken(token);
		const current = this.#tokens.slice();
		for (const token of tokens) {
			if (!current.includes(token)) current.push(String(token));
		}
		this.#write(current);
	}

	remove(...tokens: string[]): void {
		for (const token of tokens) validateToken(token);
		const current = this.#tokens.filter(
			(each) => !tokens.some((token) => String(token) === each),
		);
		this.#write(current);
	}

	toggle(token: string, force?: boolean): boolean {
		validateToken(token);
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
		validateToken(token);
		validateToken(newToken);
		const current = this.#tokens.slice();
		const index = current.indexOf(String(token));
		if (index === -1) return false;
		const replacement = String(newToken);
		const existing = current.indexOf(replacement);
		if (existing !== -1 && existing !== index) {
			current.splice(index, 1);
		} else {
			current[index] = replacement;
		}
		this.#write(current);
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

	forEach(
		callback: (token: string, index: number, list: DOMTokenList) => void,
		thisArg?: unknown,
	): void {
		const tokens = this.#tokens.slice();
		for (let index = 0; index < tokens.length; index++) {
			callback.call(thisArg, tokens[index], index, this);
		}
	}

	*keys(): IterableIterator<number> {
		const tokens = this.#tokens;
		for (let index = 0; index < tokens.length; index++) yield index;
	}

	*values(): IterableIterator<string> {
		yield* this.#tokens.slice();
	}

	*entries(): IterableIterator<[number, string]> {
		const tokens = this.#tokens.slice();
		for (let index = 0; index < tokens.length; index++) {
			yield [index, tokens[index]];
		}
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.values();
	}
}

Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, {
	value: "DOMTokenList",
	configurable: true,
});

function validateToken(token: string): void {
	const name = String(token);
	if (name === "") {
		throw domError("SyntaxError", "A token cannot be the empty string");
	}
	if (/[\t\n\f\r ]/.test(name)) {
		throw domError(
			"InvalidCharacterError",
			"A token cannot contain ASCII whitespace",
		);
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
		replaceData(this, 0, this[kData].length, value === null ? "" : String(value));
	}

	get length(): number {
		return this[kData].length;
	}

	override get nodeValue(): string | null {
		return this[kData];
	}

	override set nodeValue(value: string | null) {
		replaceData(this, 0, this[kData].length, value === null ? "" : String(value));
	}

	override get textContent(): string | null {
		return this[kData];
	}

	override set textContent(value: string | null) {
		replaceData(this, 0, this[kData].length, value === null ? "" : String(value));
	}

	substringData(offset: number, count: number): string {
		const length = this[kData].length;
		const start = toUnsignedLong(offset);
		if (start > length) throw indexSizeError("The offset is past the end");
		const size = toUnsignedLong(count);
		if (start + size > length) return this[kData].slice(start);
		return this[kData].slice(start, start + size);
	}

	appendData(data: string): void {
		replaceData(this, this[kData].length, 0, String(data));
	}

	insertData(offset: number, data: string): void {
		replaceData(this, toUnsignedLong(offset), 0, String(data));
	}

	deleteData(offset: number, count: number): void {
		replaceData(this, toUnsignedLong(offset), toUnsignedLong(count), "");
	}

	replaceData(offset: number, count: number, data: string): void {
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
	node[kData] = oldValue.slice(0, offset) + data + oldValue.slice(offset + size);
	queueCharacterDataMutationRecord(node, oldValue);
	bumpVersion();
	const parent = node[kParent];
	if (parent !== null) parent[kChildrenChanged]();
}

/**
 * Where a queued character data record goes. MutationObserver is a later
 * phase; the call site the spec names exists here.
 */
function queueCharacterDataMutationRecord(
	_node: CharacterData,
	_oldValue: string,
): void {}

export class Text extends CharacterData {
	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kDocument] = currentDocument();
	}

	override get nodeType(): number {
		return TEXT_NODE;
	}

	override get nodeName(): string {
		return "#text";
	}

	splitText(offset: number): Text {
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
	for (const descendant of descendants(node)) {
		if (descendant.nodeType === TEXT_NODE) {
			text += (descendant as CharacterData)[kData];
		}
	}
	return text;
}

function setDescendantText(node: Node, value: string | null): void {
	const string = value === null ? "" : String(value);
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
		setExistingAttributeValue(this, value === null ? "" : String(value));
	}

	override get textContent(): string | null {
		return this[kValue];
	}

	override set textContent(value: string | null) {
		setExistingAttributeValue(this, value === null ? "" : String(value));
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

/**
 * Where a queued attribute record goes. MutationObserver is a later phase;
 * the call site the spec names exists here.
 */
function queueAttributeMutationRecord(
	_element: Element,
	_attribute: Attr,
	_oldValue: string | null,
): void {}

function getAttributeByName(element: Element, qualifiedName: string): Attr | null {
	let name = qualifiedName;
	if (element[kNamespace] === HTML_NAMESPACE && isHTMLDocument(element[kDocument])) {
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
	if (attribute[kOwnerElement] !== null && attribute[kOwnerElement] !== element) {
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
		return getAttributeByNamespace(
			this.#element,
			namespace,
			String(localName),
		);
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

	*[Symbol.iterator](): IterableIterator<Attr> {
		yield* this[kEnsure]().slice() as Attr[];
	}
}

Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, {
	value: "NamedNodeMap",
	configurable: true,
});

/* ---------------------------------------------------------------- elements */

const kCustomState = Symbol("custom element state");
const kDefinition = Symbol("element definition");
const kIsValue = Symbol("is value");
const kClassList = Symbol("classList");
const kAttributesMap = Symbol("attributes");

type CustomElementState =
	| "uncustomized"
	| "undefined"
	| "custom"
	| "precustomized";

/**
 * What the tree knows about a kind of element.
 *
 * Every element -- a div as much as a would-be custom element -- is created by
 * looking one of these up, so the machinery a definition needs (a constructor,
 * an observed-attribute set, lifecycle reactions) is the same machinery the
 * built-ins already run through. Nothing about it is on the public surface.
 */
interface ElementDefinition {
	namespace: string | null;
	localName: string;
	is: string | null;
	constructor: new () => Element;
	observedAttributes: Set<string>;
	connectedCallback?: (element: Element) => void;
	disconnectedCallback?: (element: Element) => void;
	adoptedCallback?: (element: Element, from: Document, to: Document) => void;
	attributeChangedCallback?: (
		element: Element,
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	) => void;
	custom: boolean;
}

/** The registry a document looks an element definition up in. */
class ElementRegistry {
	#byName = new Map<string, ElementDefinition>();

	define(definition: ElementDefinition): void {
		this.#byName.set(
			`${definition.namespace}|${definition.localName}|${definition.is ?? ""}`,
			definition,
		);
	}

	lookup(
		namespace: string | null,
		localName: string,
		is: string | null,
	): ElementDefinition | null {
		return (
			this.#byName.get(`${namespace}|${localName}|${is ?? ""}`) ??
			this.#byName.get(`${namespace}|${localName}|`) ??
			null
		);
	}
}

const builtinRegistry = new ElementRegistry();

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
	"a", "area", "audio", "base", "blockquote", "body", "br", "button",
	"canvas", "caption", "col", "colgroup", "data", "datalist", "del",
	"details", "dialog", "div", "dl", "embed", "fieldset", "form", "h1", "h2",
	"h3", "h4", "h5", "h6", "head", "hr", "html", "iframe", "img", "input",
	"ins", "label", "legend", "li", "link", "map", "menu", "meta", "meter",
	"object", "ol", "optgroup", "option", "output", "p", "param", "picture",
	"pre", "progress", "q", "script", "select", "slot", "source", "span",
	"style", "table", "tbody", "td", "template", "textarea", "tfoot", "th",
	"thead", "time", "title", "tr", "track", "ul", "video",
	// The obsolete names that still have an interface.
	"acronym", "basefont", "big", "center", "dir", "font", "frame",
	"frameset", "isindex", "keygen", "listing", "marquee", "nobr",
	"noembed", "noframes", "plaintext", "rb", "rtc", "strike", "tt", "xmp",
]);

export class Element extends Node {
	[kNamespace]: string | null = null;
	[kPrefix]: string | null = null;
	[kLocalName] = "";
	[kAttributeList]: Attr[] = [];
	[kCustomState]: CustomElementState = "uncustomized";
	[kDefinition]: ElementDefinition | null = null;
	[kIsValue]: string | null = null;
	[kClassList]: DOMTokenList | null = null;
	[kAttributesMap]: NamedNodeMap | null = null;
	[kChildren]: HTMLCollection | null = null;

	constructor() {
		super();
		this[kDocument] = currentDocument();
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
		if (this[kNamespace] === HTML_NAMESPACE && isHTMLDocument(this[kDocument])) {
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
		if (this[kNamespace] === HTML_NAMESPACE && isHTMLDocument(this[kDocument])) {
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
		if (this[kNamespace] === HTML_NAMESPACE && isHTMLDocument(this[kDocument])) {
			name = asciiLowercase(name);
		}
		for (const attribute of this[kAttributeList]) {
			if (attribute[kQualifiedName] === name) return true;
		}
		return false;
	}

	hasAttributeNS(namespace: string | null, localName: string): boolean {
		return (
			getAttributeByNamespace(this, namespace, String(localName)) !== null
		);
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
		return serializeFragment(this);
	}

	set innerHTML(value: string) {
		const fragment = parseFragmentHTML(String(value ?? ""), this);
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
		const definition = this[kDefinition];
		if (definition !== null && definition.connectedCallback !== undefined) {
			enqueueReaction(() => definition.connectedCallback?.(this));
		}
	}

	override [kRemovingSteps](oldParent: Node): void {
		const root = getRoot(oldParent);
		if (root.nodeType === DOCUMENT_NODE) {
			removeFromIdMap(root as Document, this);
		}
		const definition = this[kDefinition];
		if (definition !== null && definition.disconnectedCallback !== undefined) {
			enqueueReaction(() => definition.disconnectedCallback?.(this));
		}
	}

	override [kAdoptingSteps](oldDocument: Document): void {
		const definition = this[kDefinition];
		if (definition !== null && definition.adoptedCallback !== undefined) {
			const to = this[kDocument];
			enqueueReaction(() => definition.adoptedCallback?.(this, oldDocument, to));
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
		const definition = this[kDefinition];
		if (
			definition !== null &&
			definition.attributeChangedCallback !== undefined &&
			definition.observedAttributes.has(localName)
		) {
			enqueueReaction(() =>
				definition.attributeChangedCallback?.(
					this,
					localName,
					oldValue,
					value,
					namespace,
				),
			);
		}
	}

	override [kCloneSingle](document: Document): Node {
		const copy = createElementInternal(
			document,
			this[kLocalName],
			this[kNamespace],
			this[kPrefix],
			this[kIsValue],
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

export class HTMLElement extends Element {}

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

/**
 * A custom element reaction.
 *
 * The reaction queue and the backup element queue belong to the event loop,
 * which is a later phase; a reaction here runs where the spec enqueues it.
 */
function enqueueReaction(reaction: () => void): void {
	try {
		reaction();
	} catch (error) {
		reportError(error);
	}
}

/** The spec's "create an element" algorithm. */
function createElementInternal(
	document: Document,
	localName: string,
	namespace: string | null,
	prefix: string | null = null,
	is: string | null = null,
): Element {
	const definition = builtinRegistry.lookup(namespace, localName, is);
	let constructor: new () => Element;
	if (definition !== null) {
		constructor = definition.constructor;
	} else if (namespace === HTML_NAMESPACE) {
		constructor =
			HTML_KNOWN_NAMES.has(localName) || HTML_ELEMENT_NAMES.has(localName)
				? HTMLElement
				: isValidCustomElementName(localName)
					? HTMLElement
					: HTMLUnknownElement;
	} else if (namespace === SVG_NAMESPACE) {
		constructor = SVGElement;
	} else if (namespace === MATHML_NAMESPACE) {
		constructor = MathMLElement;
	} else {
		constructor = Element;
	}
	const previous = currentDocumentForConstruction;
	currentDocumentForConstruction = document;
	let element: Element;
	try {
		element = new constructor();
	} finally {
		currentDocumentForConstruction = previous;
	}
	element[kDocument] = document;
	element[kNamespace] = namespace;
	element[kPrefix] = prefix;
	element[kLocalName] = localName;
	element[kIsValue] = is;
	element[kDefinition] = definition;
	element[kCustomState] =
		definition !== null && definition.custom
			? "custom"
			: namespace === HTML_NAMESPACE && isValidCustomElementName(localName)
				? "undefined"
				: "uncustomized";
	return element;
}

const CUSTOM_NAME_RE = /^[a-z][-._0-9a-z·À-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]*-[-._0-9a-z·À-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]*$/;
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

function isValidCustomElementName(name: string): boolean {
	return CUSTOM_NAME_RE.test(name) && !RESERVED_CUSTOM_NAMES.has(name);
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
const kTemplateContent = Symbol("template content");

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
			throw new TypeError("createProcessingInstruction needs a target and data");
		}
		const name = String(target);
		validateElementLocalName(name);
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
		return cloneNode(node, this, Boolean(deep));
	}

	adoptNode(node: Node): Node {
		if (!(node instanceof Node)) throw new TypeError("That is not a node");
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be adopted");
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

	createEvent(interfaceName: string): Event {
		const name = asciiLowercase(String(interfaceName));
		if (name === "customevent") return new CustomEvent("");
		if (name === "event" || name === "events" || name === "htmlevents") {
			return new Event("");
		}
		throw domError(
			"NotSupportedError",
			`No event interface is named "${interfaceName}"`,
		);
	}

	createNodeIterator(
		root: Node,
		whatToShow = 0xffffffff,
		filter: NodeFilterInput = null,
	): NodeIterator {
		if (!(root instanceof Node)) throw new TypeError("That is not a node");
		const iterator = new NodeIterator(root, toUnsignedLong(whatToShow), filter);
		const iterators = this[kNodeIterators];
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
		copy[kType] = this[kType];
		copy[kContentType] = this[kContentType];
		copy[kEncoding] = this[kEncoding];
		copy[kDocumentURL] = this[kDocumentURL];
		copy[kMode] = this[kMode];
		return copy;
	}
}

Object.defineProperty(Document.prototype, Symbol.toStringTag, {
	value: "Document",
	configurable: true,
});

export class XMLDocument extends Document {}

Object.defineProperty(XMLDocument.prototype, Symbol.toStringTag, {
	value: "XMLDocument",
	configurable: true,
});

function stripAndCollapseWhitespace(value: string): string {
	return value
		.replace(/[\t\n\f\r ]+/g, " ")
		.replace(/^ | $/g, "");
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
		const document = new XMLDocument();
		document[kType] = "xml";
		document[kContentType] = "application/xml";
		document[kDocumentURL] = this.#document[kDocumentURL];
		let element: Element | null = null;
		const name = qualifiedName == null ? "" : String(qualifiedName);
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
		return createHTMLDocument(
			title === undefined ? undefined : String(title),
			this.#document[kDocumentURL],
		);
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

function convertNodesIntoNode(
	nodes: Insertable[],
	document: Document,
): Node {
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
			ensurePreInsertionValidity(node, this, null);
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
function insertAdjacent(element: Element, where: string, node: Node): Node | null {
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
		if (
			attribute[kPrefix] === "xmlns" &&
			attribute[kValue] === namespace
		) {
			return attribute[kLocalName];
		}
	}
	const parent = element.parentElement;
	return parent === null ? null : locateNamespacePrefix(parent, namespace);
}

function locateNamespace(node: Node, prefix: string | null): string | null {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
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
			if (filterNode(state, node as Node) === FILTER_ACCEPT) break;
		}
		this.#reference = node as Node;
		this.#pointerBefore = before;
		return node;
	}

	/** The spec's NodeIterator pre-removing steps. */
	[kPreRemove](toBeRemoved: Node): void {
		if (
			!isInclusiveAncestor(toBeRemoved, this.#reference) ||
			toBeRemoved === this.#root
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
				if (parent === null || parent === this.#root || parent === this.#current) {
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
			(templateElement as unknown as Record<symbol, unknown>)[
				kTemplateContent
			] = contentElement;
		},
		getTemplateContent(templateElement: Element): DocumentFragment {
			return (templateElement as unknown as Record<symbol, DocumentFragment>)[
				kTemplateContent
			];
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
				const created = new Attr(
					namespace,
					prefix,
					localName,
					attribute.value,
				);
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

/** Parse an HTML document, per the HTML Standard's parsing algorithm. */
export function parseHTMLDocument(html: string, url = "about:blank"): Document {
	const adapter = treeAdapterFor(null);
	const document = parse5Parse(html, {
		treeAdapter: adapter as never,
	}) as unknown as Document;
	document[kDocumentURL] = url;
	return document;
}

/** The HTML fragment parsing algorithm, with a context element. */
function parseFragmentHTML(markup: string, context: Element): DocumentFragment {
	const document = context[kDocument];
	const adapter = treeAdapterFor(document);
	const parsed = parseFragment(context as never, markup, {
		treeAdapter: adapter as never,
	}) as unknown as DocumentFragment;
	const fragment = document.createDocumentFragment();
	for (const child of childNodeArray(parsed)) {
		insertNode(child, fragment, null, true);
	}
	return fragment;
}

export class DOMParser {
	parseFromString(string: string, type: string): Document {
		const contentType = String(type);
		if (contentType === "text/html") {
			return parseHTMLDocument(String(string));
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
		.replace(/ /g, "&nbsp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/ /g, "&nbsp;")
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

/** The HTML fragment serialization algorithm, over a node's children. */
function serializeFragment(node: Node): string {
	let children = node;
	if (
		node.nodeType === ELEMENT_NODE &&
		(node as Element)[kNamespace] === HTML_NAMESPACE &&
		(node as Element)[kLocalName] === "template"
	) {
		const content = (node as unknown as Record<symbol, Node | undefined>)[
			kTemplateContent
		];
		if (content !== undefined) children = content;
	}
	let html = "";
	for (
		let child = children[kFirstChild];
		child !== null;
		child = child[kNext]
	) {
		html += serializeNode(child);
	}
	return html;
}

function serializeOuterHTML(element: Element): string {
	return serializeNode(element);
}

function serializeNode(node: Node): string {
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
			html += serializeFragment(element);
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
			for (let child = node[kFirstChild]; child !== null; child = child[kNext]) {
				html += serializeNode(child);
			}
			return html;
		}
	}
}

