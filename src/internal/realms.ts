/**
 * Realms for frames. A browser gives each frame a JavaScript realm of
 * its own: its own Object, Array and Function, and its own copy of every
 * interface, so an array or a node from a frame is not `instanceof` the
 * parent's. node:vm makes such a realm in Node, Bun and Deno. Where there
 * is none, as in a browser running TermDOM, a frame shares the parent's.
 */
import {aliasSlots} from "./slots.ts";
import {
	type Constructor,
	installRealmInterfaces,
	type Realm,
	registerRealm,
	runInRealm,
} from "./webidl.ts";

// The constructors a structured clone can make values of.
const TYPED_ARRAYS = [
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
];
const ERRORS = [
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
];
const INTRINSICS = [
	"Object",
	"Array",
	"Map",
	"Set",
	"Date",
	"RegExp",
	"Boolean",
	"Number",
	"String",
	"ArrayBuffer",
	"DataView",
	...TYPED_ARRAYS,
	...ERRORS,
];

interface VM {
	createContext(sandbox?: object): object;
	isContext(object: object): boolean;
	compileFunction(
		code: string,
		params: string[],
		options: {
			parsingContext: object;
			contextExtensions: object[];
			filename?: string;
		},
	): (...args: unknown[]) => unknown;
	runInContext(
		code: string,
		context: object,
		options?: {filename?: string},
	): unknown;
}

let vm: VM | null | undefined;

function getVM(): VM | null {
	if (vm === undefined) {
		// A browser has no process, and an older runtime no getBuiltinModule.
		const {process} =
			globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}};
		vm = process !== undefined && typeof process.getBuiltinModule === "function"
			? (process.getBuiltinModule("node:vm") as VM | undefined) ?? null
			: null;
	}
	return vm;
}

/**
 * Runs a classic script with `window` as its global, as HTML runs one in
 * its window: the window's members are its globals, and its own var and
 * function declarations land on the window. False where there is no
 * node:vm to run it with. The page's window becomes a context the first
 * time; its built-ins, such as Array and Error, are then the context's.
 */
export function runInWindow(
	window: object,
	source: string,
	filename: string,
): boolean {
	const vm = getVM();
	if (vm === null) {
		return false;
	}
	makeContext(vm, window);
	vm.runInContext(source, window, {filename});
	return true;
}

/**
 * An event handler attribute's function, compiled as HTML compiles one:
 * the window is its global, and `scopes` are looked in first, the last
 * innermost. Null where there is no node:vm.
 */
export function compileInWindow(
	window: object,
	source: string,
	scopes: object[],
	filename: string,
): ((...args: unknown[]) => unknown) | null {
	const vm = getVM();
	if (vm === null) {
		return null;
	}
	makeContext(vm, window);
	return vm.compileFunction(
		source,
		["event"],
		{parsingContext: window, contextExtensions: scopes, filename},
	);
}

function makeContext(vm: VM, window: object): void {
	if (!vm.isContext(window)) {
		vm.createContext(window);
		// Code in the context sees its global proxy as this, globalThis and
		// window, so the proxy is the window to the engine too.
		aliasSlots(vm.runInContext("globalThis", window) as object, window);
	}
}

/** Whether a frame can have a realm of its own here. */
export function canCreateRealms(): boolean {
	return getVM() !== null;
}

/**
 * A new realm with the window's interfaces, or null where the runtime
 * cannot make one. Its global is the context's own global object, which
 * code running in the realm sees as `globalThis`; a frame's window is
 * built onto it.
 */
export function createRealm(): Realm | null {
	const vm = getVM();
	if (vm === null) {
		return null;
	}
	const sandbox = {};
	const context = vm.createContext(sandbox);
	const global = vm.runInContext("globalThis", context) as Record<
		PropertyKey,
		unknown
	>;
	const intrinsics =
		vm.runInContext(`({${INTRINSICS.join(", ")}})`, context) as Record<
			string,
			Constructor
		>;
	const realm: Realm = {
		global,
		sandbox,
		intrinsics,
		objectPrototype: vm.runInContext("Object.prototype", context) as object,
		functionPrototype: vm.runInContext("Function.prototype", context) as object,
		interfaces: new Map(),
		prototypes: new Map(),
		instanceMembers: new Map(),
		document: null,
	};
	installRealmInterfaces(realm);
	registerRealm(
		realm,
		vm.runInContext(
			"[async function () {}, function* () {}, async function* () {}]" +
				".map(Object.getPrototypeOf)",
			context,
		) as object[],
	);
	// The realm's own code reaches its eval through a global let, so a direct
	// eval keeps its scope. Code passed to the window's eval from outside
	// runs as the realm's, as HTML's incumbent would have it.
	vm.runInContext("let eval = globalThis.eval;", context);
	const evaluate = global.eval as (code: unknown) => unknown;
	const evalInRealm = {
		eval(code: unknown): unknown {
			return runInRealm(realm, () => evaluate(code));
		},
	}.eval;
	Object.setPrototypeOf(evalInRealm, realm.functionPrototype);
	Object.defineProperty(global, "eval", {
		value: evalInRealm,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	return realm;
}

/**
 * `value`, a structured clone made here, as the same clone made in
 * `realm`: its objects, arrays, maps, sets, dates, regular expressions,
 * errors, wrapped primitives and binary data are the realm's own, as
 * HTML deserializes a message in the realm that receives it. Platform
 * objects are left as they are, which the clone made in the realm already.
 */
export function rehomeClone(value: unknown, realm: Realm): unknown {
	return rehome(value, realm, new Map());
}

function rehome(
	value: unknown,
	realm: Realm,
	seen: Map<object, unknown>,
): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const done = seen.get(value);
	if (done !== undefined) {
		return done;
	}
	const own = realm.intrinsics;
	const make = <T>(copy: T, fill?: (copy: T) => void): T => {
		seen.set(value, copy);
		fill?.(copy);
		return copy;
	};
	const copyKeys = (copy: Record<string, unknown>) => {
		for (const key of Object.keys(value)) {
			copy[key] = rehome((value as Record<string, unknown>)[key], realm, seen);
		}
	};
	if (Array.isArray(value)) {
		return make(
			new (own.Array as ArrayConstructor)(value.length) as unknown as
				Record<string, unknown>,
			copyKeys,
		);
	}
	const prototype = Object.getPrototypeOf(value) as object | null;
	if (prototype === Object.prototype || prototype === null) {
		return make(
			(prototype === null
				? (own.Object as ObjectConstructor).create(null)
				: new (own.Object as ObjectConstructor)()) as Record<string, unknown>,
			copyKeys,
		);
	}
	if (value instanceof Map) {
		return make(new (own.Map as MapConstructor)(), (copy) => {
			for (const [key, item] of value) {
				copy.set(rehome(key, realm, seen), rehome(item, realm, seen));
			}
		});
	}
	if (value instanceof Set) {
		return make(new (own.Set as SetConstructor)(), (copy) => {
			for (const item of value) {
				copy.add(rehome(item, realm, seen));
			}
		});
	}
	if (value instanceof Date) {
		return make(new (own.Date as DateConstructor)(value.getTime()));
	}
	if (value instanceof RegExp) {
		return make(
			new (own.RegExp as RegExpConstructor)(value.source, value.flags),
		);
	}
	if (
		value instanceof Boolean ||
		value instanceof Number ||
		value instanceof String
	) {
		const Wrapper = own[(value.constructor as Constructor).name] as
			new (primitive: unknown) => object;
		return make(new Wrapper(value.valueOf()));
	}
	if (value instanceof ArrayBuffer) {
		return make(
			new (own.ArrayBuffer as ArrayBufferConstructor)(value.byteLength),
			(copy) => {
				new Uint8Array(copy).set(new Uint8Array(value));
			},
		);
	}
	if (ArrayBuffer.isView(value)) {
		const buffer = rehome(value.buffer, realm, seen) as ArrayBuffer;
		const View = own[(value.constructor as Constructor).name] as
			new (buffer: ArrayBuffer, offset: number, length: number) => object;
		const length = value instanceof DataView
			? value.byteLength
			: (value as unknown as {length: number}).length;
		return make(new View(buffer, value.byteOffset, length));
	}
	if (value instanceof Error) {
		const name = ERRORS.includes(value.name) ? value.name : "Error";
		const ErrorType = own[name] as ErrorConstructor;
		return make(new ErrorType(value.message), (copy) => {
			if ("stack" in value) {
				copy.stack = value.stack;
			}
			if ("cause" in value) {
				(copy as {cause?: unknown}).cause = rehome(value.cause, realm, seen);
			}
		});
	}
	return value;
}
