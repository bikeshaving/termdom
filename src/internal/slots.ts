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
 * steps and defaults a class defines under names that start with "_"
 * move there from the public prototype, and run with the record as `this`, so a step
 * reads its own slots without a lookup. `getOwner()` gives it the object.
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
// The class whose constructor made the object.
const kType = Symbol("type");

/**
 * The key a class's merged interface names its internals type under, for
 * _() to return. It exists only in types, and nothing holds it at runtime.
 */
export declare const internals: unique symbol;
const kSteps = Symbol("steps");

/**
 * A record: the internals its class names, and the object they belong to,
 * which `getObject()` returns. It cannot be mistaken for the object itself.
 */
export type Slots<T extends {readonly [internals]: object}> =
	T[typeof internals] & {readonly [kObject]: T};

/**
 * An internal step as a record lists it: called on the record, so without
 * the `this` its body declares.
 */
export type Step<T> = T extends (...args: infer A) => infer R
	? (...args: A) => R
	: T;

type SlotRecord = Record<string | symbol, unknown> & {[kObject]: object};
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

	// The record of an object, or null when it has none.
	static find(value: object): SlotRecord | null {
		return #record in value ? (value as Slot).#record : null;
	}

	static read(value: object): SlotRecord {
		if (
			(typeof value !== "object" && typeof value !== "function") ||
			value === null ||
			!(#record in value)
		) {
			throw new TypeError("Illegal invocation");
		}

		return (value as Slot).#record;
	}
}

const hiddenPrototypes = new WeakMap<Constructor, object>();
// The classes given a hidden prototype or a family plan before the modules
// finished loading, which moveLateMembers() visits once. Every later class
// is in the weak maps alone, so a page's class, and a frame's realm with
// it, can be collected.
const earlyHiddenTypes: Constructor[] = [];
const earlyPlanTypes: Constructor[] = [];
let lateMembersMoved = false;
const roots = new WeakMap<Constructor, Constructor>();
const superSteps = new Map<
	Constructor,
	Map<string, (this: object, ...args: unknown[]) => unknown>
>();
const recordTypes = new WeakMap<Constructor, new () => SlotRecord>();

interface Family {
	prototype: object;
	Record: new (
		object: object,
		type: Constructor,
		steps: object,
		extra: object | null,
	) => SlotRecord;
	dispatched: Set<string>;
}

interface FamilyPlan {
	Record: Family["Record"];
	steps: object;
	Extra: (new () => object) | null;
}

const sealedRoots = new WeakSet<Constructor>();
// The function a page constructs a class through, and the class.
const interfaceObjects = new WeakMap<Constructor, Constructor>();
let sealedHook: ((target: object, type: Constructor) => void) | null = null;
const sealedParents = new WeakMap<Constructor, Constructor>();
const familyRoots = new WeakSet<Constructor>();
const families = new WeakMap<Constructor, Family>();
const familyPlans = new WeakMap<Constructor, FamilyPlan | null>();
const extraTypes = new WeakSet<Constructor>();
let extraKey: string | symbol = Symbol("unused extra");
const recordTypesByPrototype = new WeakMap<object, new () => SlotRecord>();
// The two objects looked up most recently, newest first, since the
// engine often goes back and forth between two, such as an element and
// its computed style. Reading #record sees every element class's shape,
// which makes that read slow, and a comparison here skips it.
let newestObject: object | null = null;
let newestRecord: SlotRecord | null = null;
let olderObject: object | null = null;
let olderRecord: SlotRecord | null = null;

// The class the last object sealed came from, and what seal() found for
// it, since objects are often made many of one kind in a row.
let lastSealedConstructor: Constructor | null = null;
let lastSealedType: Constructor | null = null;
let lastSealedPlan: FamilyPlan | null = null;
// And the one before it, since kinds often alternate, as a span and its
// text do.
let priorSealedConstructor: Constructor | null = null;
let priorSealedType: Constructor | null = null;
let priorSealedPlan: FamilyPlan | null = null;

/**
 * Gives a newly constructed object its slots. The root class of each
 * public hierarchy calls this first in its constructor, before any state
 * is written.
 */
export function seal(
	target: object,
	constructor: Constructor,
	root: Constructor,
): void {
	let type: Constructor;
	let plan: FamilyPlan | null;
	if (constructor === lastSealedConstructor) {
		type = lastSealedType!;
		plan = lastSealedPlan;
	} else if (constructor === priorSealedConstructor) {
		type = priorSealedType!;
		plan = priorSealedPlan;
		priorSealedConstructor = lastSealedConstructor;
		priorSealedType = lastSealedType;
		priorSealedPlan = lastSealedPlan;
		lastSealedConstructor = constructor;
		lastSealedType = type;
		lastSealedPlan = plan;
	} else {
		type = interfaceObjects.get(constructor) ?? constructor;
		let found = familyPlans.get(type);
		if (found === undefined) {
			found = planFamilyRecord(type, root);
			familyPlans.set(type, found);
			if (!lateMembersMoved) {
				earlyPlanTypes.push(type);
			}
		}

		plan = found;

		priorSealedConstructor = lastSealedConstructor;
		priorSealedType = lastSealedType;
		priorSealedPlan = lastSealedPlan;
		lastSealedConstructor = constructor;
		lastSealedType = type;
		lastSealedPlan = plan;
	}

	if (plan !== null) {
		new Slot(
			target,
			new plan.Record(
				target,
				type,
				plan.steps,
				plan.Extra === null ? null : new plan.Extra(),
			),
		);
		sealedHook?.(target, type);
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
	record[kType] = type;
	new Slot(target, record);
	sealedHook?.(target, type);
}

/**
 * Makes `object` the function a page constructs `type` through, which
 * seal() and the class's descendants take as `type` itself.
 */
export function declareInterfaceObject(
	object: Constructor,
	type: Constructor,
): void {
	interfaceObjects.set(object, type);
	lastSealedConstructor = null;
	priorSealedConstructor = null;
}

/** Whether `value` is a function a page constructs a class through. */
export function isInterfaceObject(value: unknown): boolean {
	return interfaceObjects.has(value as Constructor);
}

/** Calls `hook` with each object sealed from now on, and its class. */
export function onSeal(
	hook: (target: object, type: Constructor) => void,
): void {
	sealedHook = hook;
}

/**
 * The class that made `value`, or null when it has no slots, as a
 * Proxy and an object a page made do not.
 */
export function getSlotClass(value: unknown): Constructor | null {
	if (value === newestObject) {
		return newestRecord![kType] as Constructor | null;
	}

	if (value === olderObject) {
		return olderRecord![kType] as Constructor | null;
	}

	if (
		(typeof value !== "object" && typeof value !== "function") || value === null
	) {
		return null;
	}

	const record = Slot.find(value);
	if (record === null) {
		return null;
	}

	remember(value, record);
	return record[kType] as Constructor | null;
}

// The classes each class takes its slots from, itself included.
const lineages = new WeakMap<Constructor, Set<Constructor>>();
// The class looked up last and its lineage, since the objects checked in
// a row are often made by one class, as a run of spans is.
let lastLineageType: Constructor | null = null;
let lastLineage: Set<Constructor> | null = null;
let priorLineageType: Constructor | null = null;
let priorLineage: Set<Constructor> | null = null;

/**
 * Empties the caches here that remember the last classes they saw. A
 * class a frame's page made holds the frame's whole realm, so they forget
 * when a frame goes.
 */
export function forgetRecentClasses(): void {
	lastSealedConstructor = null;
	lastSealedType = null;
	lastSealedPlan = null;
	priorSealedConstructor = null;
	priorSealedType = null;
	priorSealedPlan = null;
	lastLineageType = null;
	lastLineage = null;
	priorLineageType = null;
	priorLineage = null;
}

function getLineage(type: Constructor): Set<Constructor> {
	if (type === lastLineageType) {
		return lastLineage!;
	}
	if (type === priorLineageType) {
		const lineage = priorLineage!;
		priorLineageType = lastLineageType;
		priorLineage = lastLineage;
		lastLineageType = type;
		lastLineage = lineage;
		return lineage;
	}
	let lineage = lineages.get(type);
	if (lineage === undefined) {
		lineage = new Set();
		for (
			let current: unknown = type;
			typeof current === "function" && current !== Function.prototype;
			current = getParentClass(current as Constructor)
		) {
			lineage.add(current as Constructor);
		}
		lineages.set(type, lineage);
	}
	priorLineageType = lastLineageType;
	priorLineage = lastLineage;
	lastLineageType = type;
	lastLineage = lineage;
	return lineage;
}

/** Whether objects `type` makes implement `owner`'s interface. */
export function implementsInterface(
	type: Constructor,
	owner: Constructor,
): boolean {
	return getLineage(type).has(owner);
}

/**
 * Whether `value` is an object of `type`'s interface, as its slots say
 * rather than its prototype, which can be another realm's. A Proxy
 * around one is not, nor is an object a page gave its prototype.
 */
export function isPlatformObject<T extends object>(
	value: unknown,
	type: Constructor & {prototype: T},
): value is T {
	// Read past the cache of recent records without changing it: the
	// engine checks many objects in passing, and remembering each would
	// push out the ones it is working on.
	let record: SlotRecord | null;
	if (value === newestObject) {
		record = newestRecord;
	} else if (value === olderObject) {
		record = olderRecord;
	} else if (
		(typeof value !== "object" && typeof value !== "function") || value === null
	) {
		return false;
	} else {
		record = Slot.find(value);
	}
	const made = record?.[kType] as Constructor | null | undefined;
	return made != null && (made === type || getLineage(made).has(type));
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

/**
 * The class `type` takes its slots and steps from: the one it extends,
 * or the one declareSealedParent() named.
 */
export function getParentClass(type: Constructor): Constructor {
	const parent =
		sealedParents.get(type) ?? (Object.getPrototypeOf(type) as Constructor);
	return interfaceObjects.get(parent) ?? parent;
}

/**
 * Marks `root` as a class whose constructor seals what it makes, so
 * prepareClasses() can find the classes below it.
 */
export function declareSealedRoot(root: Constructor): void {
	sealedRoots.add(root);
}

/**
 * Defines `key` on the hidden prototype of `type`, where every record of
 * the class and the classes below it finds it and no page can.
 */
export function defineHiddenMember(
	type: Constructor,
	key: string | symbol,
	descriptor: PropertyDescriptor,
): void {
	Object.defineProperty(
		hiddenPrototype(type, getSealedRoot(type) ?? type),
		key,
		descriptor,
	);
}

/** Whether the objects `type` makes are sealed. */
export function isSealedClass(type: Constructor): boolean {
	return getSealedRoot(type) !== null;
}

// The sealed root at or above `type`, or null when it has none.
function getSealedRoot(type: Constructor): Constructor | null {
	for (
		let current: unknown = type;
		typeof current === "function";
		current = getParentClass(current as Constructor)
	) {
		if (sealedRoots.has(current as Constructor)) {
			return current as Constructor;
		}
	}

	return null;
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
		const root = getSealedRoot(type);
		if (root !== null && !familyPlans.has(type)) {
			const plan = planFamilyRecord(type, root);
			familyPlans.set(type, plan);
			if (!lateMembersMoved) {
				earlyPlanTypes.push(type);
			}
			lastSealedConstructor = null;
			priorSealedConstructor = null;
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
export function defineFamilies(
	extra: string | symbol,
	roots: Constructor[],
): void {
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
		current = getParentClass(current)
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
		let current = type;
		current !== familyRoot;
		current = getParentClass(current)
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
			type: Constructor,
			steps: object,
			extra: object | null,
		): void {
			this[kObject] = object;
			this[kType] = type;
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
	for (const key of internalKeys(hidden)) {
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
					const step = (this[kSteps] as Record<string, unknown>)[key] as
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
): Slots<T>;
export function _<T extends object>(
	value: T & {readonly [kObject]?: never},
): T;
export function _<T extends object>(
	value: T & {readonly [kObject]?: never},
): T {
	if (value === newestObject) {
		return newestRecord as unknown as T;
	}

	if (value === olderObject) {
		return olderRecord as unknown as T;
	}

	const record = Slot.read(value);
	remember(value, record);
	return record as unknown as T;
}

// A remembered record holds its object, and through its links a whole
// tree, so the cache empties at the next microtask checkpoint. A tree
// removed before then is free to go once it has.
let forgetting = false;

function forget(): void {
	forgetting = false;
	newestObject = null;
	newestRecord = null;
	olderObject = null;
	olderRecord = null;
}

function remember(value: object, record: SlotRecord): void {
	if (!forgetting) {
		forgetting = true;
		queueMicrotask(forget);
	}

	if (value !== newestObject) {
		olderObject = newestObject;
		olderRecord = newestRecord;
		newestObject = value;
		newestRecord = record;
	}
}

/** The record of `value`, typed as the tree links hold it. */
export function getSlots<T extends {readonly [internals]: object}>(
	value: T & {readonly [kObject]?: never},
): Slots<T> {
	return _(value) as unknown as Slots<T>;
}

/**
 * The object a record belongs to.
 */
export function getObject<T extends {readonly [internals]:
	object;}>(record: Slots<T>): T;
export function getObject<T extends {readonly [internals]:
	object;}>(record: Slots<T> |
	null): T | null;
export function getObject<T extends {readonly [internals]: object}>(
	record: Slots<T> | null,
): T | null {
	return record === null ? null : record[kObject];
}

/**
 * The object a record belongs to, remembered as the last lookup, for a
 * walk that hands the object on to code that reads its slots.
 */
export function rememberObject<T extends {readonly [internals]:
	object;}>(record: Slots<T>): T;
export function rememberObject<T extends {readonly [internals]: object}>(
	record: Slots<T> | null,
): T | null;
export function rememberObject<T extends {readonly [internals]: object}>(
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
export function _maybe<T extends {readonly [internals]: object}>(
	value: T | null | undefined,
): Slots<T> | undefined;
export function _maybe<T>(value: T): NonNullable<T> | undefined;
export function _maybe<T>(value: T): NonNullable<T> | undefined {
	return value == null ? undefined : (_(value as object) as NonNullable<T>);
}

/**
 * Gives slots to a plain object the engine made, such as the view a
 * pseudo-element's style is measured through, which no constructor here
 * sealed.
 */
export function adopt(
	target: object,
	state: Record<string | symbol, unknown>,
): void {
	const record = Object.assign(Object.create(null), state) as SlotRecord;
	record[kObject] = target;
	record[kType] = null;
	new Slot(target, record);
}

/**
 * The object a record belongs to, for an internal step, which runs with
 * the record as `this`, to hand the object on.
 */
export function getOwner<T extends object>(record: {readonly [kObject]: T}): T {
	return record[kObject];
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
	key: string,
): (this: object, ...args: unknown[]) => unknown {
	let steps = superSteps.get(type);
	if (steps === undefined) {
		steps = new Map();
		superSteps.set(type, steps);
	}

	let step = steps.get(key);
	if (step === undefined) {
		step = hiddenMember(getParentClass(type), key);
		steps.set(key, step);
	}

	return step;
}

/** The internal step `key` as `type` defines or inherits it. */
function hiddenMember(
	type: Constructor,
	key: string,
): (this: object, ...args: unknown[]) => unknown {
	const hidden = hiddenPrototype(
		type,
		roots.get(type) ?? getSealedRoot(type) ?? type,
	);
	const member = (hidden as Record<string, unknown>)[key];
	return member as (this: object, ...args: unknown[]) => unknown;
}

/**
 * Moves the internal members a module added to public prototypes
 * after their classes were first constructed. Called once the modules
 * have loaded.
 */
export function moveLateMembers(): void {
	lateMembersMoved = true;
	for (const type of earlyHiddenTypes) {
		const hidden = hiddenPrototypes.get(type)!;
		if (
			hasMovableMembers(type.prototype) &&
			hidden === hiddenPrototypes.get(getParentClass(type))
		) {
			throw new Error(
				`${type.name} gained internal steps after its records were made`,
			);
		}

		moveMembers(type.prototype, hidden);
	}

	for (const type of earlyPlanTypes) {
		if (familyPlans.get(type) != null) {
			familyPlans.delete(type);
			lastSealedConstructor = null;
			priorSealedConstructor = null;
		}
	}
}

function hiddenPrototype(type: Constructor, root: Constructor): object {
	let hidden = hiddenPrototypes.get(type);
	if (hidden === undefined) {
		const parent = type === root
			? null
			: hiddenPrototype(getParentClass(type), root);
		// A class that defines no internal steps of its own shares its
		// parent's, so the records of a div and a span share a shape and a
		// read of either stays fast. A page's class has none: what it names
		// with "_" is its own, and stays where the page put it.
		const page = isPageClass(type, root);
		hidden = parent !== null && (page || !hasMovableMembers(type.prototype))
			? parent
			: (Object.create(parent) as object);
		hiddenPrototypes.set(type, hidden);
		if (!lateMembersMoved) {
			earlyHiddenTypes.push(type);
		}
		roots.set(type, root);
		if (!page) {
			moveMembers(type.prototype, hidden);
		}
	}

	return hidden;
}

// No Web IDL member's name starts with "_", so none of these is one a
// page should see.
// A page reaches the engine's classes through their interface objects,
// which none of the engine's own classes extends.
function isPageClass(type: Constructor, root: Constructor): boolean {
	for (let current = type; current !== root;) {
		const parent =
			sealedParents.get(current) ??
			(Object.getPrototypeOf(current) as Constructor);
		if (interfaceObjects.has(parent)) {
			return true;
		}
		if (typeof parent !== "function") {
			return false;
		}
		current = getParentClass(current);
	}
	return false;
}

function internalKeys(object: object): string[] {
	return Object.getOwnPropertyNames(object)
		.filter((key) => key.startsWith("_"));
}

function hasMovableMembers(prototype: object): boolean {
	return internalKeys(prototype).length > 0;
}

function moveMembers(prototype: object, hidden: object): void {
	for (const key of internalKeys(prototype)) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
		Object.defineProperty(hidden, key, descriptor);
		delete (prototype as Record<string, unknown>)[key];
	}
}
