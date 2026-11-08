/**
 * Raster images: decoding PNG, JPEG, GIF and BMP into RGBA bitmaps,
 * encoding a bitmap as PNG, and sampling a bitmap down to the two
 * pixels a cell shows.
 *
 * A cell draws two pixels stacked: the lower half block (U+2584) in the
 * foreground color under the background color. An image drawn that way
 * scrolls, clips and diffs like any other text, over SSH and inside tmux
 * too. A terminal that draws the kitty graphics protocol is sent the
 * pixels themselves instead (see kitty.ts).
 *
 * Nothing here touches the DOM. The elements register what they hold,
 * and the canvas and the painter read it back through the registry at
 * the bottom.
 */
import type {Caret, CellGrid} from "./framebuffer.ts";
import type * as ImageCodecs from "./imagecodecs.ts";
import {requireFromSource} from "./require.ts";
import {clearTimeout, setTimeout} from "./timers.ts";

/** Straight (not premultiplied) RGBA, four bytes a pixel, rows top down. */
export interface Bitmap {
	width: number;
	height: number;
	data: Uint8ClampedArray;
	// The size the image is, when its pixels were kept smaller than that.
	// Everything outside the pixels themselves measures this one.
	naturalWidth?: number;
	naturalHeight?: number;

	// The pixels at that full size, which a canvas draws from.
	full?: Uint8ClampedArray;
}

export function getNaturalWidth(bitmap: Bitmap): number {
	return bitmap.naturalWidth ?? bitmap.width;
}

export function getNaturalHeight(bitmap: Bitmap): number {
	return bitmap.naturalHeight ?? bitmap.height;
}

/** The image at its natural size, pixel for pixel. */
export function getFullBitmap(bitmap: Bitmap): Bitmap {
	return bitmap.full === undefined
		? bitmap
		: {
			width: getNaturalWidth(bitmap),
			height: getNaturalHeight(bitmap),
			data: bitmap.full,
		};
}

/**
 * The largest image anything here allocates: 32768 pixels to a side and
 * 2^26 in all, 256 MB as RGBA. A file states its size before its
 * pixels, so a few bytes can ask for any amount of memory. Like a
 * browser, a decoder refuses a size past these before it allocates.
 */
const MAX_IMAGE_SIDE = 32768;
export const MAX_IMAGE_PIXELS = 1 << 26;

/** Throws for a size an image may not have. */
export function checkImageSize(
	width: number,
	height: number,
	format: string,
): void {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error(`The ${format} image has no size`);
	}
	if (
		width > MAX_IMAGE_SIDE ||
		height > MAX_IMAGE_SIDE ||
		width * height > MAX_IMAGE_PIXELS
	) {
		throw new Error(
			`The ${format} image is ${width} by ${height} pixels, more than an image may be`,
		);
	}
}

// A browser decodes on another thread. On one, a decoder hands the event
// loop a turn this often, so a large image does not stall the page
// while it decodes.
const DECODE_SLICE_MS = 16;

// Returns a promise to await when a turn is due, and undefined between.
// Past `deadline`, a time from Date.now(), the promise rejects instead.
export function createYielder(
	deadline: number,
): () => Promise<void> | undefined {
	let last = performance.now();
	return () => {
		if (performance.now() - last < DECODE_SLICE_MS) {
			return undefined;
		}
		return new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				last = performance.now();
				if (Date.now() > deadline) {
					reject(new Error("The image took too long to decode"));
				} else {
					resolve();
				}
			}, 0);
		});
	};
}

/**
 * The most pixels a decoded image draws to cells from, 4 MB of them. A
 * terminal shows a few hundred thousand at most, so a larger image is
 * also kept averaged down to this, and reports its full size as its
 * natural size. Its full pixels stay beside that copy, as a browser keeps
 * an image decoded, for a canvas to draw.
 */
export const MAX_KEPT_PIXELS = 1 << 20;

/** The image as a page keeps it: at most MAX_KEPT_PIXELS to draw cells from. */
export function keepAtMost(bitmap: Bitmap): Bitmap {
	const {width, height} = bitmap;
	if (width * height <= MAX_KEPT_PIXELS) {
		return bitmap;
	}
	const scale = Math.sqrt(MAX_KEPT_PIXELS / (width * height));
	const keptWidth = Math.max(1, Math.floor(width * scale));
	const keptHeight = Math.max(1, Math.floor(height * scale));
	return {
		width: keptWidth,
		height: keptHeight,
		data: sampleBitmap(bitmap, keptWidth, keptHeight),
		naturalWidth: width,
		naturalHeight: height,
		full: bitmap.data,
	};
}

declare const require: (id: string) => unknown;

let imageCodecs: typeof ImageCodecs | null = null;

/**
 * The codecs, loaded the first time an image decodes or a page encodes
 * one. No other module imports imagecodecs.ts for its values.
 */
export function loadImageCodecs(): typeof ImageCodecs {
	if (imageCodecs === null) {
		try {
			imageCodecs = require("./imagecodecs.ts") as typeof ImageCodecs;
		} catch (error) {
			imageCodecs =
				requireFromSource("./imagecodecs.ts", error) as typeof ImageCodecs;
		}
	}
	return imageCodecs;
}

/**
 * Decode, and keep at most MAX_KEPT_PIXELS. A decode still running at
 * `deadline` stops at its next yield.
 */
export async function decodeImageForPage(
	bytes: Uint8Array,
	deadline = Infinity,
): Promise<Bitmap> {
	return keepAtMost(await loadImageCodecs().decodeImage(bytes, deadline));
}

export function createBitmap(width: number, height: number): Bitmap {
	return {width, height, data: new Uint8ClampedArray(width * height * 4)};
}

// ---------------------------------------------------------------------------
// Sampling into cells.

/**
 * The image's pixels averaged down (or repeated up) to `outWidth` by
 * `outHeight` pixels, from the source rectangle. Each output pixel is
 * the coverage-weighted average of the source pixels under it, with
 * alpha weighting the color so a transparent pixel's color does not
 * bleed in. A cell shows two of these pixels stacked, so a box of cells
 * samples twice as many rows as it has.
 */
export function sampleBitmap(
	bitmap: Bitmap,
	outWidth: number,
	outHeight: number,
	natural: {x: number; y: number; width: number; height: number} = {
		x: 0,
		y: 0,
		width: getNaturalWidth(bitmap),
		height: getNaturalHeight(bitmap),
	},
	smooth = true,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(Math.max(0, outWidth * outHeight * 4));
	if (
		outWidth <= 0 || outHeight <= 0 || natural.width <= 0 || natural.height <= 0
	) {
		return out;
	}
	const {width, height, data} = bitmap;
	// The rectangle is in the image's natural pixels, and the pixels kept
	// may be fewer.
	const keptX = width / getNaturalWidth(bitmap);
	const keptY = height / getNaturalHeight(bitmap);
	const source = {
		x: natural.x * keptX,
		y: natural.y * keptY,
		width: natural.width * keptX,
		height: natural.height * keptY,
	};
	const scaleX = source.width / outWidth;
	const scaleY = source.height / outHeight;
	for (let oy = 0; oy < outHeight; oy++) {
		const y0 = source.y + oy * scaleY;
		const y1 = y0 + scaleY;
		for (let ox = 0; ox < outWidth; ox++) {
			const x0 = source.x + ox * scaleX;
			const x1 = x0 + scaleX;
			const at = (oy * outWidth + ox) * 4;
			// Upscaled, or asked for crisp pixels: the nearest one.
			if (!smooth || (scaleX <= 1 && scaleY <= 1)) {
				const sx = Math.min(width - 1, Math.max(0, Math.floor((x0 + x1) / 2)));
				const sy = Math.min(height - 1, Math.max(0, Math.floor((y0 + y1) / 2)));
				const from = (sy * width + sx) * 4;
				out[at] = data[from];
				out[at + 1] = data[from + 1];
				out[at + 2] = data[from + 2];
				out[at + 3] = data[from + 3];
				continue;
			}
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let area = 0;
			const yStart = Math.max(0, Math.floor(y0));
			const yEnd = Math.min(height, Math.ceil(y1));
			const xStart = Math.max(0, Math.floor(x0));
			const xEnd = Math.min(width, Math.ceil(x1));
			for (let sy = yStart; sy < yEnd; sy++) {
				const cover = Math.min(sy + 1, y1) - Math.max(sy, y0);
				for (let sx = xStart; sx < xEnd; sx++) {
					const weight = cover * (Math.min(sx + 1, x1) - Math.max(sx, x0));
					const from = (sy * width + sx) * 4;
					const alpha = data[from + 3] * weight;
					r += data[from] * alpha;
					g += data[from + 1] * alpha;
					b += data[from + 2] * alpha;
					a += alpha;
					area += weight;
				}
			}
			if (a > 0) {
				out[at] = r / a;
				out[at + 1] = g / a;
				out[at + 2] = b / a;
				out[at + 3] = a / area;
			}
		}
	}
	return out;
}

/**
 * The average of the pixels in a rectangle of the bitmap, weighted by how
 * much of each the rectangle covers and by alpha, as RGBA.
 */
export function averageBitmap(
	bitmap: Bitmap,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): [number, number, number, number] {
	const {width, height, data} = bitmap;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	let area = 0;
	for (let sy = Math.max(0, Math.floor(y0));
		sy < Math.min(height, Math.ceil(y1));
		sy++) {
		const cover = Math.min(sy + 1, y1) - Math.max(sy, y0);
		for (let sx = Math.max(0, Math.floor(x0));
			sx < Math.min(width, Math.ceil(x1));
			sx++) {
			const weight = cover * (Math.min(sx + 1, x1) - Math.max(sx, x0));
			const at = (sy * width + sx) * 4;
			const alpha = data[at + 3] * weight;
			r += data[at] * alpha;
			g += data[at + 1] * alpha;
			b += data[at + 2] * alpha;
			a += alpha;
			area += weight;
		}
	}
	return a > 0 ? [r / a, g / a, b / a, a / area] : [0, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// The registry: what an <img>, a <canvas> or an ImageBitmap holds, for
// drawImage() and the painter to read without knowing the elements.

/** What a replaced element shows. */
export type ReplacedContent =
	{
		kind: "bitmap";
		bitmap: Bitmap;
		// Bumped on every change, for caches keyed on the pixels.
		version: number;
		// Whether the pixels a cell covers are averaged. Off, each cell
		// takes the nearest pixel.
		smooth: boolean;
	} |
	// A canvas not drawn on yet: its size, and nothing to paint.
	{kind: "blank"; width: number; height: number} |
	{
		kind: "grid";
		// The canvas's width and height attributes, in CSS pixels.
		width: number;
		height: number;
		// The grid resized to the cells its box holds.
		fit(cols: number, rows: number): CellGrid;
		version: number;
		// Where in the grid the terminal's cursor goes, as a frame's focused
		// field puts it, read once the grid is fitted. None for no caret.
		caret?: () => Caret | null;
	} |
	{kind: "text"; text: string; loading: boolean} |
	null;

const replacedSources = new WeakMap<object, () => ReplacedContent>();

export function registerReplacedContent(
	owner: object,
	read: () => ReplacedContent,
): void {
	replacedSources.set(owner, read);
}

export function unregisterReplacedContent(owner: object): void {
	replacedSources.delete(owner);
}

export function getReplacedContent(owner: object): ReplacedContent {
	return replacedSources.get(owner)?.() ?? null;
}

/** Whether the element draws what the registry holds instead of children. */
export function isReplacedElement(owner: object): boolean {
	return replacedSources.has(owner);
}

// ---------------------------------------------------------------------------
// Reading what a src names.

/**
 * The URL a src names, against the document's URL, or null. A relative
 * src in a document with no URL of its own, at about:blank, names
 * nothing.
 */
export function resolveImageURL(src: string, base: string): string | null {
	// A Windows path's drive letter would read as a URL scheme.
	if (/^[a-z]:[\\/]/i.test(src)) {
		return new URL(`file:///${src.replace(/\\/g, "/")}`).href;
	}
	return URL.canParse(src, base) ? new URL(src, base).href : null;
}

/** The most bytes an image file may have before it decodes. */
export const MAX_IMAGE_BYTES = 1 << 26;

function checkImageBytes(length: number): void {
	if (length > MAX_IMAGE_BYTES) {
		throw new Error(`The image file is more than ${MAX_IMAGE_BYTES} bytes`);
	}
}

/**
 * The image types the decoders read, for a request's Accept header, so a
 * server that picks a format by it picks one of these.
 */
export const IMAGE_ACCEPT =
	"image/png,image/jpeg,image/gif,image/bmp;q=0.9,*/*;q=0.5";

/**
 * A response's bytes, up to MAX_IMAGE_BYTES: by its declared length when
 * it has one, and while reading when it has not.
 */
export async function readImageResponse(
	response: Response,
): Promise<Uint8Array> {
	// A body left unread holds its connection open.
	const discard = () => response.body?.cancel().catch(() => {});
	if (!response.ok) {
		await discard();
		throw new Error(`The image request failed with status ${response.status}`);
	}
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
		await discard();
		checkImageBytes(declared);
	}
	if (response.body === null) {
		return new Uint8Array(0);
	}
	// The length a server declares is not a promise. The body is read
	// a piece at a time and given up past the limit.
	const reader = response.body.getReader();
	const pieces: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			break;
		}
		length += value.length;
		if (length > MAX_IMAGE_BYTES) {
			await reader.cancel().catch(() => {});
			checkImageBytes(length);
		}
		pieces.push(value);
	}
	const bytes = new Uint8Array(length);
	let at = 0;
	for (const piece of pieces) {
		bytes.set(piece, at);
		at += piece.length;
	}
	return bytes;
}

// ---------------------------------------------------------------------------
// Decoding off the page's thread.

/**
 * How long an image may take to decode. Past it, the worker is ended,
 * which ends the decode with it, or the decode here stops at its next
 * yield, and the image fails.
 */
const decodeTimeout = 10_000;
// A worker with nothing to do is ended, so it keeps the runtime alive for
// a second at most.
const WORKER_IDLE_MS = 1_000;

let workerURL: URL | null = null;

interface DecodeWorker {
	post(message: unknown, transfer: Transferable[]): void;
	terminate(): void;
}

interface Job {
	bytes: Uint8Array;
	resolve(bitmap: Bitmap): void;
	reject(error: unknown): void;
	// Called when the job leaves the line to decode.
	started(): void;
}

interface WorkerState {
	worker: DecodeWorker;
	// Until the worker says it started, a failure means it cannot start.
	ready: boolean;
	idle: ReturnType<typeof setTimeout> | null;
}

// Images decode one at a time, in the order they ask. A decode's time
// limit then counts its own work and not the line ahead of it, and one
// decode's memory is all the decoding a page holds at once.
const waiting: Job[] = [];
let running: {
	job: Job;
	id: number;
	timer: ReturnType<typeof setTimeout> | null;
} |
	null = null;
let current: WorkerState | null = null;
// False for good once a worker fails to start: decoding stays here.
let workersWork = true;
let nextRequest = 0;

/** The module src/image-decode.worker.ts builds to, which decodes off-thread. */
export function setDecodeWorkerURL(url: URL | null): void {
	if (current !== null) {
		endWorker(current);
	}
	workerURL = url;
	workersWork = url !== null;
	// An image the ended worker had goes to whatever decodes next.
	if (running !== null && running.timer !== null) {
		clearTimeout(running.timer);
		waiting.unshift(running.job);
		running = null;
		startNextDecode();
	}
}

/**
 * Decode on a worker thread, where the runtime has one, so a large image
 * does not stall the page. Where no worker starts, the decode runs here,
 * a slice at a time. Either way it stops past decodeTimeout.
 */
export function decodeImageOffThread(
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<Bitmap> {
	return new Promise<Bitmap>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const job: Job = {bytes, resolve, reject, started: () => {}};
		// A decode that has not started is dropped, with its bytes. One
		// that has runs to its end or its time limit.
		if (signal !== undefined) {
			const onAbort = () => {
				const index = waiting.indexOf(job);
				if (index !== -1) {
					waiting.splice(index, 1);
					reject(signal.reason);
				}
			};
			signal.addEventListener("abort", onAbort, {once: true});
			job.started = () => signal.removeEventListener("abort", onAbort);
		}
		waiting.push(job);
		startNextDecode();
	});
}

function startNextDecode(): void {
	if (running !== null) {
		return;
	}
	const job = waiting.shift();
	job?.started();
	if (job === undefined) {
		const idle = current;
		if (idle !== null && idle.idle === null) {
			idle.idle = setTimeout(() => endWorker(idle), WORKER_IDLE_MS);
		}
		return;
	}
	const id = nextRequest++;
	const state = workersWork ? getWorker() : null;
	if (state === null) {
		running = {job, id, timer: null};
		decodeImageForPage(job.bytes, Date.now() + decodeTimeout)
			.then(job.resolve, job.reject)
			.finally(() => {
				running = null;
				startNextDecode();
			});
		return;
	}
	if (state.idle !== null) {
		clearTimeout(state.idle);
		state.idle = null;
	}
	running = {job, id, timer: startDecodeTimer(id, state)};
	// A copy the worker can take, whatever buffer the bytes sit in. The
	// job keeps its own, in case the worker never starts.
	const copy = job.bytes.slice();
	state.worker.post({id, bytes: copy.buffer}, [copy.buffer]);
}

// The running decode's time limit, counted again once the worker is
// ready, so a worker's start does not count against its first image.
function startDecodeTimer(
	id: number,
	state: WorkerState,
): ReturnType<typeof setTimeout> {
	return setTimeout(() => {
		if (running?.id !== id) {
			return;
		}
		const {job} = running;
		running = null;
		job.reject(
			new Error(`The image took more than ${decodeTimeout} ms to decode`),
		);
		// Ending the worker ends the decode. A new one takes the next image.
		endWorker(state);
		startNextDecode();
	}, decodeTimeout);
}

function finishDecode(id: number, settle: (job: Job) => void): void {
	if (running?.id !== id) {
		return;
	}
	const {job, timer} = running;
	if (timer !== null) {
		clearTimeout(timer);
	}
	running = null;
	settle(job);
	startNextDecode();
}

function getWorker(): WorkerState | null {
	if (current !== null) {
		return current;
	}
	const url = workerURL;
	if (url === null) {
		return null;
	}
	let state: WorkerState | null = null;
	const onMessage = (data: unknown) => {
		if (state === null || current !== state) {
			return;
		}
		const message = data as {
			ready?: boolean;
			id?: number;
			width?: number;
			height?: number;
			naturalWidth?: number;
			naturalHeight?: number;
			data?: ArrayBuffer;
			full?: ArrayBuffer;
			error?: string;
		};
		if (message.ready) {
			state.ready = true;
			if (running !== null && running.timer !== null) {
				clearTimeout(running.timer);
				running.timer = startDecodeTimer(running.id, state);
			}
			return;
		}
		finishDecode(message.id!, (job) => {
			if (message.error !== undefined) {
				job.reject(new Error(message.error));
			} else {
				job.resolve({
					width: message.width!,
					height: message.height!,
					data: new Uint8ClampedArray(message.data!),
					naturalWidth: message.naturalWidth,
					naturalHeight: message.naturalHeight,
					full: message.full && new Uint8ClampedArray(message.full),
				});
			}
		});
	};
	const onError = (error: unknown) => {
		if (state === null || current !== state) {
			return;
		}
		const started = state.ready;
		endWorker(state);
		if (!started) {
			// It never started: the image in hand decodes here, and so does
			// every one after it.
			workersWork = false;
			if (running !== null) {
				const {job, timer} = running;
				if (timer !== null) {
					clearTimeout(timer);
				}
				running = null;
				waiting.unshift(job);
			}
			startNextDecode();
			return;
		}
		// It started and then failed on this image. The image fails, and a
		// new worker takes the next.
		if (running !== null) {
			finishDecode(running.id, (job) =>
				job.reject(
					new Error(
						(error as {message?: string} | null)?.message ||
							"The image decoder failed",
					),
				),
			);
		}
	};
	const worker = startWorker(url, onMessage, onError);
	if (worker === null) {
		workersWork = false;
		return null;
	}
	state = {worker, ready: false, idle: null};
	current = state;
	return state;
}

function endWorker(state: WorkerState): void {
	if (current === state) {
		current = null;
	}
	if (state.idle !== null) {
		clearTimeout(state.idle);
		state.idle = null;
	}
	state.worker.terminate();
}

interface WebWorker {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: string, listener: (event: any) => void): void;
	terminate(): void;
}

// The runtime's own web Worker, where it has one: Bun, Deno, a browser,
// and Node from 26.9 with --experimental-web-worker. Without one, images
// decode on this thread. It is read when this module loads, so a Worker an
// app puts on globalThis afterward does not run TermDOM's decoder.
const RuntimeWorker = (globalThis as {Worker?: new (
	url: URL,
	options: {type: "module"},
) => WebWorker;}).Worker;

function startWorker(
	url: URL,
	onMessage: (data: unknown) => void,
	onError: (error: unknown) => void,
): DecodeWorker | null {
	if (RuntimeWorker === undefined) {
		return null;
	}
	try {
		const worker = new RuntimeWorker(url, {type: "module"});
		worker.addEventListener("message", (event) => onMessage(event.data));
		worker.addEventListener("error", (event) => {
			event.preventDefault?.();
			onError(event.error ?? event);
		});
		return {
			post: (message, transfer) => worker.postMessage(message, transfer),
			terminate: () => worker.terminate(),
		};
	} catch (_error) {
		return null;
	}
}

// The TermDOMs alive that may decode. A running worker keeps the runtime
// alive, so when the last is disposed the worker ends with it, and with
// it any decode still running.
let decoderUsers = 0;

export function retainDecoder(): void {
	decoderUsers++;
}

export function releaseDecoder(): void {
	decoderUsers = Math.max(0, decoderUsers - 1);
	if (decoderUsers > 0 || current === null) {
		return;
	}
	if (running !== null && running.timer !== null) {
		clearTimeout(running.timer);
		const {job} = running;
		running = null;
		job.reject(new DOMException("The decoder was closed", "AbortError"));
	}
	endWorker(current);
}
