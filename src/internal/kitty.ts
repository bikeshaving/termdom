/**
 * Images in the kitty graphics protocol, placed with Unicode placeholders.
 *
 * The image's pixels go to the terminal once, under an id, with a virtual
 * placement as many cells across and down as the box it fills. The box
 * itself is painted as ordinary cells: each holds U+10EEEE with two
 * diacritics naming its row and column in the image, in a foreground
 * color whose 24 bits are the id. The terminal draws that cell of the
 * image there.
 *
 * Since the image is cells, it clips, stacks, scrolls and diffs as text
 * does, and nothing here tracks where it is on the screen. What is kept
 * is which ids the terminal holds, so an image is sent once, and freed
 * once no cell on the screen shows it and enough others have piled up.
 *
 * kitty and Ghostty draw placeholders. Other terminals that answer the
 * protocol's query place images at the cursor only, and would show the
 * placeholders as unknown characters.
 */
import type {CellGrid} from "./framebuffer.ts";

/** The character a placeholder cell holds before its diacritics. */
export const PLACEHOLDER = "\u{10EEEE}";

// The diacritics that number a placeholder's row and column, in order:
// kitty's rowcolumn-diacritics.txt, the combining marks of class 230
// with no decomposition in Unicode 6.0.
const DIACRITIC_RANGES: Array<[number, number]> = [
	[0x305, 0x305],
	[0x30d, 0x30e],
	[0x310, 0x310],
	[0x312, 0x312],
	[0x33d, 0x33f],
	[0x346, 0x346],
	[0x34a, 0x34c],
	[0x350, 0x352],
	[0x357, 0x357],
	[0x35b, 0x35b],
	[0x363, 0x36f],
	[0x483, 0x487],
	[0x592, 0x595],
	[0x597, 0x599],
	[0x59c, 0x5a1],
	[0x5a8, 0x5a9],
	[0x5ab, 0x5ac],
	[0x5af, 0x5af],
	[0x5c4, 0x5c4],
	[0x610, 0x617],
	[0x657, 0x65b],
	[0x65d, 0x65e],
	[0x6d6, 0x6dc],
	[0x6df, 0x6e2],
	[0x6e4, 0x6e4],
	[0x6e7, 0x6e8],
	[0x6eb, 0x6ec],
	[0x730, 0x730],
	[0x732, 0x733],
	[0x735, 0x736],
	[0x73a, 0x73a],
	[0x73d, 0x73d],
	[0x73f, 0x741],
	[0x743, 0x743],
	[0x745, 0x745],
	[0x747, 0x747],
	[0x749, 0x74a],
	[0x7eb, 0x7f1],
	[0x7f3, 0x7f3],
	[0x816, 0x819],
	[0x81b, 0x823],
	[0x825, 0x827],
	[0x829, 0x82d],
	[0x951, 0x951],
	[0x953, 0x954],
	[0xf82, 0xf83],
	[0xf86, 0xf87],
	[0x135d, 0x135f],
	[0x17dd, 0x17dd],
	[0x193a, 0x193a],
	[0x1a17, 0x1a17],
	[0x1a75, 0x1a7c],
	[0x1b6b, 0x1b6b],
	[0x1b6d, 0x1b73],
	[0x1cd0, 0x1cd2],
	[0x1cda, 0x1cdb],
	[0x1ce0, 0x1ce0],
	[0x1dc0, 0x1dc1],
	[0x1dc3, 0x1dc9],
	[0x1dcb, 0x1dcc],
	[0x1dd1, 0x1de6],
	[0x1dfe, 0x1dfe],
	[0x20d0, 0x20d1],
	[0x20d4, 0x20d7],
	[0x20db, 0x20dc],
	[0x20e1, 0x20e1],
	[0x20e7, 0x20e7],
	[0x20e9, 0x20e9],
	[0x20f0, 0x20f0],
	[0x2cef, 0x2cf1],
	[0x2de0, 0x2dff],
	[0xa66f, 0xa66f],
	[0xa67c, 0xa67d],
	[0xa6f0, 0xa6f1],
	[0xa8e0, 0xa8f1],
	[0xaab0, 0xaab0],
	[0xaab2, 0xaab3],
	[0xaab7, 0xaab8],
	[0xaabe, 0xaabf],
	[0xaac1, 0xaac1],
	[0xfe20, 0xfe26],
	[0x10a0f, 0x10a0f],
	[0x10a38, 0x10a38],
	[0x1d185, 0x1d189],
	[0x1d1aa, 0x1d1ad],
	[0x1d242, 0x1d244],
];

const DIACRITICS: string[] = DIACRITIC_RANGES.flatMap(([from, to]) =>
	Array.from({length: to - from + 1}, (_, i) => String.fromCodePoint(from + i)),
);

/**
 * The most rows or columns an image's placeholders can number. A box
 * larger than this draws in half blocks instead.
 */
export const MAX_PLACEHOLDER_CELLS = DIACRITICS.length;

/** The placeholder for the cell at `row`, `col` of an image. */
export function getPlaceholder(row: number, col: number): string {
	return PLACEHOLDER + DIACRITICS[row] + DIACRITICS[col];
}

// The largest id a 24-bit foreground color names. A third diacritic
// could carry a fourth byte, which nothing here needs.
const MAX_ID = 0xffffff;

// What the terminal may keep of images no cell shows, as RGBA bytes:
// rows scrolled into the scrollback still name theirs, so they are not
// freed at once.
const UNSHOWN_BUDGET = 32 << 20;

// An escape's payload is sent in chunks of at most this many bytes.
const CHUNK_SIZE = 4096;

interface KittyImage {
	id: number;
	width: number;
	height: number;
	cols: number;
	rows: number;
	// Until it is sent.
	pixels: Uint8ClampedArray | null;
	// The frame that last painted it or found it on the screen.
	seen: number;
}

/** The images one screen has sent, and which of its elements send them. */
export class KittyImages {
	// Whether an <img> and a canvas draw this way. Either can stay in cells.
	images: boolean;
	canvas: boolean;
	// The terminal's cell in its pixels, read when an image is drawn.
	cellPixels: () => {width: number; height: number};
	byKey: Map<string, KittyImage>;
	byId: Map<number, KittyImage>;
	nextId: number;
	frame: number;

	constructor(cellPixels: () => {width: number; height: number}) {
		this.images = false;
		this.canvas = false;
		this.cellPixels = cellPixels;
		this.byKey = new Map();
		this.byId = new Map();
		this.nextId = 1;
		this.frame = 0;
	}
}

/**
 * The id of the image `key` names, `width` by `height` pixels shown over
 * `cols` by `rows` cells. A key not seen before takes a new id, and
 * `draw` makes its pixels, which go out before the next frame.
 */
export function placeKittyImage(
	images: KittyImages,
	key: string,
	size: {width: number; height: number; cols: number; rows: number},
	draw: () => Uint8ClampedArray,
): number {
	const existing = images.byKey.get(key);
	if (existing !== undefined) {
		existing.seen = images.frame;
		return existing.id;
	}
	let id = images.nextId;
	while (images.byId.has(id)) {
		id = id >= MAX_ID ? 1 : id + 1;
	}
	images.nextId = id >= MAX_ID ? 1 : id + 1;
	const image: KittyImage = {...size, id, pixels: draw(), seen: images.frame};
	images.byKey.set(key, image);
	images.byId.set(id, image);
	return id;
}

/**
 * What goes to the terminal before a frame: the images placed since the
 * last one, and the deletes of those `screen`, the frame's cells, no
 * longer shows, past the budget, oldest first.
 */
export async function takeKittyOutput(
	images: KittyImages,
	screen: CellGrid | null,
): Promise<string> {
	const frame = images.frame++;
	if (images.byId.size === 0) {
		return "";
	}
	if (screen !== null) {
		for (const fg of screen.fg) {
			const image = images.byId.get(fg & MAX_ID);
			if (image !== undefined) {
				image.seen = frame;
			}
		}
	}
	let out = "";
	const unshown: Array<[string, KittyImage]> = [];
	let unshownBytes = 0;
	for (const entry of images.byKey) {
		const image = entry[1];
		if (image.pixels !== null) {
			const pixels = image.pixels;
			image.pixels = null;
			out += await encodeImage(image, pixels);
		} else if (image.seen < frame) {
			unshown.push(entry);
			unshownBytes += image.width * image.height * 4;
		}
	}
	unshown.sort((a, b) => a[1].seen - b[1].seen);
	for (const [key, image] of unshown) {
		if (unshownBytes <= UNSHOWN_BUDGET) {
			break;
		}
		unshownBytes -= image.width * image.height * 4;
		images.byKey.delete(key);
		images.byId.delete(image.id);
		// Upper-case I frees the pixels with the placements.
		out += `\x1b_Ga=d,d=I,i=${image.id},q=2\x1b\\`;
	}
	return out;
}

// Transmit and place virtually, at once: zlib-compressed RGBA in base64,
// chunked. q=2 keeps the terminal from answering.
async function encodeImage(
	image: KittyImage,
	pixels: Uint8ClampedArray,
): Promise<string> {
	const payload = toBase64(await deflate(pixels));
	const control =
		`a=T,U=1,q=2,f=32,o=z,s=${image.width},v=${image.height},` +
		`i=${image.id},c=${image.cols},r=${image.rows}`;
	let out = "";
	for (let at = 0; at < payload.length || at === 0; at += CHUNK_SIZE) {
		const more = at + CHUNK_SIZE < payload.length ? 1 : 0;
		const chunk = payload.slice(at, at + CHUNK_SIZE);
		out += at === 0
			? `\x1b_G${control},m=${more};${chunk}\x1b\\`
			: `\x1b_Gm=${more};${chunk}\x1b\\`;
	}
	return out;
}

// zlib, which is what CompressionStream calls "deflate".
async function deflate(bytes: Uint8ClampedArray): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8ClampedArray<ArrayBuffer>])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
	let out = "";
	// btoa takes a binary string, built a slice at a time so no call
	// spreads more arguments than a stack holds. A slice a multiple of
	// three bytes long encodes with no padding, so the pieces join.
	for (let at = 0; at < bytes.length; at += 0x6000) {
		out += btoa(String.fromCharCode(...bytes.subarray(at, at + 0x6000)));
	}
	return out;
}
