/**
 * The internal slots of the objects a page can reach.
 *
 * A browser keeps a node's parent, an event's target and the rest in
 * internal slots that script cannot see: `Reflect.ownKeys(element)` is
 * empty, spreading an element copies nothing, and a Proxy around one
 * fails every call with "Illegal invocation". Each such object here keeps
 * its state in one record, held in a private field, which a Proxy does
 * not forward and reflection does not list. The engine reads the record
 * through `$()`.
 *
 * The record's prototype mirrors the object's class chain. The internal
 * steps and defaults a class defines under symbol keys move there from
 * the public prototype, and run with the record as `this`, so a step
 * reads its own slots without a lookup. `ownerOf()` gives it the object.
 */

const kObject = Symbol("object");

/**
 * A record as the tree links hold it: the symbol-keyed slots of `T`, and
 * the object they belong to, which `objectOf()` returns. Unlike what `$()`
 * returns, it cannot be mistaken for the object itself.
 */
export type Slots<T> =
	{
		[K in keyof T as K extends symbol ? K : never]: T[K];
	} & {readonly [kObject]: T};

type SlotRecord = Record<symbol, unknown> & {[kObject]: object};
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Constructor = Function & {prototype: object};

class Stamp {
	constructor(target: object) {
		return target;
	}
}

class Slot extends Stamp {
	// A private field is the one place a Proxy cannot reach and reflection
	// cannot list, which is how the DOM's internal slots behave.
	// eslint-disable-next-line @b9g/no-private-fields
	#record: SlotRecord;

	constructor(target: object, record: SlotRecord) {
		super(target);
		this.#record = record;
	}

	static has(value: object): boolean {
		return #record in value;
	}

	static read(value: object): SlotRecord {
		try {
			return (value as Slot).#record;
		} catch (error) {
			throw new TypeError("Illegal invocation", {cause: error});
		}
	}
}

const WELL_KNOWN_SYMBOLS = new Set<symbol>(
	Object.getOwnPropertyNames(Symbol)
		.map((name) => (Symbol as unknown as Record<string, unknown>)[name])
		.filter((value): value is symbol => typeof value === "symbol"),
);

const hiddenPrototypes = new Map<Constructor, object>();
const roots = new Map<Constructor, Constructor>();
const superSteps = new Map<
	Constructor,
	Map<symbol, (this: object, ...args: unknown[]) => unknown>
>();
const recordTypes = new Map<Constructor, new () => SlotRecord>();
const recordTypesByPrototype = new Map<object, new () => SlotRecord>();
// The two objects looked up last, since the engine often goes back and
// forth between two, such as an element and its computed style.
let lastValue: object | null = null;
let lastRecord: SlotRecord | null = null;
let priorValue: object | null = null;
let priorRecord: SlotRecord | null = null;

/**
 * Gives a newly constructed object its slots. The root class of each
 * public hierarchy calls this first in its constructor, before any state
 * is written.
 */
export function seal(
	target: object,
	type: Constructor,
	root: Constructor,
): void {
	let Record = recordTypes.get(type);
	if (Record === undefined) {
		const hidden = hiddenPrototype(type, root);
		Record = recordTypesByPrototype.get(hidden);
		if (Record === undefined) {
			Record = createRecordType(hidden);
			recordTypesByPrototype.set(hidden, Record);
		}

		recordTypes.set(type, Record);
	}

	const record = new Record();
	record[kObject] = target;
	new Slot(target, record);
}

// Records made by a constructor keep their fields in the object, where
// ones from Object.create() spill all but a few into a separate store.
function createRecordType(hidden: object): new () => SlotRecord {
	function SlotRecord(): void {}

	SlotRecord.prototype = hidden;
	return SlotRecord as unknown as new () => SlotRecord;
}

/**
 * The internal slots of a public object, typed as the object so the
 * slots its class declares type-check. Throws "Illegal invocation" for
 * anything without slots, a Proxy around a node among them, as a browser
 * does.
 */
export function $<T extends object>(
	value: T & {readonly [kObject]?: never},
): T {
	if (value === lastValue) {
		return lastRecord as unknown as T;
	}

	if (value === priorValue) {
		return priorRecord as unknown as T;
	}

	const record = Slot.read(value);
	remember(value, record);
	return record as unknown as T;
}

// A remembered record holds its object, and through its links a whole
// tree, so the cache empties at the end of every task. A tree removed in
// the task is then free to go.
let forgetting = false;

function forget(): void {
	forgetting = false;
	lastValue = null;
	lastRecord = null;
	priorValue = null;
	priorRecord = null;
}

function remember(value: object, record: SlotRecord): void {
	if (!forgetting) {
		forgetting = true;
		queueMicrotask(forget);
	}

	if (value !== lastValue) {
		priorValue = lastValue;
		priorRecord = lastRecord;
		lastValue = value;
		lastRecord = record;
	}
}

/** The record of `value`, typed as the tree links hold it. */
export function slotsOf<T extends object>(
	value: T & {readonly [kObject]?: never},
): Slots<T> {
	return $(value) as unknown as Slots<T>;
}

/**
 * The object a record belongs to.
 */
export function objectOf<T extends object>(record: Slots<T>): T;
export function objectOf<T extends object>(record: Slots<T> | null): T | null;
export function objectOf<T extends object>(record: Slots<T> | null): T | null {
	return record === null ? null : record[kObject];
}

/**
 * The object a record belongs to, remembered as the last lookup, for a
 * walk that hands the object on to code that reads its slots.
 */
export function rememberObject<T extends object>(record: Slots<T>): T;
export function rememberObject<T extends object>(
	record: Slots<T> | null,
): T | null;
export function rememberObject<T extends object>(
	record: Slots<T> | null,
): T | null {
	if (record === null) {
		return null;
	}

	const object = record[kObject];
	remember(object, record as unknown as SlotRecord);
	return object;
}

/** `$()` for an optional chain: undefined for null or undefined. */
export function $maybe<T>(value: T): NonNullable<T> | undefined {
	return value == null ? undefined : ($(value as object) as NonNullable<T>);
}

/**
 * Gives slots to an object the runtime made, such as a platform event
 * dispatched into the document, which no constructor here sealed.
 */
export function adopt(target: object, state: Record<symbol, unknown>): void {
	const record = Object.assign(Object.create(null), state) as SlotRecord;
	record[kObject] = target;
	new Slot(target, record);
}

/**
 * The object a record belongs to, for an internal step, which runs with
 * the record as `this`, to hand the object on.
 */
export function ownerOf<T extends object>(record: T): T {
	return (record as unknown as SlotRecord)[kObject] as T;
}

/** Whether `value` has slots. */
export function isSealed(value: object): boolean {
	return Slot.has(value);
}

/**
 * The internal step `key` as the parent of `type` defines it, for the
 * `super` call of a class that overrides it. Call it with the record as
 * `this`.
 */
export function superStep(
	type: Constructor,
	key: symbol,
): (this: object, ...args: unknown[]) => unknown {
	let steps = superSteps.get(type);
	if (steps === undefined) {
		steps = new Map();
		superSteps.set(type, steps);
	}

	let step = steps.get(key);
	if (step === undefined) {
		step = hiddenMember(Object.getPrototypeOf(type) as Constructor, key);
		steps.set(key, step);
	}

	return step;
}

/** The internal step `key` as `type` defines or inherits it. */
export function hiddenMember(
	type: Constructor,
	key: symbol,
): (this: object, ...args: unknown[]) => unknown {
	const hidden = hiddenPrototype(type, roots.get(type) ?? type);
	const member = (hidden as Record<symbol, unknown>)[key];
	return member as (this: object, ...args: unknown[]) => unknown;
}

/**
 * Moves the symbol-keyed members a module added to public prototypes
 * after their classes were first constructed. Called once the modules
 * have loaded.
 */
export function moveLateMembers(): void {
	for (const [type, hidden] of hiddenPrototypes) {
		if (
			hasMovableMembers(type.prototype) &&
			hidden === hiddenPrototypes.get(Object.getPrototypeOf(type))
		) {
			throw new Error(
				`${type.name} gained internal steps after its records were made`,
			);
		}

		moveMembers(type.prototype, hidden);
	}
}

function hiddenPrototype(type: Constructor, root: Constructor): object {
	let hidden = hiddenPrototypes.get(type);
	if (hidden === undefined) {
		const parent = type === root
			? null
			: hiddenPrototype(Object.getPrototypeOf(type) as Constructor, root);
		// A class that defines no internal steps of its own shares its
		// parent's, so the records of a div and a span share a shape and a
		// read of either stays fast.
		hidden = parent !== null && !hasMovableMembers(type.prototype)
			? parent
			: (Object.create(parent) as object);
		hiddenPrototypes.set(type, hidden);
		roots.set(type, root);
		moveMembers(type.prototype, hidden);
	}

	return hidden;
}

function isMovable(key: symbol): boolean {
	return !WELL_KNOWN_SYMBOLS.has(key) && Symbol.keyFor(key) === undefined;
}

function hasMovableMembers(prototype: object): boolean {
	return Object.getOwnPropertySymbols(prototype).some(isMovable);
}

function moveMembers(prototype: object, hidden: object): void {
	for (const key of Object.getOwnPropertySymbols(prototype)) {
		if (!isMovable(key)) {
			continue;
		}

		const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
		Object.defineProperty(hidden, key, descriptor);
		delete (prototype as Record<symbol, unknown>)[key];
	}
}
