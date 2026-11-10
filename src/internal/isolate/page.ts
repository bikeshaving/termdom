/**
 * A page's scripts run with the isolate's global object as theirs, and a
 * global object cannot be swapped for the frame's window. So the window's
 * members are copied onto it, its methods bound to the window, and its
 * attributes read through to it, and window, self and frames name the
 * global, as they would in a browser.
 */
import {createObjectURL, revokeObjectURL} from "./blob.ts";
import {createMessageChannel} from "./messaging.ts";

type Win =
	Record<string, unknown> &
	{location: {href: string}; parent: unknown; top: unknown};

const KEPT_GLOBALS = new Set([
	"constructor",
	"globalThis",
	"window",
	"self",
	"top",
	"parent",
	"frames",
	"fetch",
	"location",
]);

export function installPage(window: object): void {
	const win = window as Win;
	const names = new Set<string>();
	for (
		let object: object | null = win;
		object !== null && object !== Object.prototype;
		object = Object.getPrototypeOf(object) as object | null
	) {
		for (const name of Object.getOwnPropertyNames(object)) {
			names.add(name);
		}
	}

	for (const name of names) {
		if (KEPT_GLOBALS.has(name)) {
			continue;
		}

		const existing = Object.getOwnPropertyDescriptor(globalThis, name);
		if (existing !== undefined && !existing.configurable) {
			continue;
		}

		let value: unknown;
		try {
			value = win[name];
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}

			continue;
		}

		if (typeof value === "function" && /^[a-z]/.test(name)) {
			Object.defineProperty(globalThis, name, {
				value: (value as (...args: unknown[]) => unknown).bind(win),
				writable: true,
				configurable: true,
			});
		} else if (typeof value === "function") {
			Object.defineProperty(globalThis, name, {
				value,
				writable: true,
				configurable: true,
			});
		} else {
			Object.defineProperty(globalThis, name, {
				get: () => win[name],
				set: (next: unknown) => {
					win[name] = next;
				},
				configurable: true,
			});
		}
	}

	for (const name of ["window", "self", "frames"]) {
		Object.defineProperty(globalThis, name, {
			value: globalThis,
			writable: false,
			configurable: false,
		});
	}

	for (const name of ["parent", "top"] as const) {
		Object.defineProperty(globalThis, name, {
			get: () => win[name],
			configurable: false,
		});
	}

	Object.defineProperty(globalThis, "location", {
		get: () => win.location,
		set: (value: unknown) => {
			win.location.href = String(value);
		},
		configurable: false,
	});
	const {MessageChannel, MessagePort} = createMessageChannel(
		win as unknown as Parameters<typeof createMessageChannel>[0],
	);
	for (const [name, value] of [
		["MessageChannel", MessageChannel],
		["MessagePort", MessagePort],
	] as const) {
		Object.defineProperty(globalThis, name, {
			value,
			writable: true,
			configurable: true,
		});
	}

	const PageURL = (globalThis as unknown as {URL: object}).URL;
	Object.defineProperty(PageURL, "createObjectURL", {
		value: (object: unknown) =>
			createObjectURL(object, new URL(win.location.href).origin),
		writable: true,
		configurable: true,
	});
	Object.defineProperty(PageURL, "revokeObjectURL", {
		value: revokeObjectURL,
		writable: true,
		configurable: true,
	});
}
