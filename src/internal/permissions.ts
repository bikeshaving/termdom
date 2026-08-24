/**
 * navigator.permissions: the Permissions API over a terminal, which has one
 * permission behind it -- the clipboard -- and nothing behind the rest.
 */
import {EventTarget, installEventHandlers} from "./dom.js";

/** What a permission query asks its host about the clipboard's standing. */
export interface PermissionGate {
	/** Whether the terminal is attached and taking input. */
	interactive(): boolean;
	/** Whether a user gesture is being dispatched right now. */
	userActive(): boolean;
}

// The permission names the clipboard here answers for, and the ones the
// Permissions API defines that a terminal has nothing behind: no camera, no
// microphone, no location, no notification surface, so the answer is denied
// rather than a prompt nobody could ever answer.
const CLIPBOARD_PERMISSIONS = new Set(["clipboard-read", "clipboard-write"]);
const UNBACKED_PERMISSIONS = new Set([
	"accelerometer",
	"ambient-light-sensor",
	"background-sync",
	"bluetooth",
	"camera",
	"display-capture",
	"geolocation",
	"gyroscope",
	"idle-detection",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"notifications",
	"payment-handler",
	"periodic-background-sync",
	"persistent-storage",
	"push",
	"screen-wake-lock",
	"speaker-selection",
	"storage-access",
	"window-management",
	"xr-spatial-tracking",
]);

/** The brand an interface with no constructor is built through internally. */
const kInternalConstruction = Symbol("internal construction");
const kPermissionName = Symbol("name");
const kPermissionGate = Symbol("gate");

/**
 * The standing of one permission.
 *
 * `state` is read at the moment it is asked, and for the clipboard that
 * answer is granted while a gesture is being dispatched and prompt outside
 * one. Nothing fires `change`: the gesture opens and closes inside a single
 * dispatch, and a listener would be told about a state that had already
 * passed.
 */
export class PermissionStatus extends EventTarget {
	declare [kPermissionName]: string;
	declare [kPermissionGate]: PermissionGate | null;

	constructor(brand?: unknown, name?: string, gate?: PermissionGate) {
		super();
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kPermissionName] = String(name);
		this[kPermissionGate] = gate ?? null;
	}

	get name(): string {
		return this[kPermissionName];
	}

	get state(): string {
		const gate = this[kPermissionGate];
		if (gate === null || !CLIPBOARD_PERMISSIONS.has(this[kPermissionName])) {
			return "denied";
		}
		if (!gate.interactive()) {
			return "denied";
		}
		return gate.userActive() ? "granted" : "prompt";
	}
}

installEventHandlers(PermissionStatus.prototype, ["onchange"]);

Object.defineProperty(PermissionStatus.prototype, Symbol.toStringTag, {
	value: "PermissionStatus",
	configurable: true,
});

/** navigator.permissions: what the gate above answers, asked by name. */
export class Permissions extends EventTarget {
	declare [kPermissionGate]: PermissionGate;

	constructor(brand?: unknown, gate?: PermissionGate) {
		super();
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kPermissionGate] = gate as PermissionGate;
	}

	query(descriptor: {name?: string}): Promise<PermissionStatus> {
		if (descriptor === null || typeof descriptor !== "object") {
			return Promise.reject(
				new TypeError("A permission query takes a descriptor"),
			);
		}
		const name = String(descriptor.name);
		if (!CLIPBOARD_PERMISSIONS.has(name) && !UNBACKED_PERMISSIONS.has(name)) {
			return Promise.reject(
				new TypeError(`"${name}" is not a permission name`),
			);
		}
		return Promise.resolve(
			new PermissionStatus(
				kInternalConstruction,
				name,
				this[kPermissionGate],
			),
		);
	}
}

Object.defineProperty(Permissions.prototype, Symbol.toStringTag, {
	value: "Permissions",
	configurable: true,
});

/** Build the permissions a navigator carries. */
export function createPermissions(gate: PermissionGate): Permissions {
	return new Permissions(kInternalConstruction, gate);
}
