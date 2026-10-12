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
 * the public prototype, wrapped so they still run with the object, not
 * the record, as `this`.
 */

const kOwner = Symbol("owner");

type SlotRecord = Record<symbol, unknown> & {[kOwner]: object};
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
const originals = new WeakMap<object, unknown>();
const recordTypes = new Map<Constructor, new () => SlotRecord>();
let lastValue: object | null = null;
let lastRecord: SlotRecord | null = null;

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
		Record = createRecordType(hiddenPrototype(type, root));
		recordTypes.set(type, Record);
	}

	const record = new Record();
	record[kOwner] = target;
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
export function $<T extends object>(value: T): T {
	if (value === lastValue) {
		return lastRecord as unknown as T;
	}

	lastRecord = Slot.read(value);
	lastValue = value;
	return lastRecord as unknown as T;
}

/** `$()` for an optional chain: undefined for null or undefined. */
export function $maybe<T>(value: T): NonNullable<T> | undefined {
	return value == null
		? undefined
		: (Slot.read(value) as unknown as NonNullable<T>);
}

/**
 * Gives slots to an object the runtime made, such as a platform event
 * dispatched into the document, which no constructor here sealed.
 */
export function adopt(target: object, state: Record<symbol, unknown>): void {
	const record = Object.assign(Object.create(null), state) as SlotRecord;
	record[kOwner] = target;
	new Slot(target, record);
}

/** Whether `value` has slots. */
export function isSealed(value: object): boolean {
	return Slot.has(value);
}

/** Whether `value` is an object of the interface `type` defines. */
export function implementsInterface(
	value: unknown,
	type: Constructor,
): boolean {
	if (
		(typeof value !== "object" && typeof value !== "function") ||
		value === null ||
		!Slot.has(value)
	) {
		return false;
	}

	const hidden = hiddenPrototypes.get(type);
	return hidden !== undefined &&
		Object.prototype.isPrototypeOf.call(hidden, Slot.read(value));
}

/**
 * The internal step `key` as the parent of `type` defines it, for the
 * `super` call of a class that overrides it. Call it with the object as
 * `this`.
 */
export function superStep(
	type: Constructor,
	key: symbol,
): (this: object, ...args: unknown[]) => unknown {
	return hiddenMember(Object.getPrototypeOf(type) as Constructor, key);
}

/** The internal step `key` as `type` defines or inherits it. */
export function hiddenMember(
	type: Constructor,
	key: symbol,
): (this: object, ...args: unknown[]) => unknown {
	const hidden = hiddenPrototype(type, roots.get(type) ?? type);
	const member = (hidden as Record<symbol, unknown>)[key];
	return (originals.get(member as object) ?? member) as (
		this: object,
		...args: unknown[]
	) => unknown;
}

/**
 * Moves the symbol-keyed members a module added to public prototypes
 * after their classes were first constructed. Called once the modules
 * have loaded.
 */
export function moveLateMembers(): void {
	for (const [type, hidden] of hiddenPrototypes) {
		moveMembers(type.prototype, hidden);
	}
}

function hiddenPrototype(type: Constructor, root: Constructor): object {
	let hidden = hiddenPrototypes.get(type);
	if (hidden === undefined) {
		const parent = type === root
			? null
			: hiddenPrototype(Object.getPrototypeOf(type) as Constructor, root);
		hidden = Object.create(parent) as object;
		hiddenPrototypes.set(type, hidden);
		roots.set(type, root);
		moveMembers(type.prototype, hidden);
	}

	return hidden;
}

function moveMembers(prototype: object, hidden: object): void {
	for (const key of Object.getOwnPropertySymbols(prototype)) {
		if (WELL_KNOWN_SYMBOLS.has(key) || Symbol.keyFor(key) !== undefined) {
			continue;
		}

		const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
		if (typeof descriptor.value === "function") {
			const step = descriptor.value as (...args: unknown[]) => unknown;
			const wrapped = function (
				this: SlotRecord,
				a?: unknown,
				b?: unknown,
				c?: unknown,
				d?: unknown,
				e?: unknown,
				f?: unknown,
			): unknown {
				const owner = this[kOwner];
				switch (arguments.length) {
					case 0:
						return step.call(owner);
					case 1:
						return step.call(owner, a);
					case 2:
						return step.call(owner, a, b);
					case 3:
						return step.call(owner, a, b, c);
					case 4:
						return step.call(owner, a, b, c, d);
					default:
						return step.call(owner, a, b, c, d, e, f);
				}
			};
			originals.set(wrapped, step);
			descriptor.value = wrapped;
		} else {
			const {get, set} = descriptor;
			if (get !== undefined) {
				descriptor.get = function (this: SlotRecord): unknown {
					return get.call(this[kOwner]);
				};
			}

			if (set !== undefined) {
				descriptor.set = function (this: SlotRecord, value: unknown): void {
					set.call(this[kOwner], value);
				};
			}
		}

		Object.defineProperty(hidden, key, descriptor);
		delete (prototype as Record<symbol, unknown>)[key];
	}
}
