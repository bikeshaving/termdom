/**
 * The internal slots of the objects a page can reach.
 *
 * A browser keeps a node's parent, an event's target and the rest in
 * internal slots that script cannot see: `Reflect.ownKeys(element)` is
 * empty, spreading an element copies nothing, and a Proxy around one
 * fails every call with "Illegal invocation". Each such object here keeps
 * its state in one record, held in a private field, which a Proxy does
 * not forward and reflection does not list. The engine reads the record
 * through `_()`.
 *
 * The record's prototype mirrors the object's class chain. The internal
 * steps and defaults a class defines under symbol keys move there from
 * the public prototype, and run with the record as `this`, so a step
 * reads its own slots without a lookup. `ownerOf()` gives it the object.
 *
 * A family, such as every element, makes its records one way instead:
 * one constructor and one prototype for all of them, and the slots its
 * root classes declare in one order, so every element's record has one
 * shape and a read of one stays fast however many kinds of element pass
 * through it. A class's own slots go in a second record, its extra, and
 * its steps in a table the record points to, which dispatchers on the
 * family's prototype call.
 */

const kObject = Symbol("object");

/**
 * The key a class's merged interface names its internals type under, for
 * _() to return. It exists only in types, and nothing holds it at runtime.
 */
export declare const internals: unique symbol;
const kSteps = Symbol("steps");

/**
 * A record as the tree links hold it: the symbol-keyed slots of `T`, and
 * the object they belong to, which `objectOf()` returns. Unlike what `_()`
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

interface Family {
	prototype: object;
	Record: new (object: object, steps: object, extra: object | null) =>
	SlotRecord;
	dispatched: Set<symbol>;
}

interface FamilyPlan {
	Record: Family["Record"];
	steps: object;
	Extra: (new () => object) | null;
}

const sealedRoots = new Set<Constructor>();
const sealedParents = new Map<Constructor, Constructor>();
const familyRoots = new Set<Constructor>();
const families = new Map<Constructor, Family>();
const familyPlans = new Map<Constructor, FamilyPlan | null>();
const extraTypes = new Set<Constructor>();
let extraKey = Symbol("unused extra");
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
	let plan = familyPlans.get(type);
	if (plan === undefined) {
		plan = planFamilyRecord(type, root);
		familyPlans.set(type, plan);
	}

	if (plan !== null) {
		new Slot(
			target,
			new plan.Record(
				target,
				plan.steps,
				plan.Extra === null ? null : new plan.Extra(),
			),
		);
		return;
	}

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

/**
 * Makes `parent` the class `type`'s slots and steps descend from, for a
 * class that extends some other constructor, such as the runtime's.
 */
export function declareSealedParent(
	type: Constructor,
	parent: Constructor,
): void {
	sealedParents.set(type, parent);
}

function parentOf(type: Constructor): Constructor {
	return sealedParents.get(type) ??
		(Object.getPrototypeOf(type) as Constructor);
}

/**
 * Marks `root` as a class whose constructor seals what it makes, so
 * prepareClasses() can find the classes below it.
 */
export function declareSealedRoot(root: Constructor): void {
	sealedRoots.add(root);
}

/**
 * Moves the steps of every sealed class among `values` off its public
 * prototype, where reflection would list them, before a page can look.
 * A class otherwise moves them when its first object is made.
 */
export function prepareClasses(values: Iterable<unknown>): void {
	for (const value of values) {
		if (typeof value !== "function") {
			continue;
		}

		const type = value as Constructor;
		let root: Constructor | null = null;
		for (
			let current: unknown = type;
			typeof current === "function" && root === null;
			current = parentOf(current as Constructor)
		) {
			if (sealedRoots.has(current as Constructor)) {
				root = current as Constructor;
			}
		}

		if (root !== null && !familyPlans.has(type)) {
			const plan = planFamilyRecord(type, root);
			familyPlans.set(type, plan);
			if (plan === null) {
				hiddenPrototype(type, root);
			}
		}
	}
}

/**
 * Makes each of `roots` the root of a family, whose records share one
 * shape. `extra` is the key a record keeps its class's own slots under.
 * Called before any object of a family is made.
 */
export function defineFamilies(extra: symbol, roots: Constructor[]): void {
	extraKey = extra;
	for (const root of roots) {
		if (hiddenPrototypes.has(root)) {
			throw new Error(`${root.name} made records before its family`);
		}

		familyRoots.add(root);
	}
}

/**
 * Marks `type` as declaring slots of its own, which its records keep in
 * their extra.
 */
export function declareExtraSlots(type: Constructor): void {
	extraTypes.add(type);
}

function planFamilyRecord(
	type: Constructor,
	root: Constructor,
): FamilyPlan | null {
	let familyRoot: Constructor | null = null;
	let extra = false;
	for (
		let current = type;
		current !== root && familyRoot === null;
		current = parentOf(current)
	) {
		if (familyRoots.has(current)) {
			familyRoot = current;
		} else if (extraTypes.has(current)) {
			extra = true;
		}
	}

	if (familyRoot === null && familyRoots.has(root)) {
		familyRoot = root;
	}

	if (familyRoot === null) {
		return null;
	}

	const family = getFamily(familyRoot, root);
	const steps = hiddenPrototype(type, root);
	for (
		let current = type; current !== familyRoot; current = parentOf(current)
	) {
		addDispatchers(family, hiddenPrototype(current, root));
	}

	return {
		Record: family.Record,
		steps,
		Extra: extra ? createExtraType() : null,
	};
}

function getFamily(familyRoot: Constructor, root: Constructor): Family {
	let family = families.get(familyRoot);
	if (family === undefined) {
		const prototype =
			Object.create(hiddenPrototype(familyRoot, root)) as object;
		const key = extraKey;

		function FamilyRecord(
			this: SlotRecord,
			object: object,
			steps: object,
			extra: object | null,
		): void {
			this[kObject] = object;
			this[kSteps] = steps;
			this[key] = extra;
		}

		FamilyRecord.prototype = prototype;
		family = {
			prototype,
			Record: FamilyRecord as unknown as Family["Record"],
			dispatched: new Set(),
		};
		families.set(familyRoot, family);
	}

	return family;
}

// A step a class below the family's root defines is found through the
// record's table, since the record's prototype is the family's.
function addDispatchers(family: Family, hidden: object): void {
	for (const key of Object.getOwnPropertySymbols(hidden)) {
		if (family.dispatched.has(key)) {
			continue;
		}

		family.dispatched.add(key);
		const descriptor = Object.getOwnPropertyDescriptor(hidden, key)!;
		if (descriptor.get !== undefined || descriptor.set !== undefined) {
			Object.defineProperty(family.prototype, key, {
				get(this: SlotRecord): unknown {
					return Reflect.get(this[kSteps] as object, key, this);
				},
				set(this: SlotRecord, value: unknown): void {
					Reflect.set(this[kSteps] as object, key, value, this);
				},
				configurable: true,
			});
		} else {
			Object.defineProperty(family.prototype, key, {
				value(this: SlotRecord, ...args: unknown[]): unknown {
					const step = (this[kSteps] as Record<symbol, unknown>)[key] as
						((...stepArgs: unknown[]) => unknown) | undefined;
					return step === undefined ? undefined : step.apply(this, args);
				},
				configurable: true,
				writable: true,
			});
		}
	}
}

function createExtraType(): new () => object {
	function Extra(): void {}

	Extra.prototype = Object.create(null) as object;
	return Extra as unknown as new () => object;
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
export function _<T extends {readonly [internals]: object}>(
	value: T & {readonly [kObject]?: never},
): T[typeof internals];
export function _<T extends object>(
	value: T & {readonly [kObject]?: never},
): T;
export function _<T extends object>(
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
	return _(value) as unknown as Slots<T>;
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

/** `_()` for an optional chain: undefined for null or undefined. */
export function _maybe<T>(value: T): NonNullable<T> | undefined {
	return value == null ? undefined : (_(value as object) as NonNullable<T>);
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
		step = hiddenMember(parentOf(type), key);
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
			hidden === hiddenPrototypes.get(parentOf(type))
		) {
			throw new Error(
				`${type.name} gained internal steps after its records were made`,
			);
		}

		moveMembers(type.prototype, hidden);
	}

	for (const [type, plan] of familyPlans) {
		if (plan !== null) {
			familyPlans.delete(type);
		}
	}
}

function hiddenPrototype(type: Constructor, root: Constructor): object {
	let hidden = hiddenPrototypes.get(type);
	if (hidden === undefined) {
		const parent = type === root ? null : hiddenPrototype(parentOf(type), root);
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
