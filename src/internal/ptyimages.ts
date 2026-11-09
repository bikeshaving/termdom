/**
 * Kitty graphics from the program in a pty embed: the images it sends,
 * kept by their ids, for the embed to draw where the program's
 * placeholder cells name them. Only images sent in the escape itself
 * (t=d) and placed virtually (U=1) are drawn. A placement at the cursor
 * names no cells, so nothing could follow it as the screen scrolls.
 */
import {type Bitmap, decodeImageForPage, loadImageCodecs} from "./images.ts";
import {MAX_KITTY_PIXELS} from "./kitty.ts";

/** An image the program sent, and the cells its placement covers. */
export interface ProgramImage {
	bitmap: Bitmap;
	// The virtual placement's size, 0 until the program places it.
	cols: number;
	rows: number;
	// Bumped when the pixels or the placement change.
	version: number;
}

// The images a program keeps before the oldest is dropped.
const MAX_IMAGES = 64;

// The most base64 a transmission holds: an image of the most pixels, as
// RGBA, with no compression.
const MAX_PAYLOAD = Math.ceil((MAX_KITTY_PIXELS * 4) / 3) * 4;

// The most bytes a PNG may take, inflated or not.
const MAX_FILE = MAX_KITTY_PIXELS * 4;

function parseControl(text: string): Map<string, string> {
	const control = new Map<string, string>();
	for (const pair of text.split(",")) {
		const equals = pair.indexOf("=");
		if (equals > 0) {
			control.set(pair.slice(0, equals), pair.slice(equals + 1));
		}
	}
	return control;
}

function readNumber(control: Map<string, string>, key: string): number {
	const value = Number(control.get(key) ?? 0);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

// The error a transmission's format earns, or null for one this reads.
function checkFormat(control: Map<string, string>): string | null {
	if ((control.get("t") ?? "d") !== "d") {
		return "EINVAL:only direct transmission is supported";
	}
	if (!["24", "32", "100"].includes(control.get("f") ?? "32")) {
		return "EINVAL:unknown format";
	}
	if (!["", "z"].includes(control.get("o") ?? "")) {
		return "EINVAL:unknown compression";
	}
	return null;
}

function decodeBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

// The kitty protocol's error for a failure: a code, then the message.
function describeFailure(code: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${code}:${message.replace(/[\x00-\x1f;]/g, " ")}`;
}

// The pixels of a transmission, or the error it earns.
async function decodeTransmission(
	control: Map<string, string>,
	payload: string,
): Promise<Bitmap | string> {
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(payload);
	} catch (error) {
		return describeFailure("EINVAL", error);
	}
	const format = control.get("f") ?? "32";
	const width = readNumber(control, "s");
	const height = readNumber(control, "v");
	const channels = format === "24" ? 3 : 4;
	if (format !== "100") {
		if (width === 0 || height === 0 || width * height > MAX_KITTY_PIXELS) {
			return "EINVAL:bad size";
		}
	}
	const size = format === "100" ? MAX_FILE : width * height * channels;
	if (control.get("o") === "z") {
		try {
			bytes = await loadImageCodecs().inflate(bytes, size);
		} catch (error) {
			return describeFailure("EINVAL", error);
		}
	}
	if (format === "100") {
		try {
			return await decodeImageForPage(bytes);
		} catch (error) {
			return describeFailure("EBADPNG", error);
		}
	}
	if (bytes.length < size) {
		return "ENODATA:too few pixels";
	}
	const data = new Uint8ClampedArray(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const from = pixel * channels;
		data[pixel * 4] = bytes[from];
		data[pixel * 4 + 1] = bytes[from + 1];
		data[pixel * 4 + 2] = bytes[from + 2];
		data[pixel * 4 + 3] = channels === 4 ? bytes[from + 3] : 255;
	}
	return {width, height, data};
}

/** The kitty graphics one program sends. */
export class ProgramImages {
	images: Map<number, ProgramImage>;
	// A transmission sent in chunks, until its last chunk.
	pending: {control: Map<string, string>; payload: string} | null;
	// Commands run in order, each after the decode of the one before.
	work: Promise<void>;
	reply: (data: string) => void;
	changed: () => void;
	version: number;
	disposed: boolean;

	constructor(reply: (data: string) => void, changed: () => void) {
		this.images = new Map();
		this.pending = null;
		this.work = Promise.resolve();
		this.reply = reply;
		this.changed = changed;
		this.version = 0;
		this.disposed = false;
	}

	/** One APC G command, without the G. */
	command(text: string): void {
		const split = text.indexOf(";");
		const control = parseControl(split < 0 ? text : text.slice(0, split));
		const payload = split < 0 ? "" : text.slice(split + 1);
		const more = control.get("m") === "1";
		const pending = this.pending;
		if (pending !== null) {
			if (pending.payload.length + payload.length > MAX_PAYLOAD) {
				this.pending = null;
				return;
			}
			pending.payload += payload;
			if (!more) {
				this.pending = null;
				this.queue(pending.control, pending.payload);
			}
			return;
		}
		if (more) {
			this.pending = {control, payload};
			return;
		}
		this.queue(control, payload);
	}

	queue(control: Map<string, string>, payload: string): void {
		this.work = this.work
			.then(() => this.run(control, payload))
			.catch(() => {});
	}

	async run(control: Map<string, string>, payload: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		const action = control.get("a") ?? "t";
		const id = readNumber(control, "i");
		if (action === "q") {
			this.respond(control, id, checkFormat(control) ?? "OK");
		} else if (action === "t" || action === "T") {
			const error = checkFormat(control);
			const decoded = error ?? await decodeTransmission(control, payload);
			if (this.disposed) {
				return;
			}
			if (typeof decoded === "string") {
				this.respond(control, id, decoded);
				return;
			}
			const placed = action === "T" && control.get("U") === "1";
			this.store(id, {
				bitmap: decoded,
				cols: placed ? readNumber(control, "c") : 0,
				rows: placed ? readNumber(control, "r") : 0,
				version: ++this.version,
			});
			this.respond(control, id, "OK");
		} else if (action === "p") {
			const image = this.images.get(id);
			if (image === undefined) {
				this.respond(control, id, "ENOENT:no such image");
			} else if (control.get("U") === "1") {
				image.cols = readNumber(control, "c");
				image.rows = readNumber(control, "r");
				image.version = ++this.version;
				this.changed();
				this.respond(control, id, "OK");
			}
		} else if (action === "d") {
			const what = (control.get("d") ?? "a").toLowerCase();
			if (what === "a") {
				this.images.clear();
			} else if (what === "i") {
				this.images.delete(id);
			}
			this.changed();
		}
	}

	store(id: number, image: ProgramImage): void {
		this.images.delete(id);
		this.images.set(id, image);
		if (this.images.size > MAX_IMAGES) {
			this.images.delete(this.images.keys().next().value!);
		}
		this.changed();
	}

	// No reply for an image without an id, none for q=2, and only
	// errors for q=1, as kitty does.
	respond(control: Map<string, string>, id: number, message: string): void {
		const quiet = control.get("q");
		if (id === 0 || quiet === "2" || (quiet === "1" && message === "OK")) {
			return;
		}
		this.reply(`\x1b_Gi=${id};${message}\x1b\\`);
	}

	dispose(): void {
		this.disposed = true;
		this.images.clear();
		this.pending = null;
	}
}
