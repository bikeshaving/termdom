/**
 * Frames whose document is in another isolate. The iframe loads its
 * document under the page's policy and fetch listeners, starts it in an
 * isolate the TermDOM's isolator makes, and draws the cells it paints
 * there. Keys, the mouse, pastes and focus reach it as a program in an
 * embed takes them, and messages cross as a window of another origin
 * sends them. What comes back is the other isolate's word, so the cells
 * are checked as they are drawn and nothing else of it is run here.
 */
import {
	constructInternal,
	type Document,
	Event,
	type HTMLIFrameElement,
	type IsolatedFrameView,
	navigateFrameParent,
	receiveFrameMessage,
	setIsolatedFrameFactory,
	setRequestDestination,
	type Window,
} from "./dom.ts";
import type {WireKey} from "./exchange.ts";
import {
	type Caret,
	CellGrid,
	type GridCells,
	type ImportedPlaceholder,
	importGrid,
} from "./framebuffer.ts";
import type {Bitmap, GridImage} from "./images.ts";
import {requireNodePackage} from "./isolate/bundle.ts";
import type {
	FrameImage,
	FrameInit,
	FrameIsolator,
	FrameMessage,
	FrameRequest,
	HostMessage,
	IsolatedFrame,
} from "./isolateprotocol.ts";
import {MAX_KITTY_PIXELS, MAX_PLACEHOLDER_CELLS} from "./kitty.ts";
import {_} from "./slots.ts";
import {getCellSize} from "./units.ts";

// The loads a frame may have in flight at once.
const MAX_FETCHES = 64;

// The images a frame may hold at once.
const MAX_IMAGES = 256;

// Tells each frame's images from another's among those the page shows.
let nextFrameToken = 1;

// Request headers a frame may not set, as Fetch forbids a page to.
const FORBIDDEN_HEADER =
	/^(?:accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;

const DESTINATIONS = new Set<string>([
	"",
	"audio",
	"document",
	"embed",
	"font",
	"iframe",
	"image",
	"manifest",
	"object",
	"script",
	"style",
	"track",
	"video",
	"worker",
]);

function isWebURL(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

// A form's POST, as the frame encoded it.
interface Submission {
	body: Uint8Array<ArrayBuffer>;
	contentType: string;
}

function readSubmission(
	message: Extract<FrameMessage, {type: "navigate"}>,
): Submission | undefined {
	if (
		typeof message.method !== "string" ||
		message.method.toUpperCase() !== "POST"
	) {
		return undefined;
	}
	return {
		body: message.body instanceof Uint8Array
			? Uint8Array.from(message.body)
			: new Uint8Array(0),
		contentType: typeof message.contentType === "string"
			? message.contentType.replace(/[\r\n]/g, "")
			: "",
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : "Failed to fetch";
}

function escapeText(text: string): string {
	return text.replace(/[&<]/g, (char) => (char === "&" ? "&amp;" : "&lt;"));
}

function readHeaders(headers: Headers): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	headers.forEach((value, name) => {
		entries.push([name, value]);
	});
	return entries;
}

class RemoteFrame implements IsolatedFrameView {
	frame: HTMLIFrameElement;
	window: Window;
	parent: Document;
	isolate: FrameIsolator;
	changed: () => void;
	url: string;
	cols: number;
	rows: number;
	caret: Caret | null;
	grid: CellGrid;
	// The cells the frame painted last, imported into the grid at the
	// next fit.
	cells: GridCells | null;
	stale: boolean;
	token: number;
	// The images the frame posted, by its ids, and those the grid's
	// placeholders show.
	posted: Map<
		number,
		{bitmap: Bitmap; cols: number; rows: number; version: number}
	>;

	shown: GridImage[];
	imageVersion: number;
	focused: boolean;
	running: IsolatedFrame | null;
	// What is sent before the frame has started, sent once it has.
	waiting: HostMessage[];
	fetches: Map<number, AbortController>;
	// Ends the load of the frame's document and its fetches, at a
	// navigation or once the frame goes.
	unload: AbortController;
	disposed: boolean;

	constructor(
		frame: HTMLIFrameElement,
		window: Window,
		url: string,
		parent: Document,
		isolate: FrameIsolator,
		changed: () => void,
	) {
		this.frame = frame;
		this.window = window;
		this.parent = parent;
		this.isolate = isolate;
		this.changed = changed;
		this.url = url;
		this.cols = 0;
		this.rows = 0;
		this.caret = null;
		this.grid = new CellGrid(0, 0);
		this.cells = null;
		this.stale = false;
		this.token = nextFrameToken++;
		this.posted = new Map();
		this.shown = [];
		this.imageVersion = 0;
		this.focused = false;
		this.running = null;
		this.waiting = [];
		this.fetches = new Map();
		this.unload = new AbortController();
		this.disposed = false;
		void this.start(url);
	}

	async start(url: string, submission?: Submission): Promise<void> {
		const unload = this.unload;
		const engine = _(this.parent).extra;
		let html: string;
		let documentURL = url;
		try {
			const request = new Request(url, {
				method: submission === undefined ? "GET" : "POST",
				headers: submission?.contentType
					? {"content-type": submission.contentType}
					: undefined,
				body: submission?.body,
				signal: unload.signal,
			});
			setRequestDestination(request, "iframe");
			const response = await engine.load(request, {
				initiator: this.frame as unknown as globalThis.Element,
			});
			html = await response.text();
			documentURL = response.url === "" ? url : response.url;
		} catch (error) {
			if (unload.signal.aborted) {
				return;
			}
			// A browser shows its own page for a frame that failed to load.
			html = `<!DOCTYPE html><pre>${escapeText(describeError(error))}</pre>`;
		}
		if (unload.signal.aborted) {
			return;
		}
		this.url = documentURL;
		const framebuffer = engine.framebuffer;
		const cell = getCellSize(this.parent);
		const view = engine.defaultView as globalThis.Window | null;
		const media = (query: string) => view?.matchMedia(query).matches ?? false;
		const sandbox = _(this.window).sandbox;
		this.running = this.isolate(
			{
				url: documentURL,
				html,
				parentOrigin: view?.origin ?? "null",
				cols: this.cols,
				rows: this.rows,
				cellWidth: cell.width,
				cellHeight: cell.height,
				pixelRatio: framebuffer.pixelRatio ?? 1,
				colorDepth: framebuffer.writer.colorDepth,
				colorScheme: media("(prefers-color-scheme: dark)") ? "dark" : "light",
				reducedMotion: media("(prefers-reduced-motion: reduce)"),
				scripting:
					media("(scripting: enabled)") &&
					(sandbox === null || sandbox.has("allow-scripts")),
				images: engine.images === "none" ? "cells" : "kitty",
			},
			(message) => {
				if (unload === this.unload) {
					this.receive(message);
				}
			},
		);
		for (const message of this.waiting.splice(0)) {
			this.running.send(message);
		}
	}

	send(message: HostMessage): void {
		if (this.disposed) {
			return;
		}
		if (this.running === null) {
			this.waiting.push(message);
		} else {
			this.running.send(message);
		}
	}

	receive(message: FrameMessage): void {
		if (this.disposed) {
			return;
		}
		switch (message.type) {
			case "paint":
				this.cells = message.cells;
				this.caret = this.readCaret(message.caret, message.cells);
				this.stale = true;
				this.changed();
				break;
			case "navigate":
				if (message.target === "parent") {
					navigateFrameParent(this.window, String(message.url));
				} else {
					this.navigate(message.url, readSubmission(message));
				}
				break;
			case "history":
				this.receiveHistory(message.url);
				break;
			case "images":
				this.receiveImages(message.added, message.dropped);
				break;
			case "crash":
				this.stop();
				this.cells = null;
				this.caret = null;
				this.stale = true;
				this.changed();
				break;
			case "load":
				this.frame.dispatchEvent(constructInternal(() => new Event("load")));
				break;
			case "message":
				receiveFrameMessage(
					this.window,
					message.data,
					this.getOrigin(),
					String(message.targetOrigin),
				);
				break;
			case "fetch":
				void this.fetch(message.id, message.request);
				break;
			case "abortFetch":
				this.fetches.get(message.id)?.abort();
				break;
		}
	}

	// The frame's document changed its URL in place, which keeps its
	// origin.
	receiveHistory(target: string): void {
		const url = URL.parse(String(target), this.url);
		if (url === null || url.origin !== URL.parse(this.url)?.origin) {
			return;
		}
		this.url = url.href;
	}

	// The origin the frame's messages come from: its document's, or an
	// opaque one where a sandbox withholds allow-same-origin.
	getOrigin(): string {
		const sandbox = _(this.window).sandbox;
		if (sandbox !== null && !sandbox.has("allow-same-origin")) {
			return "null";
		}
		return URL.parse(this.url)?.origin ?? "null";
	}

	// The images the frame's next cells show, each checked against its
	// size before the page holds it.
	receiveImages(added: FrameImage[], dropped: number[]): void {
		for (const id of dropped) {
			this.posted.delete(id);
		}
		for (const image of added) {
			const {id, width, height, cols, rows, pixels} = image;
			if (
				![id, width, height, cols, rows].every(Number.isInteger) ||
				id < 1 ||
				id > 0xffffff ||
				width < 1 ||
				height < 1 ||
				width * height > MAX_KITTY_PIXELS ||
				!(pixels instanceof Uint8ClampedArray) ||
				pixels.length !== width * height * 4 ||
				cols < 1 ||
				rows < 1 ||
				cols > MAX_PLACEHOLDER_CELLS ||
				rows > MAX_PLACEHOLDER_CELLS ||
				(!this.posted.has(id) && this.posted.size >= MAX_IMAGES)
			) {
				continue;
			}
			this.posted.set(id, {
				bitmap: {width, height, data: pixels},
				cols,
				rows,
				version: ++this.imageVersion,
			});
		}
		this.stale = true;
	}

	images(): GridImage[] {
		return this.shown;
	}

	// A caret the frame names is drawn only inside the cells it painted.
	readCaret(caret: Caret | null, cells: GridCells): Caret | null {
		if (
			caret === null ||
			!Number.isInteger(caret.col) ||
			!Number.isInteger(caret.row) ||
			caret.col < 0 ||
			caret.row < 0 ||
			caret.col >= cells.cols ||
			caret.row >= cells.rows
		) {
			return null;
		}
		return {
			col: caret.col,
			row: caret.row,
			shape: Number(caret.shape) | 0,
			color: typeof caret.color === "number" ? caret.color & 0xffffff : null,
		};
	}

	// The frame's document went to another URL: the isolate goes, and
	// one for the new document starts.
	navigate(target: string, submission?: Submission): void {
		const url = URL.parse(String(target), this.url);
		if (url === null || !isWebURL(url)) {
			return;
		}
		this.stop();
		this.unload = new AbortController();
		this.posted.clear();
		this.cells = null;
		this.caret = null;
		this.stale = true;
		this.changed();
		void this.start(url.href, submission);
	}

	async fetch(id: number, request: FrameRequest): Promise<void> {
		const url = URL.parse(String(request.url));
		if (
			url === null ||
			(!isWebURL(url) && url.protocol !== "data:") ||
			this.fetches.has(id) ||
			this.fetches.size >= MAX_FETCHES
		) {
			this.send({type: "fetchError", id, message: "Failed to fetch"});
			return;
		}
		const abort = new AbortController();
		this.fetches.set(id, abort);
		const unload = this.unload;
		const onUnload = () => abort.abort();
		unload.signal.addEventListener("abort", onUnload, {once: true});
		try {
			const headers = new Headers();
			for (const [name, value] of request.headers) {
				if (!FORBIDDEN_HEADER.test(String(name))) {
					headers.append(String(name), String(value));
				}
			}
			const method = String(request.method).toUpperCase();
			const loaded = new Request(url.href, {
				method,
				headers,
				body: method === "GET" || method === "HEAD" || request.body === null
					? null
					: Uint8Array.from(request.body),
				redirect: request.redirect,
				signal: abort.signal,
			});
			if (DESTINATIONS.has(request.destination)) {
				setRequestDestination(
					loaded,
					request.destination as RequestDestination,
				);
			}
			const response = await _(this.parent).extra.load(loaded, {
				initiator: this.frame as unknown as globalThis.Element,
			});
			const body = new Uint8Array(await response.arrayBuffer());
			if (!abort.signal.aborted) {
				this.send({
					type: "response",
					id,
					response: {
						url: response.url,
						status: response.status,
						statusText: response.statusText,
						headers: readHeaders(response.headers),
						redirected: response.redirected,
						body,
					},
				});
			}
		} catch (error) {
			if (!unload.signal.aborted) {
				this.send({type: "fetchError", id, message: describeError(error)});
			}
		} finally {
			unload.signal.removeEventListener("abort", onUnload);
			this.fetches.delete(id);
		}
	}

	fit(cols: number, rows: number): CellGrid {
		if (cols !== this.cols || rows !== this.rows) {
			this.cols = cols;
			this.rows = rows;
			this.grid = new CellGrid(rows, cols);
			this.stale = true;
			const cell = getCellSize(this.parent);
			if (this.running !== null) {
				this.running.send({
					type: "resize",
					cols,
					rows,
					cellWidth: cell.width,
					cellHeight: cell.height,
					pixelRatio: _(this.parent).extra.framebuffer.pixelRatio ?? 1,
				});
			}
		}
		if (this.stale) {
			this.stale = false;
			const shown = new Map<number, GridImage>();
			if (this.cells !== null) {
				importGrid(this.cells, this.grid, (place) =>
					this.showImage(shown, place));
			}
			this.shown = [...shown.values()];
		}
		return this.grid;
	}

	// A placeholder cell shows its image only where the frame posted one
	// with that id that has a cell there.
	showImage(shown: Map<number, GridImage>, place: ImportedPlaceholder): void {
		const image = this.posted.get(place.id);
		if (
			image === undefined ||
			place.imageRow >= image.rows ||
			place.imageCol >= image.cols
		) {
			return;
		}
		let entry = shown.get(place.id);
		if (entry === undefined) {
			entry = {
				key: `frame:${this.token}:${place.id}`,
				version: image.version,
				bitmap: image.bitmap,
				cols: image.cols,
				rows: image.rows,
				cells: [],
			};
			shown.set(place.id, entry);
		}
		entry.cells.push({
			row: place.row,
			col: place.col,
			imageRow: place.imageRow,
			imageCol: place.imageCol,
			bg: place.bg,
		});
	}

	sendKey(key: WireKey): boolean {
		this.send({
			type: "input",
			item: [
				{
					kind: "key",
					key: key.key,
					char: key.char,
					shiftKey: key.shiftKey,
					ctrlKey: key.ctrlKey,
					altKey: key.altKey,
					metaKey: key.metaKey,
				},
			],
		});
		return true;
	}

	paste(text: string): void {
		this.send({type: "input", item: {kind: "paste", text}});
	}

	sendMouse(code: number, col: number, row: number, release: boolean): boolean {
		this.send({
			type: "input",
			item: {kind: "mouse", button: code, col, row, release, ticks: 1},
		});
		return true;
	}

	scrollBy(): boolean {
		return false;
	}

	sendFocus(focused: boolean): void {
		if (focused !== this.focused) {
			this.focused = focused;
			this.send({type: "input", item: {kind: "focus", focused}});
		}
	}

	postMessage(data: unknown, origin: string, targetOrigin: string): void {
		this.send({type: "message", data, origin, targetOrigin});
	}

	stop(): void {
		this.unload.abort();
		this.running?.dispose();
		this.running = null;
		this.waiting = [];
	}

	dispose(): void {
		this.stop();
		this.disposed = true;
	}
}

// A frame started before its backend has loaded, which starts there and
// sends what it was given once the backend has.
class PendingFrame implements IsolatedFrame {
	init: FrameInit;
	receive: (message: FrameMessage) => void;
	waiting: HostMessage[];
	frame: IsolatedFrame | null;
	disposed: boolean;

	constructor(
		init: FrameInit,
		receive: (message: FrameMessage) => void,
		backend: Promise<FrameIsolator | string>,
	) {
		this.init = init;
		this.receive = receive;
		this.waiting = [];
		this.frame = null;
		this.disposed = false;
		void backend.then((isolate) => this.start(isolate));
	}

	start(isolate: FrameIsolator | string): void {
		if (this.disposed) {
			return;
		}
		if (typeof isolate === "string") {
			this.receive({type: "crash", reason: isolate});
			return;
		}
		this.frame = isolate(this.init, this.receive);
		for (const message of this.waiting.splice(0)) {
			this.frame.send(message);
		}
	}

	send(message: HostMessage): void {
		if (this.frame === null) {
			this.waiting.push(message);
		} else {
			this.frame.send(message);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.waiting = [];
		this.frame?.dispose();
	}
}

let isolatedVM: Promise<FrameIsolator | string> | null = null;

// isolated-vm's isolator, compiled with the first frame.
function startInIsolatedVM(
	init: FrameInit,
	receive: (message: FrameMessage) => void,
): IsolatedFrame {
	isolatedVM ??= import("./isolatedvm.ts")
		.then((backend) => backend.createIsolatedVMFrames())
		.catch((error: unknown) =>
			`isolated-vm could not load: ${describeError(error)}`,
		);
	return new PendingFrame(init, receive, isolatedVM);
}

let found: FrameIsolator | null | undefined;

/**
 * What starts a frame's document in an isolate of its own, where the
 * isolated-vm package is installed and loads, as on Node. Null elsewhere,
 * where an iframe's src shows nothing.
 */
export function findFrameIsolator(): FrameIsolator | null {
	if (found === undefined) {
		try {
			requireNodePackage("isolated-vm");
			found = startInIsolatedVM;
		} catch (_err) {
			found = null;
		}
	}
	return found;
}

setIsolatedFrameFactory((frame, window, url, parent, isolate, changed) =>
	new RemoteFrame(frame, window, url, parent, isolate, changed),
);
