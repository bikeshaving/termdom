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
	importGrid,
} from "./framebuffer.ts";
import type {
	FrameIsolator,
	FrameMessage,
	FrameRequest,
	HostMessage,
	IsolatedFrame,
} from "./isolateprotocol.ts";
import {_} from "./slots.ts";

// The loads a frame may have in flight at once.
const MAX_FETCHES = 64;

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
		this.focused = false;
		this.running = null;
		this.waiting = [];
		this.fetches = new Map();
		this.unload = new AbortController();
		this.disposed = false;
		void this.start(url);
	}

	async start(url: string): Promise<void> {
		const unload = this.unload;
		const engine = _(this.parent).extra;
		let html: string;
		let documentURL = url;
		try {
			const request = new Request(url, {signal: unload.signal});
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
		const view = engine.defaultView as globalThis.Window | null;
		const media = (query: string) => view?.matchMedia(query).matches ?? false;
		const sandbox = _(this.window).sandbox;
		this.running = this.isolate(
			{
				url: documentURL,
				html,
				cols: this.cols,
				rows: this.rows,
				cellWidth: framebuffer.cellPixels.width,
				cellHeight: framebuffer.cellPixels.height,
				pixelRatio: framebuffer.pixelRatio ?? 1,
				colorDepth: framebuffer.writer.colorDepth,
				colorScheme: media("(prefers-color-scheme: dark)") ? "dark" : "light",
				reducedMotion: media("(prefers-reduced-motion: reduce)"),
				scripting:
					media("(scripting: enabled)") &&
					(sandbox === null || sandbox.has("allow-scripts")),
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
				this.navigate(message.url);
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

	// The origin the frame's messages come from: its document's, or an
	// opaque one where a sandbox withholds allow-same-origin.
	getOrigin(): string {
		const sandbox = _(this.window).sandbox;
		if (sandbox !== null && !sandbox.has("allow-same-origin")) {
			return "null";
		}
		return URL.parse(this.url)?.origin ?? "null";
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
	navigate(target: string): void {
		const url = URL.parse(String(target), this.url);
		if (url === null || !isWebURL(url)) {
			return;
		}
		this.stop();
		this.unload = new AbortController();
		this.cells = null;
		this.caret = null;
		this.stale = true;
		this.changed();
		void this.start(url.href);
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
			const cell = _(this.parent).extra.framebuffer;
			if (this.running !== null) {
				this.running.send({
					type: "resize",
					cols,
					rows,
					cellWidth: cell.cellPixels.width,
					cellHeight: cell.cellPixels.height,
					pixelRatio: cell.pixelRatio ?? 1,
				});
			}
		}
		if (this.stale) {
			this.stale = false;
			if (this.cells !== null) {
				importGrid(this.cells, this.grid);
			}
		}
		return this.grid;
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

setIsolatedFrameFactory((frame, window, url, parent, isolate, changed) =>
	new RemoteFrame(frame, window, url, parent, isolate, changed),
);
