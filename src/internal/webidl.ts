/**
 * Web IDL's bindings for the window's interfaces, built from the table
 * scripts/generate-dom-idl.ts writes.
 *
 * Every attribute and operation lives on the interface the specs put it
 * on, and checks its `this` and its arguments before the engine sees
 * them, with the messages Chrome gives: a method called on the wrong
 * object throws "Illegal invocation", and a node where a string will do
 * becomes a string. A page constructs an interface through its
 * interface object, which throws "Illegal constructor" for one the specs
 * give no constructor, while the engine constructs the class itself.
 */

import {DOM_INTERFACES} from "../generated/domidl.ts";
import {
	declareInterfaceObject,
	isSealedClass,
	onSeal,
	parentOf,
	typeOf,
} from "./slots.ts";

export interface IdlInterface {
	parent?: string;
	constructible?: 1 | 2;
	constructorArguments?: string;
	global?: boolean;
	indexed?: boolean;
	iterable?: "value" | "pair" | "maplike" | "setlike";
	statics?: readonly string[];
	members: ReadonlyArray<readonly [string, string]>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Constructor = Function & {prototype: object};

interface Check {
	types: Constructor[];
	// The runtime's own classes of those names, whose objects the engine
	// takes too.
	runtimeTypes: Constructor[];
	// The classes it last took objects of.
	accepted: Constructor | null;
	acceptedBefore: Constructor | null;
	label: string;
	callback: boolean;
	nullable: boolean;
	stringifies: boolean;
}

interface Member {
	kind: "c" | "a" | "r" | "o";
	unforgeable: boolean;
	lenient: boolean;
	required: number;
	checks: Array<Check | null>;
	variadic: boolean;
}

function parseMember(
	text: string,
	classes: ReadonlyMap<string, Constructor>,
): Member {
	const [head, ...rest] = text.split(":");
	const kind = head[0] as Member["kind"];
	const flags = head.slice(1).replace(/\d+$/, "");
	const variadic = rest.at(-1)?.startsWith("...") ?? false;
	return {
		kind,
		unforgeable: flags.includes("u"),
		lenient: flags.includes("l"),
		required: kind === "o" ? Number(/\d+$/.exec(head)![0]) : 0,
		checks: rest.map((part) =>
			parseCheck(part.replace(/^\.\.\./, ""), classes),
		),
		variadic,
	};
}

function parseCheck(
	text: string,
	classes: ReadonlyMap<string, Constructor>,
): Check | null {
	if (text === "") {
		return null;
	}
	const nullable = text.endsWith("?");
	const stringifies = text.startsWith("~");
	const names = text.replace(/^~|\?$/g, "").split("|");
	if (names[0] === "Function") {
		return {
			types: [],
			runtimeTypes: [],
			accepted: null,
			acceptedBefore: null,
			label: "Function",
			callback: true,
			nullable,
			stringifies,
		};
	}
	const types = names.flatMap((name) => classes.get(name) ?? []);
	const runtimeTypes = names.flatMap((name) => {
		const runtime = (globalThis as Record<string, unknown>)[name];
		return typeof runtime === "function" && runtime !== classes.get(name)
			? [runtime as Constructor]
			: [];
	});
	if (types.length === 0 && runtimeTypes.length === 0 && !stringifies) {
		return null;
	}
	return {
		types,
		runtimeTypes,
		accepted: null,
		acceptedBefore: null,
		label: names[0],
		callback: false,
		nullable,
		stringifies,
	};
}

// The classes each class takes its slots from, itself included.
const lineages = new Map<Constructor, Set<Constructor>>();

/** Whether objects `type` makes implement `owner`'s interface. */
export function implementsInterface(
	type: Constructor,
	owner: Constructor,
): boolean {
	let lineage = lineages.get(type);
	if (lineage === undefined) {
		lineage = new Set();
		for (
			let current: unknown = type;
			typeof current === "function" && current !== Function.prototype;
			current = parentOf(current as Constructor)
		) {
			lineage.add(current as Constructor);
		}
		lineages.set(type, lineage);
	}
	return lineage.has(owner);
}

// Whether `value` is an object of one of the check's interfaces. One
// that only looks like ours, as a Proxy around ours does, is not; the
// runtime's own objects are.
function isInstance(value: unknown, check: Check): boolean {
	const type = typeOf(value);
	if (type !== null) {
		if (type === check.accepted || type === check.acceptedBefore) {
			return true;
		}
		for (const t of check.types) {
			if (implementsInterface(type, t)) {
				check.acceptedBefore = check.accepted;
				check.accepted = type;
				return true;
			}
		}
		return false;
	}
	return check.runtimeTypes.some((runtime) => value instanceof runtime) &&
		!check.types.some((t) => value instanceof t);
}

function arity(context: string, required: number, count: number): TypeError {
	return new TypeError(
		`Failed to ${context}: ${required} argument${
			required === 1 ? "" : "s"
		} required, but only ${count} present.`,
	);
}

// The arguments as the operation takes them: a callback that is a
// function, an object of the interface, or, where a string will do, a
// string. Null for a list that needs no conversion.
// One argument as the operation takes it: a callback that is a function,
// an object of the interface, or, where a string will do, a string.
function convertValue(
	value: unknown,
	check: Check,
	index: number,
	required: number,
	context: string,
): unknown {
	if (
		(value === undefined && index >= required) ||
		(check.nullable && value == null)
	) {
		return value;
	}
	if (check.callback) {
		if (typeof value !== "function") {
			throw new TypeError(
				`Failed to ${context}: parameter ${index + 1} is not of type 'Function'.`,
			);
		}
		return value;
	}
	if (isInstance(value, check)) {
		return value;
	}
	if (check.stringifies) {
		return (typeof value === "object" && value !== null) ||
			typeof value === "function"
			? String(value)
			: value;
	}
	throw new TypeError(
		`Failed to ${context}: parameter ${index + 1} is not of type '${check.label}'.`,
	);
}

// The arguments as the operation takes them, or null for a list that
// needs no conversion.
function convertArguments(
	args: ArrayLike<unknown>,
	member: Member,
	context: string,
): unknown[] | null {
	let converted: unknown[] | null = null;
	const {checks} = member;
	const last = checks.length - 1;
	for (let i = 0; i < args.length; i++) {
		const check = checks[member.variadic && i > last ? last : i];
		if (check == null) {
			continue;
		}
		const value = convertValue(args[i], check, i, member.required, context);
		if (value !== args[i]) {
			converted ??= Array.from(args);
			converted[i] = value;
		}
	}
	return converted;
}

/**
 * Finds the definition a call runs: enter() for the object and its class,
 * and leave() once the call returns. A definition that moved up from a
 * class calls the member again on the same object through `super`, and
 * that call runs the next definition up the class's chain.
 */
type Operation = (...args: unknown[]) => unknown;

// Whether a definition calls `super`, which a moved-up one reaches the
// binding through.
function callsSuper(descriptor: PropertyDescriptor): boolean {
	return [descriptor.value, descriptor.get, descriptor.set].some(
		(part) =>
			typeof part === "function" &&
		/\bsuper\b/.test(Function.prototype.toString.call(part)),
	);
}

interface Resolve {
	// The one definition every object runs, when no class moved its own up.
	fixed: PropertyDescriptor | undefined;
	// The definition an object of a class runs, when none that moved up
	// calls `super`, so a call needs no stack.
	direct: ((type: Constructor) => PropertyDescriptor | undefined) | undefined;
	enter(type: Constructor, object: unknown): PropertyDescriptor | undefined;
	leave(): void;
}

function wrapOperation(
	owner: Constructor,
	ownerName: string,
	name: string,
	member: Member,
	resolve: Resolve,
): (...args: unknown[]) => unknown {
	const context = `execute '${name}' on '${ownerName}'`;
	const {required, checks} = member;
	const fixed = resolve.fixed?.value as Operation | undefined;
	const direct = resolve.direct;
	let accepted: Constructor | null = null;
	let acceptedBefore: Constructor | null = null;
	const brand = (object: unknown): Constructor => {
		const type = typeOf(object);
		if (type === null) {
			throw new TypeError("Illegal invocation");
		}
		if (type !== accepted && type !== acceptedBefore) {
			if (!implementsInterface(type, owner)) {
				throw new TypeError("Illegal invocation");
			}
			acceptedBefore = accepted;
			accepted = type;
		}
		return type;
	};
	const run =
		(object: unknown, type: Constructor, args: ArrayLike<unknown>) => {
			const converted = convertArguments(args, member, context) ?? args;
			if (fixed !== undefined) {
				return Reflect.apply(fixed, object, converted);
			}
			if (direct !== undefined) {
				return Reflect.apply(
					direct(type)!.value as Operation,
					object,
					converted,
				);
			}
			const implementation = resolve.enter(type, object)!.value as Operation;
			try {
				return Reflect.apply(implementation, object, converted);
			} finally {
				resolve.leave();
			}
		};
	let wrapper: Operation;
	if (member.variadic || checks.length > 3) {
		wrapper = {
			[name](this: unknown): unknown {
				const type = brand(this);
				if (arguments.length < required) {
					throw arity(context, required, arguments.length);
				}
				// eslint-disable-next-line prefer-rest-params
				return run(this, type, arguments);
			},
		}[name];
	} else {
		// Three named parameters and the count, so a call makes no array.
		const [first, second, third] = checks;
		wrapper = {
			[name](this: unknown, a?: unknown, b?: unknown, c?: unknown): unknown {
				const type = brand(this);
				const count = arguments.length;
				if (count < required) {
					throw arity(context, required, count);
				}
				if (count > 0 && first != null) {
					a = convertValue(a, first, 0, required, context);
				}
				if (count > 1 && second != null) {
					b = convertValue(b, second, 1, required, context);
				}
				if (count > 2 && third != null) {
					c = convertValue(c, third, 2, required, context);
				}
				let implementation = fixed;
				if (implementation === undefined && direct !== undefined) {
					implementation = direct(type)!.value as Operation;
				}
				if (implementation === undefined || count > 3) {
					const args = [a, b, c].slice(0, count);
					for (let i = 3; i < count; i++) {
						// eslint-disable-next-line prefer-rest-params
						args.push(arguments[i]);
					}
					return implementation === undefined
						? run(this, type, args)
						: Reflect.apply(implementation, this, args);
				}
				switch (count) {
					case 0:
						return implementation.call(this);
					case 1:
						return implementation.call(this, a);
					case 2:
						return implementation.call(this, a, b);
					default:
						return implementation.call(this, a, b, c);
				}
			},
		}[name];
	}
	Object.defineProperty(wrapper, "length", {value: required});
	return wrapper;
}

function wrapAttribute(
	owner: Constructor,
	ownerName: string,
	name: string,
	member: Member,
	resolve: Resolve,
	settable: boolean,
): PropertyDescriptor {
	let accepted: Constructor | null = null;
	let acceptedBefore: Constructor | null = null;
	const brand = (object: unknown): Constructor | null => {
		const type = typeOf(object);
		if (type === null) {
			return null;
		}
		if (type !== accepted && type !== acceptedBefore) {
			if (!implementsInterface(type, owner)) {
				return null;
			}
			acceptedBefore = accepted;
			accepted = type;
		}
		return type;
	};
	const fixedGet = resolve.fixed?.get;
	const fixedSet = resolve.fixed?.set;
	const check = member.checks[0] ?? null;
	const get = {
		[name](this: unknown): unknown {
			const type = brand(this);
			if (type === null) {
				if (member.lenient) {
					return undefined;
				}
				throw new TypeError("Illegal invocation");
			}
			if (fixedGet !== undefined) {
				return fixedGet.call(this);
			}
			if (resolve.direct !== undefined) {
				return resolve.direct(type)!.get!.call(this);
			}
			const getter = resolve.enter(type, this)!.get!;
			try {
				return getter.call(this);
			} finally {
				resolve.leave();
			}
		},
	}[name];
	Object.defineProperty(get, "name", {value: `get ${name}`});
	const descriptor: PropertyDescriptor = {
		get,
		enumerable: true,
		configurable: true,
	};
	if (settable) {
		const set = {
			[name](this: unknown, value: unknown): void {
				const type = brand(this);
				if (type === null) {
					if (member.lenient) {
						return;
					}
					throw new TypeError("Illegal invocation");
				}
				if (
					check !== null &&
					!check.callback &&
					!(check.nullable && value == null) &&
					!isInstance(value, check)
				) {
					if (!check.stringifies) {
						throw new TypeError(
							`Failed to set the '${name}' property on '${ownerName}': The provided value is not of type '${check.label}'.`,
						);
					}
					if (typeof value === "object" && value !== null) {
						value = String(value);
					}
				}
				if (fixedSet !== undefined) {
					fixedSet.call(this, value);
					return;
				}
				if (resolve.direct !== undefined) {
					const direct = resolve.direct(type)?.set;
					if (direct !== undefined) {
						direct.call(this, value);
						return;
					}
				}
				const setter = resolve.enter(type, this)?.set;
				try {
					if (setter === undefined) {
						throw new TypeError(
							`Cannot set property ${name} of ${Object.prototype.toString.call(this)} which has only a getter`,
						);
					}
					setter.call(this, value);
				} finally {
					resolve.leave();
				}
			},
		}[name];
		Object.defineProperty(set, "name", {value: `set ${name}`});
		descriptor.set = set;
	}
	return descriptor;
}

// The classes a class takes its slots from, nearest first.
function *ancestors(type: Constructor): Generator<Constructor> {
	for (
		let current: unknown = parentOf(type);
		typeof current === "function" && current !== Function.prototype;
		current = parentOf(current as Constructor)
	) {
		yield current as Constructor;
	}
}

const interfaceObjects = new Map<string, Constructor>();
const interfaceNames = new Map<Constructor, string>();
const instanceMembers = new Map<
	Constructor,
	Array<[string, PropertyDescriptor]>
>();
const instanceMembersOfType = new Map<
	Constructor,
	Array<[string, PropertyDescriptor]> | null
>();
let installed = false;

/**
 * The name of the interface `value` was made as, the nearest one the
 * window exposes, or null for an object that is not the platform's.
 */
export function interfaceNameOf(value: unknown): string | null {
	const type = typeOf(value);
	if (type === null) {
		return null;
	}
	for (const current of [type, ...ancestors(type)]) {
		const name = interfaceNames.get(current);
		if (name !== undefined) {
			return name;
		}
	}
	return null;
}

/**
 * Lays out the prototypes of `classes`, the window's interfaces by name,
 * as Web IDL does, and returns the interface objects a page reaches them
 * through. The layout is the process's: later calls return the same.
 */
export function installInterfaces(
	classes: Readonly<Record<string, Constructor>>,
): ReadonlyMap<string, Constructor> {
	if (installed) {
		return interfaceObjects;
	}
	installed = true;

	const byName = new Map<string, Constructor>();
	for (const [name, type] of Object.entries(classes)) {
		if (
			DOM_INTERFACES[name] !== undefined &&
			typeof type === "function" &&
			isSealedClass(type)
		) {
			byName.set(name, type);
			interfaceNames.set(type, name);
		}
	}

	const members = new Map<string, Map<string, Member>>();
	const owners = new Map<string, Set<Constructor>>();
	for (const [name, type] of byName) {
		const parsed = new Map<string, Member>();
		for (const [key, text] of DOM_INTERFACES[name].members) {
			parsed.set(key, parseMember(text, byName));
			let set = owners.get(key);
			if (set === undefined) {
				set = new Set();
				owners.set(key, set);
			}
			set.add(type);
		}
		members.set(name, parsed);
	}

	const related = (a: Constructor, b: Constructor): boolean =>
		implementsInterface(a, b) || implementsInterface(b, a);

	// What each prototype defined, before any of it moves: the members its
	// interface has, and the ones the specs put on a relative of it, which
	// leave it.
	const originals = new Map<object, Map<string, PropertyDescriptor>>();
	const misplaced: Array<[Constructor, string]> = [];
	// The classes that define each misplaced member, by its name.
	const misplacedTypes = new Map<string, Constructor[]>();
	for (const [name, type] of byName) {
		const own = new Map<string, PropertyDescriptor>();
		originals.set(type.prototype, own);
		for (const key of Object.getOwnPropertyNames(type.prototype)) {
			if (key === "constructor") {
				continue;
			}
			const descriptor = Object.getOwnPropertyDescriptor(type.prototype, key)!;
			own.set(key, descriptor);
			const placed = owners.get(key);
			if (
				!members.get(name)!.has(key) &&
				placed !== undefined &&
				[...placed].some((owner) => related(type, owner))
			) {
				misplaced.push([type, key]);
				let types = misplacedTypes.get(key);
				if (types === undefined) {
					types = [];
					misplacedTypes.set(key, types);
				}
				types.push(type);
			}
		}
	}

	// The definition an object of `type` runs for `owner`'s `key`: a
	// descendant's that moved up into it, then the owner's own, then one
	// it inherits.
	function makeResolve(owner: Constructor, key: string): Resolve | null {
		let base: PropertyDescriptor | undefined = originals
			.get(owner.prototype)
			?.get(key);
		if (base === undefined) {
			for (const ancestor of ancestors(owner)) {
				base =
					originals.get(ancestor.prototype)?.get(key) ??
					Object.getOwnPropertyDescriptor(ancestor.prototype, key);
				if (base !== undefined) {
					break;
				}
			}
		}
		if (base === undefined) {
			for (
				let prototype = Object.getPrototypeOf(owner.prototype) as object | null;
				prototype !== null && base === undefined;
				prototype = Object.getPrototypeOf(prototype) as object | null
			) {
				base = Object.getOwnPropertyDescriptor(prototype, key);
			}
		}
		const overrides = new Map<Constructor, PropertyDescriptor>();
		for (const type of misplacedTypes.get(key) ?? []) {
			if (type !== owner && implementsInterface(type, owner)) {
				overrides.set(type, originals.get(type.prototype)!.get(key)!);
			}
		}
		if (base === undefined && overrides.size === 0) {
			return null;
		}
		if (overrides.size === 0) {
			return {fixed: base, direct: undefined, enter: () => base, leave() {}};
		}
		const chainFor = (type: Constructor) => {
			const chain: Array<PropertyDescriptor | undefined> = [];
			for (const current of [type, ...ancestors(type)]) {
				if (current === owner) {
					break;
				}
				const override = overrides.get(current);
				if (override !== undefined) {
					chain.push(override);
				}
			}
			chain.push(base);
			return chain;
		};
		if (![...overrides.values()].some(callsSuper)) {
			const firsts = new Map<Constructor, PropertyDescriptor | undefined>();
			let lastType: Constructor | null = null;
			let lastFirst: PropertyDescriptor | undefined;
			let priorType: Constructor | null = null;
			let priorFirst: PropertyDescriptor | undefined;
			const direct = (type: Constructor) => {
				if (type === lastType) {
					return lastFirst;
				}
				if (type === priorType) {
					return priorFirst;
				}
				if (!firsts.has(type)) {
					firsts.set(type, chainFor(type)[0]);
				}
				priorType = lastType;
				priorFirst = lastFirst;
				lastType = type;
				lastFirst = firsts.get(type);
				return lastFirst;
			};
			return {fixed: undefined, direct, enter: direct, leave() {}};
		}
		const chains =
			new Map<Constructor, Array<PropertyDescriptor | undefined>>();
		const objects: unknown[] = [];
		const depths: number[] = [];
		let calls = 0;
		let lastType: Constructor | null = null;
		let lastChain: Array<PropertyDescriptor | undefined> = [];
		return {
			fixed: undefined,
			direct: undefined,
			enter(type, object) {
				let chain = type === lastType ? lastChain : chains.get(type);
				if (chain === undefined) {
					chain = chainFor(type);
					chains.set(type, chain);
				}
				lastType = type;
				lastChain = chain;
				const depth = calls > 0 && objects[calls - 1] === object
					? Math.min(depths[calls - 1] + 1, chain.length - 1)
					: 0;
				objects[calls] = object;
				depths[calls] = depth;
				calls++;
				return chain[depth];
			},
			leave() {
				calls--;
				objects[calls] = undefined;
			},
		};
	}

	const wrapped = new Map<Constructor, Map<string, PropertyDescriptor>>();
	for (const [name, type] of byName) {
		const idl = DOM_INTERFACES[name];
		const own = new Map<string, PropertyDescriptor>();
		wrapped.set(type, own);
		const onInstance: Array<[string, PropertyDescriptor]> = [];
		for (const [key, member] of members.get(name)!) {
			if (member.kind === "c") {
				continue;
			}
			const resolve = makeResolve(type, key);
			const onObject = member.unforgeable || idl.global === true;
			if (
				resolve === null || (onObject && ![type, ...ancestors(type)].some((t) =>
					originals.get(t.prototype)?.has(key)))
			) {
				continue;
			}
			const sample = resolve.enter(type, null);
			resolve.leave();
			let descriptor: PropertyDescriptor;
			if (member.kind === "o") {
				if (sample !== undefined && typeof sample.value !== "function") {
					continue;
				}
				descriptor = {
					value: wrapOperation(type, name, key, member, resolve),
					writable: true,
					enumerable: true,
					configurable: true,
				};
			} else {
				if (sample !== undefined && sample.get === undefined) {
					continue;
				}
				descriptor = wrapAttribute(
					type,
					name,
					key,
					member,
					resolve,
					member.kind === "a" || sample?.set !== undefined,
				);
			}
			own.set(key, descriptor);
			if (onObject) {
				onInstance.push([
					key,
					{...descriptor, configurable: !member.unforgeable},
				]);
				delete (type.prototype as Record<string, unknown>)[key];
			} else {
				Object.defineProperty(type.prototype, key, descriptor);
			}
		}
		if (onInstance.length > 0) {
			instanceMembers.set(type, onInstance);
		}
	}

	// A member that moved is gone from where it was, unless the prototype
	// does not inherit from where it went, as an event class that extends
	// the runtime's does not; there it is the moved member itself.
	for (const [type, key] of misplaced) {
		let replacement: PropertyDescriptor | undefined;
		let reachable = false;
		for (const owner of owners.get(key)!) {
			if (!implementsInterface(type, owner)) {
				continue;
			}
			replacement ??= wrapped.get(owner)?.get(key);
			reachable ||= Object.prototype.isPrototypeOf.call(
				owner.prototype,
				type.prototype,
			);
		}
		if (!Object.getOwnPropertyDescriptor(type.prototype, key)!.configurable) {
			continue;
		}
		if (reachable) {
			delete (type.prototype as Record<string, unknown>)[key];
		} else if (replacement !== undefined) {
			Object.defineProperty(type.prototype, key, replacement);
		}
	}

	for (const [name, type] of byName) {
		const idl = DOM_INTERFACES[name];
		const prototype = type.prototype as Record<PropertyKey, unknown>;
		Object.defineProperty(prototype, Symbol.toStringTag, {
			value: name,
			configurable: true,
		});
		if (!Object.hasOwn(prototype, Symbol.iterator)) {
			const iterator = supportsIndexedProperties(name)
				? Array.prototype.values
				: idl.iterable === "pair" || idl.iterable === "maplike"
					? prototype.entries
					: idl.iterable === "setlike" ? prototype.values : undefined;
			if (typeof iterator === "function") {
				Object.defineProperty(prototype, Symbol.iterator, {
					value: iterator,
					writable: true,
					configurable: true,
				});
			}
		}
	}

	for (const [name, type] of byName) {
		interfaceObjects.set(name, createInterfaceObject(name, type, byName));
	}
	for (const [name, type] of byName) {
		const parent = DOM_INTERFACES[name].parent;
		const parentObject = parent === undefined
			? undefined
			: interfaceObjects.get(parent);
		Object.setPrototypeOf(
			interfaceObjects.get(name)!,
			parentObject ?? Function.prototype,
		);
		Object.defineProperty(type.prototype, "constructor", {
			value: interfaceObjects.get(name),
			writable: true,
			configurable: true,
		});
	}

	onSeal(defineInstanceMembers);
	return interfaceObjects;
}

// Every window wraps the same operations, so each is parsed once.
const windowOperations = new Map<string, Member | null>();

function getWindowOperation(name: string): Member | null {
	let member = windowOperations.get(name);
	if (member === undefined) {
		const text = DOM_INTERFACES.Window?.members.find(([key]) => key === name);
		if (text === undefined || !text[1].startsWith("o")) {
			member = null;
		} else {
			const classes = new Map<string, Constructor>();
			for (const [type, interfaceName] of interfaceNames) {
				classes.set(interfaceName, type);
			}
			member = parseMember(text[1], classes);
		}
		windowOperations.set(name, member);
	}
	return member;
}

/**
 * `implementation` as the member `name` of `window`, with the checks
 * Window's operation of that name makes. Called without an object, as a
 * function a page took off the window is, it runs on the window.
 */
export function windowMember(
	window: object,
	name: string,
	implementation: (...args: never[]) => unknown,
): (...args: unknown[]) => unknown {
	const member = getWindowOperation(name);
	if (member === null) {
		return implementation as (...args: unknown[]) => unknown;
	}
	const wrapper = {
		[name](this: unknown, ...args: unknown[]): unknown {
			if (this != null && this !== window) {
				throw new TypeError("Illegal invocation");
			}
			const context = `execute '${name}' on 'Window'`;
			if (args.length < member.required) {
				throw arity(context, member.required, args.length);
			}
			const converted = convertArguments(args, member, context);
			return Reflect.apply(implementation, window, converted ?? args);
		},
	}[name];
	Object.defineProperty(wrapper, "length", {value: member.required});
	return wrapper;
}

function supportsIndexedProperties(name: string): boolean {
	for (
		let current: string | undefined = name;
		current !== undefined;
		current = DOM_INTERFACES[current]?.parent
	) {
		if (DOM_INTERFACES[current]?.indexed) {
			return true;
		}
	}
	return false;
}

// The function a page reaches `type` through. Construction passes to the
// class, unless the specs give the interface no constructor.
function createInterfaceObject(
	name: string,
	type: Constructor,
	classes: ReadonlyMap<string, Constructor>,
): Constructor {
	const idl = DOM_INTERFACES[name];
	const signature = parseMember(idl.constructorArguments ?? "o0", classes);
	const object = function (this: unknown, ...args: unknown[]): unknown {
		if (new.target === undefined) {
			throw new TypeError(
				`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`,
			);
		}
		if (
			idl.constructible === undefined ||
			(idl.constructible === 2 && new.target === object)
		) {
			throw new TypeError(`Failed to construct '${name}': Illegal constructor`);
		}
		const context = `construct '${name}'`;
		if (args.length < signature.required) {
			throw arity(context, signature.required, args.length);
		}
		return Reflect.construct(
			type,
			convertArguments(args, signature, context) ?? args,
			new.target,
		);
	} as unknown as Constructor;
	Object.defineProperty(object, "name", {value: name});
	for (const key of Reflect.ownKeys(type)) {
		if (key !== "prototype" && key !== "name") {
			Object.defineProperty(
				object,
				key,
				Object.getOwnPropertyDescriptor(type, key)!,
			);
		}
	}
	Object.defineProperty(object, "prototype", {value: type.prototype});
	Object.defineProperty(object, "length", {
		value: signature.required,
		configurable: true,
	});
	declareInterfaceObject(object, type);
	return object;
}

// The unforgeable members, and a global's, belong to each object.
let lastSealedType: Constructor | null = null;
let lastSealedMembers: Array<[string, PropertyDescriptor]> | null = null;

function defineInstanceMembers(target: object, type: Constructor): void {
	if (type === lastSealedType && lastSealedMembers === null) {
		return;
	}
	let list = instanceMembersOfType.get(type);
	if (list === undefined) {
		const found: Array<[string, PropertyDescriptor]> = [];
		for (const current of [type, ...ancestors(type)]) {
			found.push(...instanceMembers.get(current) ?? []);
		}
		list = found.length === 0 ? null : found;
		instanceMembersOfType.set(type, list);
	}
	lastSealedType = type;
	lastSealedMembers = list;
	if (list !== null) {
		for (const [key, descriptor] of list) {
			Object.defineProperty(target, key, descriptor);
		}
	}
}
