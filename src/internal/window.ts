/**
 * A window: the document's interfaces put together on one object, the
 * DOM's, the CSSOM's and the canvas's, with the timers and the rest a
 * script expects to find. It is built above all of them, so none of them
 * has to import another to be on it.
 */
import {
	CanvasGradient,
	CanvasPattern,
	CanvasRenderingContext2D,
	ImageBitmap,
	ImageData,
	Path2D,
} from "./canvas.ts";
import {CSSOM_INTERFACES} from "./cssom.ts";
import {
	cloneStructured,
	constructOnto,
	createWindowRegistry,
	type Document,
	DOMException,
	HTMLImageElement,
	parseHTMLDocument,
	parseXMLDocument,
	platform,
	processTimers,
	reportError,
	runtime,
	setAttributeByName,
	setFrameWindowFactory,
	startPendingImages,
	toImageDimension,
	Window,
	windowTimers,
} from "./dom.ts";
import {createRealm, rehomeClone} from "./realms.ts";
import {
	createWindowFetch,
	getDocumentLoader,
	setDocumentLoader,
} from "./resources.ts";
import {_, prepareClasses} from "./slots.ts";
import type {setTimeout} from "./timers.ts";
import {
	type Constructor,
	installInterfaces,
	type Realm,
	runInRealm,
	windowMember,
} from "./webidl.ts";

// A window starts with its interfaces and the timers any script expects
// to find. The display fills in the rest (sizing, scrolling, animation
// frames, the clipboard) as it mounts the document. A frame's window is
// its realm's global object, with the realm's interfaces, and its timers
// run with the realm active.
export function buildWindow(
	document: Document,
	realm: Realm | null = null,
): Window {
	let window: Record<string, unknown>;
	if (realm === null) {
		window = new Window(document) as unknown as Record<string, unknown>;
	} else {
		// The window keeps the prototype it is built with under its named
		// properties, so it takes the realm's first.
		Object.setPrototypeOf(realm.global, realm.prototypes.get(Window)!);
		window = runInRealm(realm, () =>
			constructOnto(realm.global, () => new Window(document))) as unknown as
			Record<string, unknown>;
	}
	// HTML reports an exception a timer or a microtask lets escape, as it
	// does a listener's, and the page goes on. The runtime's own would end
	// the process.
	const guard = (handler: unknown, args: unknown[]): unknown =>
		typeof handler !== "function"
			? handler
			: () => {
				runInRealm(realm, () => {
					try {
						(handler as (...args: unknown[]) => void)(...args);
					} catch (error) {
						reportError(error, document);
					}
				});
			};
	// The page's outstanding timers, which stop with the window, by the
	// number HTML hands the page for each: the runtime's own handle is the
	// runtime's object.
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	windowTimers.set(window, timers);
	let lastTimerId = 0;
	const clearTimer = (id: unknown) => {
		const key = Number(id);
		const handle = timers.get(key);
		if (handle !== undefined) {
			timers.delete(key);
			runtime.clearTimeout(handle);
		}
	};
	processTimers.set(window, {
		setTimeout: (handler: unknown, timeout?: number, ...args: unknown[]) =>
			runtime.setTimeout(guard(handler, args) as () => void, timeout),
		setInterval: (handler: unknown, timeout?: number, ...args: unknown[]) =>
			runtime.setInterval(guard(handler, args) as () => void, timeout),
	});
	Object.assign(
		window,
		getWindowClasses(),
		Object.fromEntries(realm?.interfaces ?? getInterfaceObjects()),
		{
		// The platform's DOMException, which is the one the DOM and the CSSOM
		// throw. A caller's `instanceof DOMException` has to match the class
		// the engine builds its errors from.
			DOMException,
			setTimeout: (handler: unknown, timeout?: number, ...args: unknown[]) => {
				const guarded = guard(handler, args);
				const id = ++lastTimerId;
				timers.set(
					id,
					runtime.setTimeout(
						(typeof guarded === "function"
							? () => {
								timers.delete(id);
								(guarded as () => void)();
							}
							: guarded) as () => void,
						timeout,
					),
				);
				return id;
			},
			clearTimeout: clearTimer,
			setInterval: (handler: unknown, timeout?: number, ...args: unknown[]) => {
				const id = ++lastTimerId;
				timers.set(
					id,
					runtime.setInterval(guard(handler, args) as () => void, timeout),
				);
				return id;
			},
			clearInterval: clearTimer,
			queueMicrotask: (callback: unknown) => {
				if (typeof callback !== "function") {
					throw new TypeError("queueMicrotask needs a function");
				}
				runtime.queueMicrotask(guard(callback, []) as () => void);
			},
			atob: runtime.atob,
			btoa: runtime.btoa,
			fetch: runtime.fetch,
			structuredClone: (
				value: unknown,
				options: StructuredSerializeOptions = {},
			) => {
				const clone = (options.transfer ?? []).length > 0
					? runtime.structuredClone(value, options)
					: runInRealm(realm, () =>
						cloneStructured(value, "execute 'structuredClone' on 'Window'"),
					);
				return realm === null ? clone : rehomeClone(clone, realm);
			},
		});
	// HTML's legacy factory: new Image(width, height) is an <img> in this
	// window's document.
	const Image = function Image(this: unknown, width?: number, height?: number) {
		if (new.target === undefined) {
			throw new TypeError("Image is a constructor");
		}
		const image = document.createElement("img");
		if (width !== undefined) {
			setAttributeByName(image, "width", String(toImageDimension(width)));
		}
		if (height !== undefined) {
			setAttributeByName(image, "height", String(toImageDimension(height)));
		}
		return image;
	} as unknown as typeof HTMLImageElement;
	Object.defineProperty(Image, "prototype", {
		value:
			realm?.prototypes.get(HTMLImageElement) ?? HTMLImageElement.prototype,
	});
	if (realm !== null) {
		Object.setPrototypeOf(Image, realm.functionPrototype);
	}
	window.Image = Image;
	window.window = window;
	window.self = window;
	for (const name of Object.keys(window)) {
		const value = window[name];
		if (typeof value === "function" && /^[a-z]/.test(name)) {
			window[name] = windowMember(
				window,
				name,
				value as (...args: never[]) => unknown,
			);
		}
	}
	prepareClasses(Object.values(getWindowClasses()));
	startPendingImages(document as unknown as globalThis.Document);
	return window as unknown as Window;
}

// The classes a window exposes by name. Read when a window is made rather
// than in the module's interface table: canvas.ts is part of the import
// cycle through cssvalues, and a table built at module load would read
// its classes before they exist when canvas.ts is the first module
// imported.
let windowClasses: Readonly<Record<string, Constructor>> | null = null;

export function getWindowClasses(): Readonly<Record<string, Constructor>> {
	windowClasses ??= {
		...platform,
		...CSSOM_INTERFACES,
		CanvasGradient,
		CanvasPattern,
		CanvasRenderingContext2D,
		ImageBitmap,
		ImageData,
		Path2D,
	} as unknown as Record<string, Constructor>;
	return windowClasses;
}

// The window's interface objects, laid out before the first document is
// made, so that every platform object has its unforgeable members.
export function getInterfaceObjects(): ReadonlyMap<string, Constructor> {
	return installInterfaces(getWindowClasses());
}

// A frame's document and window, built in a realm of their own where the
// runtime can make one. Its handler attributes stay inert, as a frame's
// did before it had a realm, and its requests are the window's it is in:
// held to the same policy, and offered to the same fetch listeners.
setFrameWindowFactory((source, url, registry, parent, frame) => {
	const realm = createRealm();
	if (realm === null) {
		return null;
	}
	return runInRealm(realm, () => {
		const document = parseHTMLDocument(source, url, true, registry);
		realm.document = document;
		const window = buildWindow(document, realm);
		const windowSlots = _(window);
		windowSlots.parentWindow = parent;
		windowSlots.frameOwner = frame;
		windowSlots.realm = realm;
		const loader = parent === null ? null : getDocumentLoader(parent);
		if (loader !== null) {
			setDocumentLoader(window, loader);
			(window as unknown as Record<string, unknown>).fetch = windowMember(
				window,
				"fetch",
				createWindowFetch(document, loader),
			);
		}
		return {document, window};
	});
});

/**
 * Parse a document from markup and display it in a window of its own. An
 * XML content type parses as XML, which is what a frame whose src names a
 * .xml, .xhtml or .svg file holds.
 */
export function createWindow(
	source: string,
	url?: string,
	contentType = "text/html",
	scripting = false,
): Window {
	getInterfaceObjects();
	if (contentType === "text/html") {
		return buildWindow(
			parseHTMLDocument(source, url, true, createWindowRegistry(), scripting),
		);
	}
	const document = parseXMLDocument(source, contentType);
	const documentSlots = _(document);
	documentSlots.registry = createWindowRegistry();
	if (url !== undefined) {
		documentSlots.extra.documentURL = url;
	}
	return buildWindow(document);
}
