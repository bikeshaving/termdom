/**
 * Realms for frames. A browser gives each frame a JavaScript realm of
 * its own: its own Object, Array and Function, and its own copy of every
 * interface, so an array or a node from a frame is not `instanceof` the
 * parent's. node:vm makes such a realm in Node, Bun and Deno. Where there
 * is none, as in a browser running TermDOM, a frame shares the parent's.
 */
import {
	type Constructor,
	installRealmInterfaces,
	type Realm,
	registerRealm,
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
	runInContext(code: string, context: object): unknown;
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
	registerRealm(realm);
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
