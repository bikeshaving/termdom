/**
 * Image codecs: PNG, JPEG, GIF and BMP decoding, PNG encoding and the
 * deflate and base64 they use. Loaded the first time an image decodes or
 * a page encodes one.
 */

import {
	type Bitmap,
	checkImageSize,
	createBitmap,
	createYielder,
} from "./images.ts";

/** The decoder for what the bytes start with, or null for none known. */
export function sniffImageType(bytes: Uint8Array): string | null {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46
	) {
		return "image/gif";
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	return null;
}

/**
 * Decode an image file. The format is read from the bytes, as a browser
 * sniffs it, not from a name or a content type. Rejects with the reason
 * a format is unsupported or the data is damaged.
 */
export async function decodeImage(
	bytes: Uint8Array,
	deadline = Infinity,
): Promise<Bitmap> {
	switch (sniffImageType(bytes)) {
		case "image/png":
			return await decodePNG(bytes, deadline);
		case "image/jpeg":
			return await decodeJPEG(bytes, deadline);
		case "image/gif":
			return decodeGIF(bytes);
		case "image/bmp":
			return decodeBMP(bytes);
		default:
			throw new Error("Not a PNG, JPEG, GIF or BMP image");
	}
}

// ---------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>> 0
	);
}

// zlib, which is what CompressionStream calls "deflate". Node, Bun, Deno
// and browsers all have it, and nothing else here needs a platform API.
// Reading stops at `limit` bytes: deflate shrinks a run of zeros a
// thousandfold, so what a stream would inflate to is no bound at all.
export async function inflate(
	data: Uint8Array,
	limit: number,
): Promise<Uint8Array> {
	const reader = new Blob([data as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream("deflate"))
		.getReader();
	const out = new Uint8Array(limit);
	let length = 0;
	while (length < limit) {
		const {done, value} = await reader.read();
		if (done) {
			break;
		}
		const take = Math.min(value.length, limit - length);
		out.set(value.subarray(0, take), length);
		length += take;
	}
	await reader.cancel().catch(() => {});
	return out.subarray(0, length);
}

/** `bytes` compressed as a zlib stream. */
export async function deflate(
	bytes: Uint8Array | Uint8ClampedArray,
): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Adam7: the start and step of each pass, columns then rows.
const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

// The bytes a PNG's image data inflates to: each row's filter byte and
// samples, over each Adam7 pass when interlaced.
function getPNGDataSize(
	width: number,
	height: number,
	bitsPerPixel: number,
	interlaced: boolean,
): number {
	const rowSize = (columns: number) =>
		columns === 0 ? 0 : 1 + Math.ceil((columns * bitsPerPixel) / 8);
	if (!interlaced) {
		return height * rowSize(width);
	}
	let size = 0;
	for (const [x0, y0, dx, dy] of ADAM7) {
		const columns = Math.ceil(Math.max(0, width - x0) / dx);
		const rows = Math.ceil(Math.max(0, height - y0) / dy);
		size += rows * rowSize(columns);
	}
	return size;
}

async function decodePNG(bytes: Uint8Array, deadline: number): Promise<Bitmap> {
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) {
			throw new Error("Not a PNG image");
		}
	}
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Uint8Array | null = null;
	let paletteAlpha: Uint8Array | null = null;
	// A gray or RGB sample value that is transparent, in the image's depth.
	let transparent: number[] | null = null;
	const parts: Uint8Array[] = [];
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = readUint32(bytes, offset);
		const type = String.fromCharCode(
			bytes[offset + 4],
			bytes[offset + 5],
			bytes[offset + 6],
			bytes[offset + 7],
		);
		const start = offset + 8;
		const end = start + length;
		if (end > bytes.length) {
			throw new Error("The PNG data ends inside a chunk");
		}
		const chunk = bytes.subarray(start, end);
		if (type === "IHDR") {
			width = readUint32(chunk, 0);
			height = readUint32(chunk, 4);
			depth = chunk[8];
			colorType = chunk[9];
			interlace = chunk[12];
		} else if (type === "PLTE") {
			palette = chunk;
		} else if (type === "tRNS") {
			if (colorType === 3) {
				paletteAlpha = chunk;
			} else if (colorType === 0) {
				transparent = [(chunk[0] << 8) | chunk[1]];
			} else if (colorType === 2) {
				transparent = [
					(chunk[0] << 8) | chunk[1],
					(chunk[2] << 8) | chunk[3],
					(chunk[4] << 8) | chunk[5],
				];
			}
		} else if (type === "IDAT") {
			parts.push(chunk);
		} else if (type === "IEND") {
			break;
		}
		// The length, the type and the CRC.
		offset = end + 4;
	}
	if (width <= 0 || height <= 0 || parts.length === 0) {
		throw new Error("The PNG image has no header or no data");
	}
	if (colorType === 3 && palette === null) {
		throw new Error("The paletted PNG image has no palette");
	}
	const channels = ({0: 1, 2: 3, 3: 1, 4: 2, 6: 4} as Record<number, number>)[
		colorType
	];
	if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth)) {
		throw new Error("The PNG image has an unknown color type or depth");
	}
	checkImageSize(width, height, "PNG");
	let joined = parts[0];
	if (parts.length > 1) {
		joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let at = 0;
		for (const part of parts) {
			joined.set(part, at);
			at += part.length;
		}
	}
	const bitsPerPixel = channels * depth;
	const raw = await inflate(
		joined,
		getPNGDataSize(width, height, bitsPerPixel, interlace === 1),
	);
	const bitmap = createBitmap(width, height);
	const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
	const max = (1 << depth) - 1;

	const store = (
		line: Uint8Array,
		lineWidth: number,
		x0: number,
		dx: number,
		y: number,
	) => {
		const sample = (index: number): number => {
			if (depth === 8) {
				return line[index];
			}
			if (depth === 16) {
				return (line[index * 2] << 8) | line[index * 2 + 1];
			}
			const bit = index * depth;
			return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max;
		};
		const scale = (value: number): number =>
			depth === 16 ? value / 257 : depth === 8 ? value : (value * 255) / max;
		for (let i = 0; i < lineWidth; i++) {
			const out = (y * width + x0 + i * dx) * 4;
			const data = bitmap.data;
			if (colorType === 3) {
				const index = sample(i);
				data[out] = palette![index * 3] ?? 0;
				data[out + 1] = palette![index * 3 + 1] ?? 0;
				data[out + 2] = palette![index * 3 + 2] ?? 0;
				data[out + 3] = paletteAlpha?.[index] ?? 255;
			} else if (colorType === 0 || colorType === 4) {
				const gray = sample(i * channels);
				const value = scale(gray);
				data[out] = data[out + 1] = data[out + 2] = value;
				data[out + 3] = colorType === 4
					? scale(sample(i * channels + 1))
					: transparent !== null && gray === transparent[0] ? 0 : 255;
			} else {
				const r = sample(i * channels);
				const g = sample(i * channels + 1);
				const b = sample(i * channels + 2);
				data[out] = scale(r);
				data[out + 1] = scale(g);
				data[out + 2] = scale(b);
				data[out + 3] = colorType === 6
					? scale(sample(i * channels + 3))
					: transparent !== null &&
						r === transparent[0] &&
						g === transparent[1] &&
						b === transparent[2]
						? 0
						: 255;
			}
		}
	};

	let at = 0;
	const pause = createYielder(deadline);
	const unfilter = async (
		passWidth: number,
		passHeight: number,
		emit: (line: Uint8Array, y: number) => void,
	) => {
		const stride = Math.ceil((passWidth * bitsPerPixel) / 8);
		let previous = new Uint8Array(stride);
		let current = new Uint8Array(stride);
		for (let y = 0; y < passHeight; y++) {
			if (at + 1 + stride > raw.length) {
				throw new Error("The PNG data is shorter than its image");
			}
			const filter = raw[at];
			const line = raw.subarray(at + 1, at + 1 + stride);
			at += 1 + stride;
			for (let i = 0; i < stride; i++) {
				const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
				const up = previous[i];
				const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
				let value = line[i];
				switch (filter) {
					case 1:
						value += left;
						break;
					case 2:
						value += up;
						break;
					case 3:
						value += (left + up) >> 1;
						break;
					case 4: {
						const p = left + up - upLeft;
						const pa = Math.abs(p - left);
						const pb = Math.abs(p - up);
						const pc = Math.abs(p - upLeft);
						value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
						break;
					}
				}
				current[i] = value & 0xff;
			}
			emit(current, y);
			[previous, current] = [current, previous];
			await pause();
		}
	};

	if (interlace === 1) {
		for (const [x0, y0, dx, dy] of ADAM7) {
			const passWidth = Math.ceil((width - x0) / dx);
			const passHeight = Math.ceil((height - y0) / dy);
			if (passWidth <= 0 || passHeight <= 0) {
				continue;
			}
			await unfilter(passWidth, passHeight, (line, y) =>
				store(line, passWidth, x0, dx, y0 + y * dy),
			);
		}
	} else {
		await unfilter(width, height, (line, y) => store(line, width, 0, 1, y));
	}
	return bitmap;
}

// CRC-32 over PNG's polynomial, for writing chunks.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** `bytes` in base64. */
export function toBase64(bytes: Uint8Array | Uint8ClampedArray): string {
	let out = "";
	// btoa takes a binary string, built a slice at a time so no call
	// spreads more arguments than a stack holds. A slice a multiple of
	// three bytes long encodes with no padding, so the pieces join.
	for (let at = 0; at < bytes.length; at += 0x6000) {
		out += btoa(String.fromCharCode(...bytes.subarray(at, at + 0x6000)));
	}
	return out;
}

/**
 * A bitmap as a PNG file. toDataURL() is synchronous and no synchronous
 * compressor exists everywhere this runs, so the zlib stream holds
 * stored (uncompressed) blocks. Every PNG decoder reads them.
 */
export function encodePNG(bitmap: Bitmap): Uint8Array {
	const {width, height, data} = bitmap;
	const stride = width * 4 + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		raw[y * stride] = 0;
		raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
	}
	const blocks = Math.max(1, Math.ceil(raw.length / 0xffff));
	const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
	zlib[0] = 0x78;
	zlib[1] = 0x01;
	let at = 2;
	for (let block = 0; block < blocks; block++) {
		const start = block * 0xffff;
		const size = Math.min(0xffff, raw.length - start);
		zlib[at++] = block === blocks - 1 ? 1 : 0;
		zlib[at++] = size & 0xff;
		zlib[at++] = size >> 8;
		zlib[at++] = ~size & 0xff;
		zlib[at++] = (~size >> 8) & 0xff;
		zlib.set(raw.subarray(start, start + size), at);
		at += size;
	}
	let a = 1;
	let b = 0;
	for (let i = 0; i < raw.length; i++) {
		a = (a + raw[i]) % 65521;
		b = (b + a) % 65521;
	}
	const adler = ((b << 16) | a) >>> 0;
	zlib[at++] = adler >>> 24;
	zlib[at++] = (adler >>> 16) & 0xff;
	zlib[at++] = (adler >>> 8) & 0xff;
	zlib[at++] = adler & 0xff;

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;
	header[9] = 6;
	const chunks: Array<[string, Uint8Array]> = [
		["IHDR", header],
		["IDAT", zlib.subarray(0, at)],
		["IEND", new Uint8Array(0)],
	];
	const size = 8 + chunks.reduce((sum, [, body]) => sum + 12 + body.length, 0);
	const out = new Uint8Array(size);
	out.set(PNG_SIGNATURE, 0);
	let offset = 8;
	const outView = new DataView(out.buffer);
	for (const [type, body] of chunks) {
		outView.setUint32(offset, body.length);
		for (let i = 0; i < 4; i++) {
			out[offset + 4 + i] = type.charCodeAt(i);
		}
		out.set(body, offset + 8);
		outView.setUint32(
			offset + 8 + body.length,
			crc32(out, offset + 4, offset + 8 + body.length),
		);
		offset += 12 + body.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// JPEG: baseline and progressive Huffman coding (ITU T.81), any sampling
// factors, grayscale, YCbCr, and Adobe's RGB, CMYK and YCCK. Arithmetic
// coding and lossless JPEG are rare enough to be left out.

// libjpeg-turbo's suggested limit. A progressive image has ten or so.
const MAX_JPEG_SCANS = 500;

const ZIGZAG = new Int32Array([
	0,
	1,
	8,
	16,
	9,
	2,
	3,
	10,
	17,
	24,
	32,
	25,
	18,
	11,
	4,
	5,
	12,
	19,
	26,
	33,
	40,
	48,
	41,
	34,
	27,
	20,
	13,
	6,
	7,
	14,
	21,
	28,
	35,
	42,
	49,
	56,
	57,
	50,
	43,
	36,
	29,
	22,
	15,
	23,
	30,
	37,
	44,
	51,
	58,
	59,
	52,
	45,
	38,
	31,
	39,
	46,
	53,
	60,
	61,
	54,
	47,
	55,
	62,
	63,
]);

interface HuffmanTable {
	// For each code length, the largest code of that length and where the
	// values of that length start.
	maxCode: Int32Array;
	valueOffset: Int32Array;
	values: Uint8Array;
	// Codes of up to 9 bits, read in one step: (length << 8) | value, or 0.
	lookup: Uint16Array;
}

function buildHuffmanTable(
	counts: Uint8Array,
	values: Uint8Array,
): HuffmanTable {
	const maxCode = new Int32Array(18).fill(-1);
	const valueOffset = new Int32Array(18);
	const lookup = new Uint16Array(512);
	let code = 0;
	let k = 0;
	for (let length = 1; length <= 16; length++) {
		valueOffset[length] = k - code;
		for (let i = 0; i < counts[length - 1]; i++) {
			if (length <= 9) {
				const shift = 9 - length;
				const first = code << shift;
				for (let j = 0; j < 1 << shift; j++) {
					lookup[first + j] = (length << 8) | values[k];
				}
			}
			code++;
			k++;
		}
		maxCode[length] = counts[length - 1] > 0 ? code - 1 : -1;
		code <<= 1;
	}
	maxCode[17] = 0x7fffffff;
	return {maxCode, valueOffset, values, lookup};
}

interface JPEGComponent {
	id: number;
	h: number;
	v: number;
	quantTable: number;
	blocksPerLine: number;
	blocksPerColumn: number;
	// Coefficients, 64 per block, in natural (not zigzag) order.
	blocks: Int16Array;
	blocksPerLineForMcu: number;
	dcTable: HuffmanTable | null;
	acTable: HuffmanTable | null;
	pred: number;
}

interface JPEGFrame {
	progressive: boolean;
	width: number;
	height: number;
	maxH: number;
	maxV: number;
	mcusPerLine: number;
	mcusPerColumn: number;
	components: JPEGComponent[];
}

class BitReader {
	data: Uint8Array;
	offset: number;
	buffer: number;
	bits: number;
	// A marker was met, and zeros are read past it, as T.81 F.2.2.5 says.
	marker: boolean;

	constructor(data: Uint8Array, offset: number) {
		this.data = data;
		this.offset = offset;
		this.buffer = 0;
		this.bits = 0;
		this.marker = false;
	}

	fill(): void {
		while (this.bits <= 24) {
			let byte = 0;
			if (!this.marker && this.offset < this.data.length) {
				byte = this.data[this.offset];
				if (byte === 0xff) {
					const next = this.data[this.offset + 1];
					if (next === 0) {
						this.offset += 2;
					} else {
						this.marker = true;
						byte = 0;
					}
				} else {
					this.offset++;
				}
			}
			this.buffer = (this.buffer << 8) | byte;
			this.bits += 8;
		}
	}

	peek(count: number): number {
		if (this.bits < count) {
			this.fill();
		}
		return (this.buffer >>> (this.bits - count)) & ((1 << count) - 1);
	}

	skip(count: number): void {
		this.bits -= count;
	}

	read(count: number): number {
		if (count === 0) {
			return 0;
		}
		const value = this.peek(count);
		this.skip(count);
		return value;
	}

	bit(): number {
		return this.read(1);
	}

	decode(table: HuffmanTable): number {
		const entry = table.lookup[this.peek(9)];
		if (entry !== 0) {
			this.skip(entry >> 8);
			return entry & 0xff;
		}
		let code = this.read(10);
		let length = 10;
		while (code > table.maxCode[length]) {
			code = (code << 1) | this.bit();
			length++;
			if (length > 16) {
				throw new Error("The JPEG data has a code no table holds");
			}
		}
		return table.values[code + table.valueOffset[length]];
	}

	// A magnitude category's bits, sign extended (T.81 F.2.2.1).
	receiveExtend(length: number): number {
		if (length === 0) {
			return 0;
		}
		const value = this.read(length);
		return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
	}

	// Back to byte alignment, past a restart marker if one is next.
	restart(): void {
		this.buffer = 0;
		this.bits = 0;
		this.marker = false;
		const data = this.data;
		while (this.offset < data.length) {
			if (
				data[this.offset] === 0xff &&
				data[this.offset + 1] >= 0xd0 &&
				data[this.offset + 1] <= 0xd7
			) {
				this.offset += 2;
				return;
			}
			if (data[this.offset] === 0xff && data[this.offset + 1] !== 0) {
				return;
			}
			this.offset++;
		}
	}

	// Where the next marker starts, once the scan is done.
	end(): number {
		let offset = this.offset;
		while (
			offset < this.data.length &&
			!(this.data[offset] === 0xff &&
				this.data[offset + 1] !== 0 &&
				!(this.data[offset + 1] >= 0xd0 && this.data[offset + 1] <= 0xd7))
		) {
			offset++;
		}
		return offset;
	}
}

async function decodeScan(
	data: Uint8Array,
	offset: number,
	frame: JPEGFrame,
	components: JPEGComponent[],
	resetInterval: number,
	spectralStart: number,
	spectralEnd: number,
	successivePrev: number,
	successive: number,
	pause: () => Promise<void> | undefined,
): Promise<number> {
	const reader = new BitReader(data, offset);
	const progressive = frame.progressive;
	let eobrun = 0;
	// The AC refinement's state machine (T.81 G.1.2.3).
	let successiveState = 0;
	let successiveValue = 0;

	const decodeBaseline = (component: JPEGComponent, at: number) => {
		const t = reader.decode(component.dcTable!);
		const diff = t === 0 ? 0 : reader.receiveExtend(t);
		component.pred += diff;
		component.blocks[at] = component.pred;
		let k = 1;
		while (k < 64) {
			const rs = reader.decode(component.acTable!);
			const s = rs & 15;
			const r = rs >> 4;
			if (s === 0) {
				if (r < 15) {
					break;
				}
				k += 16;
				continue;
			}
			k += r;
			if (k > 63) {
				break;
			}
			component.blocks[at + ZIGZAG[k]] = reader.receiveExtend(s);
			k++;
		}
	};

	const decodeDCFirst = (component: JPEGComponent, at: number) => {
		const t = reader.decode(component.dcTable!);
		const diff = t === 0 ? 0 : reader.receiveExtend(t) << successive;
		component.pred += diff;
		component.blocks[at] = component.pred;
	};

	const decodeDCSuccessive = (component: JPEGComponent, at: number) => {
		if (reader.bit()) {
			component.blocks[at] |= 1 << successive;
		}
	};

	const decodeACFirst = (component: JPEGComponent, at: number) => {
		if (eobrun > 0) {
			eobrun--;
			return;
		}
		let k = spectralStart;
		while (k <= spectralEnd) {
			const rs = reader.decode(component.acTable!);
			const s = rs & 15;
			const r = rs >> 4;
			if (s === 0) {
				if (r < 15) {
					eobrun = reader.read(r) + (1 << r) - 1;
					break;
				}
				k += 16;
				continue;
			}
			k += r;
			if (k > 63) {
				break;
			}
			component.blocks[at + ZIGZAG[k]] =
				reader.receiveExtend(s) * (1 << successive);
			k++;
		}
	};

	const decodeACSuccessive = (component: JPEGComponent, at: number) => {
		let k = spectralStart;
		const end = spectralEnd;
		let r = 0;
		while (k <= end) {
			const z = ZIGZAG[k];
			switch (successiveState) {
				case 0: {
					const rs = reader.decode(component.acTable!);
					const s = rs & 15;
					r = rs >> 4;
					if (s === 0) {
						if (r < 15) {
							eobrun = reader.read(r) + (1 << r);
							successiveState = 4;
						} else {
							r = 16;
							successiveState = 1;
						}
					} else {
						successiveValue = reader.receiveExtend(s);
						successiveState = r !== 0 ? 2 : 3;
					}
					continue;
				}
				case 1:
				case 2:
					if (component.blocks[at + z]) {
						component.blocks[at + z] +=
							(reader.bit() << successive) *
							(component.blocks[at + z] >= 0 ? 1 : -1);
					} else {
						r--;
						if (r === 0) {
							successiveState = successiveState === 2 ? 3 : 0;
						}
					}
					break;
				case 3:
					if (component.blocks[at + z]) {
						component.blocks[at + z] +=
							(reader.bit() << successive) *
							(component.blocks[at + z] >= 0 ? 1 : -1);
					} else {
						component.blocks[at + z] = successiveValue << successive;
						successiveState = 0;
					}
					break;
				case 4:
					if (component.blocks[at + z]) {
						component.blocks[at + z] +=
							(reader.bit() << successive) *
							(component.blocks[at + z] >= 0 ? 1 : -1);
					}
					break;
			}
			k++;
		}
		if (successiveState === 4) {
			eobrun--;
			if (eobrun === 0) {
				successiveState = 0;
			}
		}
	};

	let decodeBlock: (component: JPEGComponent, at: number) => void;
	if (progressive) {
		decodeBlock = spectralStart === 0
			? successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive
			: successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
	} else {
		decodeBlock = decodeBaseline;
	}

	const blockOffset = (component: JPEGComponent, row: number, col: number) =>
		64 * ((component.blocksPerLineForMcu) * row + col);

	let mcu = 0;
	const total = components.length === 1
		? components[0].blocksPerLine * components[0].blocksPerColumn
		: frame.mcusPerLine * frame.mcusPerColumn;
	const interval = resetInterval > 0 ? resetInterval : total;

	while (mcu < total) {
		for (const component of components) {
			component.pred = 0;
		}
		eobrun = 0;
		successiveState = 0;
		for (let n = 0; n < interval && mcu < total; n++, mcu++) {
			const turn = (mcu & 63) === 0 ? pause() : undefined;
			if (turn !== undefined) {
				await turn;
			}
			if (components.length === 1) {
				const component = components[0];
				const row = Math.floor(mcu / component.blocksPerLine);
				const col = mcu % component.blocksPerLine;
				decodeBlock(component, blockOffset(component, row, col));
			} else {
				const mcuRow = Math.floor(mcu / frame.mcusPerLine);
				const mcuCol = mcu % frame.mcusPerLine;
				for (const component of components) {
					for (let v = 0; v < component.v; v++) {
						for (let h = 0; h < component.h; h++) {
							decodeBlock(
								component,
								blockOffset(
									component,
									mcuRow * component.v + v,
									mcuCol * component.h + h,
								),
							);
						}
					}
				}
			}
		}
		if (mcu < total) {
			reader.restart();
		}
	}
	return reader.end();
}

// The scaled cosines of the separable inverse DCT.
const IDCT_COS = (() => {
	const table = new Float32Array(64);
	for (let x = 0; x < 8; x++) {
		for (let u = 0; u < 8; u++) {
			const c = u === 0 ? Math.SQRT1_2 : 1;
			table[x * 8 + u] = (c * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
		}
	}
	return table;
})();

// Dequantize one block and transform it into 8 by 8 samples.
function inverseDCT(
	input: Int16Array,
	at: number,
	quant: Uint16Array,
	out: Uint8ClampedArray,
	scratch: Float32Array,
): void {
	for (let row = 0; row < 8; row++) {
		const base = at + row * 8;
		let flat = true;
		for (let u = 1; u < 8; u++) {
			if (input[base + u] !== 0) {
				flat = false;
				break;
			}
		}
		if (flat) {
			// With only a DC term, the row is that term repeated.
			const coefficient = input[base];
			const sum = coefficient === 0
				? 0
				: IDCT_COS[0] * coefficient * quant[row * 8];
			for (let x = 0; x < 8; x++) {
				scratch[row * 8 + x] = sum;
			}
			continue;
		}
		for (let x = 0; x < 8; x++) {
			let sum = 0;
			for (let u = 0; u < 8; u++) {
				const coefficient = input[base + u];
				if (coefficient !== 0) {
					sum += IDCT_COS[x * 8 + u] * coefficient * quant[row * 8 + u];
				}
			}
			scratch[row * 8 + x] = sum;
		}
	}
	for (let x = 0; x < 8; x++) {
		let flat = true;
		for (let v = 1; v < 8; v++) {
			if (scratch[v * 8 + x] !== 0) {
				flat = false;
				break;
			}
		}
		if (flat) {
			const value = IDCT_COS[0] * scratch[x] + 128;
			for (let y = 0; y < 8; y++) {
				out[y * 8 + x] = value;
			}
			continue;
		}
		for (let y = 0; y < 8; y++) {
			let sum = 0;
			for (let v = 0; v < 8; v++) {
				sum += IDCT_COS[y * 8 + v] * scratch[v * 8 + x];
			}
			out[y * 8 + x] = sum + 128;
		}
	}
}

// T.81's quantization tables are in zigzag order. Stored here in natural
// order, matching the coefficients.
function readQuantTables(
	data: Uint8Array,
	start: number,
	end: number,
	tables: Uint16Array[],
): void {
	let offset = start;
	while (offset < end) {
		const spec = data[offset++];
		const precision = spec >> 4;
		const table = new Uint16Array(64);
		for (let k = 0; k < 64; k++) {
			table[ZIGZAG[k]] = precision === 0
				? data[offset++]
				: (data[offset++] << 8) | data[offset++];
		}
		tables[spec & 15] = table;
	}
}

function readExifOrientation(
	data: Uint8Array,
	start: number,
	end: number,
): number {
	if (
		end - start < 14 ||
		String.fromCharCode(...data.subarray(start, start + 4)) !== "Exif"
	) {
		return 1;
	}
	const tiff = start + 6;
	const little = data[tiff] === 0x49;
	const u16 = (at: number) =>
		little ? data[at] | (data[at + 1] << 8) : (data[at] << 8) | data[at + 1];
	const u32 = (at: number) =>
		little
			? (data[at] |
				(data[at + 1] << 8) |
				(data[at + 2] << 16) |
				(data[at + 3] << 24)) >>> 0
			: readUint32(data, at);
	const ifd = tiff + u32(tiff + 4);
	if (ifd + 2 > end) {
		return 1;
	}
	const entries = u16(ifd);
	for (let i = 0; i < entries; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > end) {
			break;
		}
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

async function decodeJPEG(data: Uint8Array, deadline: number): Promise<Bitmap> {
	const pause = createYielder(deadline);
	const quantTables: Uint16Array[] = [];
	const dcTables: HuffmanTable[] = [];
	const acTables: HuffmanTable[] = [];
	let frame: JPEGFrame | null = null;
	let resetInterval = 0;
	let scans = 0;
	let adobeTransform = -1;
	let jfif = false;
	let orientation = 1;
	let offset = 2;

	while (offset < data.length) {
		if (data[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = data[offset + 1];
		offset += 2;
		if (marker === 0xd9) {
			break;
		}
		if (
			marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
		) {
			// Fill bytes and markers that carry no length.
			if (marker === 0xff) {
				offset--;
			}
			continue;
		}
		const length = (data[offset] << 8) | data[offset + 1];
		const start = offset + 2;
		const end = offset + length;
		if (end > data.length) {
			throw new Error("The JPEG data ends inside a segment");
		}
		switch (marker) {
			case 0xe0:
				jfif =
					String.fromCharCode(...data.subarray(start, start + 4)) === "JFIF";
				break;
			case 0xe1:
				orientation = readExifOrientation(data, start, end);
				break;
			case 0xee:
				if (
					String.fromCharCode(...data.subarray(start, start + 5)) === "Adobe"
				) {
					adobeTransform = data[start + 11];
				}
				break;
			case 0xdb:
				readQuantTables(data, start, end, quantTables);
				break;
			case 0xc4: {
				let at = start;
				while (at < end) {
					const spec = data[at++];
					const counts = data.subarray(at, at + 16);
					at += 16;
					const total = counts.reduce((sum, count) => sum + count, 0);
					const values = data.subarray(at, at + total);
					at += total;
					(spec >> 4 === 0 ? dcTables : acTables)[spec & 15] =
						buildHuffmanTable(counts, values);
				}
				break;
			}
			case 0xdd:
				resetInterval = (data[start] << 8) | data[start + 1];
				break;
			case 0xc0:
			case 0xc1:
			case 0xc2: {
				if (frame !== null) {
					throw new Error("The JPEG image has more than one frame");
				}
				const height = (data[start + 1] << 8) | data[start + 2];
				const width = (data[start + 3] << 8) | data[start + 4];
				const count = data[start + 5];
				checkImageSize(width, height, "JPEG");
				// Each component is a plane the size of the image, and an image
				// is gray, YCbCr or CMYK.
				if (count < 1 || count > 4) {
					throw new Error("The JPEG image has more than four components");
				}
				const components: JPEGComponent[] = [];
				let maxH = 1;
				let maxV = 1;
				for (let i = 0; i < count; i++) {
					const at = start + 6 + i * 3;
					const h = data[at + 1] >> 4 || 1;
					const v = data[at + 1] & 15 || 1;
					if (h > 4 || v > 4) {
						throw new Error("The JPEG image samples a component past four");
					}
					maxH = Math.max(maxH, h);
					maxV = Math.max(maxV, v);
					components.push({
						id: data[at],
						h,
						v,
						quantTable: data[at + 2],
						blocksPerLine: 0,
						blocksPerColumn: 0,
						blocks: new Int16Array(0),
						blocksPerLineForMcu: 0,
						dcTable: null,
						acTable: null,
						pred: 0,
					});
				}
				const mcusPerLine = Math.ceil(width / (8 * maxH));
				const mcusPerColumn = Math.ceil(height / (8 * maxV));
				for (const component of components) {
					component.blocksPerLine = Math.ceil(
						(Math.ceil((width * component.h) / maxH)) / 8,
					);
					component.blocksPerColumn = Math.ceil(
						(Math.ceil((height * component.v) / maxV)) / 8,
					);
					component.blocksPerLineForMcu = mcusPerLine * component.h;
					const blocksPerColumnForMcu = mcusPerColumn * component.v;
					component.blocks = new Int16Array(
						64 * component.blocksPerLineForMcu * blocksPerColumnForMcu,
					);
				}
				frame = {
					progressive: marker === 0xc2,
					width,
					height,
					maxH,
					maxV,
					mcusPerLine,
					mcusPerColumn,
					components,
				};
				break;
			}
			case 0xda: {
				if (frame === null) {
					throw new Error("The JPEG scan comes before its frame");
				}
				// Each scan passes over the whole image, so a file of a few
				// kilobytes could ask for any number of passes.
				if (++scans > MAX_JPEG_SCANS) {
					throw new Error(
						`The JPEG image has more than ${MAX_JPEG_SCANS} scans`,
					);
				}
				const count = data[start];
				const scanComponents: JPEGComponent[] = [];
				for (let i = 0; i < count; i++) {
					const id = data[start + 1 + i * 2];
					const tables = data[start + 2 + i * 2];
					const component = frame.components.find((c) => c.id === id);
					if (component === undefined) {
						throw new Error("The JPEG scan names a component the frame lacks");
					}
					component.dcTable = dcTables[tables >> 4] ?? null;
					component.acTable = acTables[tables & 15] ?? null;
					scanComponents.push(component);
				}
				const at = start + 1 + count * 2;
				offset = await decodeScan(
					data,
					end,
					frame,
					scanComponents,
					resetInterval,
					data[at],
					data[at + 1],
					data[at + 2] >> 4,
					data[at + 2] & 15,
					pause,
				);
				continue;
			}
			default:
				if (
					marker >= 0xc3 &&
					marker <= 0xcf &&
					marker !== 0xc4 &&
					marker !== 0xc8 &&
					marker !== 0xcc
				) {
					throw new Error("The JPEG image uses arithmetic or lossless coding");
				}
		}
		offset = end;
	}
	if (frame === null) {
		throw new Error("The JPEG image has no frame");
	}
	return orient(
		await buildJPEGBitmap(frame, quantTables, adobeTransform, jfif, pause),
		orientation,
	);
}

async function buildJPEGBitmap(
	frame: JPEGFrame,
	quantTables: Uint16Array[],
	adobeTransform: number,
	jfif: boolean,
	pause: () => Promise<void> | undefined,
): Promise<Bitmap> {
	const {width, height, components} = frame;
	// Each component's samples at its own resolution.
	const planes: Array<{
		plane: Uint8ClampedArray;
		planeWidth: number;
		planeHeight: number;
		scaleX: number;
		scaleY: number;
	}> = [];
	for (const component of components) {
		const planeWidth = component.blocksPerLineForMcu * 8;
		const rows =
			(component.blocks.length / 64 / component.blocksPerLineForMcu) * 8;
		const plane = new Uint8ClampedArray(planeWidth * rows);
		const quant = quantTables[component.quantTable];
		if (quant === undefined) {
			throw new Error("The JPEG component names a missing quantization table");
		}
		const out = new Uint8ClampedArray(64);
		const scratch = new Float32Array(64);
		const blocksPerRow = component.blocksPerLineForMcu;
		const blockRows = rows / 8;
		for (let blockRow = 0; blockRow < blockRows; blockRow++) {
			await pause();
			for (let blockCol = 0; blockCol < blocksPerRow; blockCol++) {
				inverseDCT(
					component.blocks,
					64 * (blockRow * blocksPerRow + blockCol),
					quant,
					out,
					scratch,
				);
				for (let y = 0; y < 8; y++) {
					plane.set(
						out.subarray(y * 8, y * 8 + 8),
						(blockRow * 8 + y) * planeWidth + blockCol * 8,
					);
				}
			}
		}
		planes.push({
			plane,
			planeWidth,
			planeHeight: rows,
			scaleX: component.h / frame.maxH,
			scaleY: component.v / frame.maxV,
		});
	}

	const bitmap = createBitmap(width, height);
	const data = bitmap.data;
	const count = components.length;
	// Three components are YCbCr unless Adobe says they are RGB, or their
	// ids spell R, G, B without a JFIF marker saying otherwise. Four are
	// CMYK, or YCCK when Adobe's transform is 2.
	const rgb =
		count === 3 && (
			adobeTransform === 0 ||
		(!jfif &&
			adobeTransform === -1 &&
			components[0].id === 0x52 &&
			components[1].id === 0x47 &&
			components[2].id === 0x42)
		);
	const sample = new Float32Array(4);
	// Per component, the columns a subsampled pixel interpolates between and
	// the weight of the second, which depend on x alone.
	const columns = planes.map(({planeWidth, scaleX}) => {
		const first = new Int32Array(width);
		const second = new Int32Array(width);
		const weight = new Float64Array(width);
		for (let x = 0; x < width; x++) {
			const fx = Math.max(0, (x + 0.5) * scaleX - 0.5);
			const x0 = Math.floor(fx);
			first[x] = x0;
			second[x] = Math.min(x0 + 1, planeWidth - 1);
			weight[x] = fx - x0;
		}
		return {first, second, weight};
	});
	if (
		count === 3 &&
		!rgb &&
		planes[0].scaleX === 1 &&
		planes[0].scaleY === 1 &&
		planes[1].scaleX === 0.5 &&
		planes[1].scaleY === 0.5 &&
		planes[2].scaleX === 0.5 &&
		planes[2].scaleY === 0.5
	) {
		const [luma, blue, red] = planes;
		const blueColumns = columns[1];
		const redColumns = columns[2];
		for (let y = 0; y < height; y++) {
			await pause();
			const lumaRow = y * luma.planeWidth;
			const fy = Math.max(0, (y + 0.5) * 0.5 - 0.5);
			const y0 = Math.floor(fy);
			const top = y0 * blue.planeWidth;
			const bottom = Math.min(y0 + 1, blue.planeHeight - 1) * blue.planeWidth;
			const ty = fy - y0;
			const redTop = y0 * red.planeWidth;
			const redBottom = Math.min(y0 + 1, red.planeHeight - 1) * red.planeWidth;
			let out = y * width * 4;
			for (let x = 0; x < width; x++) {
				const x0 = blueColumns.first[x];
				const x1 = blueColumns.second[x];
				const tx = blueColumns.weight[x];
				const Y = luma.plane[lumaRow + x];
				const Cb = Math.fround(
					(blue.plane[top + x0] * (1 - tx) + blue.plane[top + x1] * tx) *
							(1 - ty) +
						(blue.plane[bottom + x0] * (1 - tx) +
							blue.plane[bottom + x1] * tx) *
							ty,
				);
				const rx0 = redColumns.first[x];
				const rx1 = redColumns.second[x];
				const rtx = redColumns.weight[x];
				const Cr = Math.fround(
					(red.plane[redTop + rx0] * (1 - rtx) +
						red.plane[redTop + rx1] * rtx) *
							(1 - ty) +
						(red.plane[redBottom + rx0] * (1 - rtx) +
								red.plane[redBottom + rx1] * rtx) * ty,
				);
				data[out] = Y + 1.402 * (Cr - 128);
				data[out + 1] = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
				data[out + 2] = Y + 1.772 * (Cb - 128);
				data[out + 3] = 255;
				out += 4;
			}
		}
		return bitmap;
	}
	for (let y = 0; y < height; y++) {
		await pause();
		// Per component, the rows a subsampled pixel interpolates between.
		const rowStart: number[] = [];
		const rowNext: number[] = [];
		const rowWeight: number[] = [];
		for (let c = 0; c < count; c++) {
			const {planeWidth, planeHeight, scaleY} = planes[c];
			const fy = Math.max(0, (y + 0.5) * scaleY - 0.5);
			const y0 = Math.floor(fy);
			const y1 = Math.min(y0 + 1, planeHeight - 1);
			rowStart.push(y0 * planeWidth);
			rowNext.push(y1 * planeWidth);
			rowWeight.push(fy - y0);
		}
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < count; c++) {
				const {plane, planeWidth, scaleX, scaleY} = planes[c];
				if (scaleX === 1 && scaleY === 1) {
					sample[c] = plane[y * planeWidth + x];
					continue;
				}
				// A subsampled component is interpolated between the samples
				// around the pixel's center, as libjpeg's fancy upsampling
				// does, rather than repeated in blocks.
				const {first, second, weight} = columns[c];
				const x0 = first[x];
				const x1 = second[x];
				const tx = weight[x];
				const ty = rowWeight[c];
				const top0 = rowStart[c];
				const bottom0 = rowNext[c];
				const top = plane[top0 + x0] * (1 - tx) + plane[top0 + x1] * tx;
				const bottom =
					plane[bottom0 + x0] * (1 - tx) + plane[bottom0 + x1] * tx;
				sample[c] = top * (1 - ty) + bottom * ty;
			}
			const out = (y * width + x) * 4;
			if (count === 1) {
				data[out] = data[out + 1] = data[out + 2] = sample[0];
			} else if (count === 3) {
				if (rgb) {
					data[out] = sample[0];
					data[out + 1] = sample[1];
					data[out + 2] = sample[2];
				} else {
					const Y = sample[0];
					const Cb = sample[1];
					const Cr = sample[2];
					data[out] = Y + 1.402 * (Cr - 128);
					data[out + 1] = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
					data[out + 2] = Y + 1.772 * (Cb - 128);
				}
			} else {
				let [c, m, ye] = sample;
				const k = sample[3];
				if (adobeTransform === 2) {
					const Y = c;
					const Cb = m;
					const Cr = ye;
					c = Y + 1.402 * (Cr - 128);
					m = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
					ye = Y + 1.772 * (Cb - 128);
					c = Math.max(0, Math.min(255, c));
					m = Math.max(0, Math.min(255, m));
					ye = Math.max(0, Math.min(255, ye));
				}
				// Adobe writes CMYK inverted: 255 is no ink. YCCK's transform
				// gives the ink itself back for C, M and Y, and leaves K
				// inverted (libjpeg's ycck_cmyk_convert).
				if (adobeTransform === 2) {
					data[out] = ((255 - c) * k) / 255;
					data[out + 1] = ((255 - m) * k) / 255;
					data[out + 2] = ((255 - ye) * k) / 255;
				} else if (adobeTransform !== -1) {
					data[out] = (c * k) / 255;
					data[out + 1] = (m * k) / 255;
					data[out + 2] = (ye * k) / 255;
				} else {
					data[out] = ((255 - c) * (255 - k)) / 255;
					data[out + 1] = ((255 - m) * (255 - k)) / 255;
					data[out + 2] = ((255 - ye) * (255 - k)) / 255;
				}
			}
			data[out + 3] = 255;
		}
	}
	return bitmap;
}

// EXIF orientation, which browsers apply by default (image-orientation:
// from-image). 2 to 8 are the mirrors and quarter turns of TIFF 6.0.
function orient(bitmap: Bitmap, orientation: number): Bitmap {
	if (orientation === 1) {
		return bitmap;
	}
	const {width, height, data} = bitmap;
	const turns = orientation >= 5;
	const out = createBitmap(turns ? height : width, turns ? width : height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let tx: number;
			let ty: number;
			switch (orientation) {
				case 2:
					tx = width - 1 - x;
					ty = y;
					break;
				case 3:
					tx = width - 1 - x;
					ty = height - 1 - y;
					break;
				case 4:
					tx = x;
					ty = height - 1 - y;
					break;
				case 5:
					tx = y;
					ty = x;
					break;
				case 6:
					tx = height - 1 - y;
					ty = x;
					break;
				case 7:
					tx = height - 1 - y;
					ty = width - 1 - x;
					break;
				default:
					tx = y;
					ty = width - 1 - x;
					break;
			}
			const from = (y * width + x) * 4;
			const to = (ty * out.width + tx) * 4;
			out.data[to] = data[from];
			out.data[to + 1] = data[from + 1];
			out.data[to + 2] = data[from + 2];
			out.data[to + 3] = data[from + 3];
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// GIF: the first frame, over the logical screen, with its transparent
// color. An animated GIF shows its first frame, as it does in a browser
// that has animation turned off.

function decodeGIF(data: Uint8Array): Bitmap {
	const u16 = (at: number) => data[at] | (data[at + 1] << 8);
	const width = u16(6);
	const height = u16(8);
	const packed = data[10];
	let offset = 13;
	let globalTable: Uint8Array | null = null;
	if (packed & 0x80) {
		const size = 3 * (1 << ((packed & 7) + 1));
		globalTable = data.subarray(offset, offset + size);
		offset += size;
	}
	let transparentIndex = -1;
	while (offset < data.length) {
		const block = data[offset++];
		if (block === 0x3b) {
			break;
		}
		if (block === 0x21) {
			const label = data[offset++];
			if (label === 0xf9 && data[offset] >= 4) {
				if (data[offset + 1] & 1) {
					transparentIndex = data[offset + 4];
				}
			}
			while (data[offset] !== 0 && offset < data.length) {
				offset += data[offset] + 1;
			}
			offset++;
			continue;
		}
		if (block !== 0x2c) {
			throw new Error("The GIF data has an unknown block");
		}
		const left = u16(offset);
		const top = u16(offset + 2);
		const frameWidth = u16(offset + 4);
		const frameHeight = u16(offset + 6);
		const flags = data[offset + 8];
		offset += 9;
		let table = globalTable;
		if (flags & 0x80) {
			const size = 3 * (1 << ((flags & 7) + 1));
			table = data.subarray(offset, offset + size);
			offset += size;
		}
		if (table === null) {
			throw new Error("The GIF image has no color table");
		}
		checkImageSize(frameWidth, frameHeight, "GIF");
		checkImageSize(width || frameWidth, height || frameHeight, "GIF");
		const minCodeSize = data[offset++];
		if (minCodeSize < 2 || minCodeSize > 8) {
			throw new Error("The GIF frame's code size is not 2 to 8 bits");
		}
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (offset < data.length && data[offset] !== 0) {
			const size = data[offset++];
			const chunk = data.subarray(offset, offset + size);
			chunks.push(chunk);
			length += chunk.length;
			offset += size;
		}
		const joined = new Uint8Array(length);
		let at = 0;
		for (const chunk of chunks) {
			joined.set(chunk, at);
			at += chunk.length;
		}
		const indices = decodeLZW(joined, minCodeSize, frameWidth * frameHeight);
		const bitmap = createBitmap(width || frameWidth, height || frameHeight);
		const interlaced = (flags & 0x40) !== 0;
		const rowOrder = interlaced ? interlacedRows(frameHeight) : null;
		for (let i = 0; i < indices.length; i++) {
			const index = indices[i];
			if (index === transparentIndex) {
				continue;
			}
			const row = Math.floor(i / frameWidth);
			const y = top + (rowOrder ? rowOrder[row] : row);
			const x = left + (i % frameWidth);
			if (x >= bitmap.width || y >= bitmap.height) {
				continue;
			}
			const out = (y * bitmap.width + x) * 4;
			bitmap.data[out] = table[index * 3];
			bitmap.data[out + 1] = table[index * 3 + 1];
			bitmap.data[out + 2] = table[index * 3 + 2];
			bitmap.data[out + 3] = 255;
		}
		return bitmap;
	}
	throw new Error("The GIF image has no frame");
}

// The row each decoded row of an interlaced GIF lands on.
function interlacedRows(height: number): number[] {
	const rows: number[] = [];
	for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
		for (let y = start; y < height; y += step) {
			rows.push(y);
		}
	}
	return rows;
}

function decodeLZW(
	data: Uint8Array,
	minCodeSize: number,
	count: number,
): Uint8Array {
	const out = new Uint8Array(count);
	const clear = 1 << minCodeSize;
	const end = clear + 1;
	const prefix = new Int16Array(4096);
	const suffix = new Uint8Array(4096);
	const stack = new Uint8Array(4097);
	let codeSize = minCodeSize + 1;
	let next = clear + 2;
	let previous = -1;
	let first = 0;
	let bitBuffer = 0;
	let bits = 0;
	let at = 0;
	let written = 0;
	for (let i = 0; i < clear; i++) {
		prefix[i] = -1;
		suffix[i] = i;
	}
	while (written < count) {
		while (bits < codeSize) {
			if (at >= data.length) {
				return out;
			}
			bitBuffer |= data[at++] << bits;
			bits += 8;
		}
		const code = bitBuffer & ((1 << codeSize) - 1);
		bitBuffer >>= codeSize;
		bits -= codeSize;
		if (code === clear) {
			codeSize = minCodeSize + 1;
			next = clear + 2;
			previous = -1;
			continue;
		}
		if (code === end) {
			break;
		}
		let top = 0;
		let current = code;
		if (previous === -1) {
			out[written++] = suffix[code];
			first = suffix[code];
			previous = code;
			continue;
		}
		if (code >= next) {
			stack[top++] = first;
			current = previous;
		}
		while (current >= clear) {
			stack[top++] = suffix[current];
			current = prefix[current];
		}
		first = suffix[current];
		stack[top++] = first;
		while (top > 0 && written < count) {
			out[written++] = stack[--top];
		}
		if (next < 4096) {
			prefix[next] = previous;
			suffix[next] = first;
			next++;
			if (next === 1 << codeSize && codeSize < 12) {
				codeSize++;
			}
		}
		previous = code;
	}
	return out;
}

// ---------------------------------------------------------------------------
// BMP: uncompressed 1, 4, 8, 16, 24 and 32 bits, bitfields, and RLE4
// and RLE8.

function decodeBMP(data: Uint8Array): Bitmap {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const pixelOffset = view.getUint32(10, true);
	const headerSize = view.getUint32(14, true);
	const width = view.getInt32(18, true);
	const rawHeight = view.getInt32(22, true);
	const bits = view.getUint16(28, true);
	const compression = headerSize >= 40 ? view.getUint32(30, true) : 0;
	const height = Math.abs(rawHeight);
	const bottomUp = rawHeight > 0;
	checkImageSize(width, height, "BMP");
	const rle =
		(compression === 1 && bits === 8) || (compression === 2 && bits === 4);
	if (compression !== 0 && compression !== 3 && !rle) {
		throw new Error("The BMP image uses a compression this decoder lacks");
	}
	let masks = bits === 16
		? [0x7c00, 0x03e0, 0x001f, 0]
		: [0x00ff0000, 0x0000ff00, 0x000000ff, bits === 32 ? 0xff000000 : 0];
	if (compression === 3) {
		masks = [
			view.getUint32(54, true),
			view.getUint32(58, true),
			view.getUint32(62, true),
			headerSize >= 56 ? view.getUint32(66, true) : 0,
		];
	}
	const paletteStart = 14 + headerSize;
	const colors = bits <= 8
		? (headerSize >= 40 && view.getUint32(46, true)) || 1 << bits
		: 0;
	const stride = Math.ceil((width * bits) / 32) * 4;
	if (!rle && pixelOffset + stride * height > data.length) {
		throw new Error("The BMP image ends before its pixels do");
	}
	const bitmap = createBitmap(width, height);
	const channel = (value: number, mask: number): number => {
		if (mask === 0) {
			return 255;
		}
		let shift = 0;
		while (((mask >>> shift) & 1) === 0) {
			shift++;
		}
		const max = mask >>> shift;
		return Math.round((((value & mask) >>> shift) * 255) / max);
	};
	if (rle) {
		const indices = decodeBMPRunLengths(data, pixelOffset, width, height, bits);
		for (let y = 0; y < height; y++) {
			const row = bottomUp ? height - 1 - y : y;
			for (let x = 0; x < width; x++) {
				const index = indices[row * width + x];
				const out = (y * width + x) * 4;
				const entry = paletteStart + Math.min(index, colors - 1) * 4;
				bitmap.data[out] = data[entry + 2];
				bitmap.data[out + 1] = data[entry + 1];
				bitmap.data[out + 2] = data[entry];
				bitmap.data[out + 3] = 255;
			}
		}
		return bitmap;
	}
	// A 32-bit BMP that never sets alpha means opaque.
	let anyAlpha = false;
	for (let y = 0; y < height; y++) {
		const row = pixelOffset + (bottomUp ? height - 1 - y : y) * stride;
		for (let x = 0; x < width; x++) {
			const out = (y * width + x) * 4;
			if (bits <= 8) {
				const bit = x * bits;
				const index =
					(data[row + (bit >> 3)] >> (8 - bits - (bit & 7))) &
					((1 << bits) - 1);
				const entry = paletteStart + Math.min(index, colors - 1) * 4;
				bitmap.data[out] = data[entry + 2];
				bitmap.data[out + 1] = data[entry + 1];
				bitmap.data[out + 2] = data[entry];
				bitmap.data[out + 3] = 255;
			} else if (bits === 24) {
				const at = row + x * 3;
				bitmap.data[out] = data[at + 2];
				bitmap.data[out + 1] = data[at + 1];
				bitmap.data[out + 2] = data[at];
				bitmap.data[out + 3] = 255;
			} else {
				const value = bits === 16
					? view.getUint16(row + x * 2, true)
					: view.getUint32(row + x * 4, true);
				bitmap.data[out] = channel(value, masks[0]);
				bitmap.data[out + 1] = channel(value, masks[1]);
				bitmap.data[out + 2] = channel(value, masks[2]);
				bitmap.data[out + 3] = channel(value, masks[3]);
				if (masks[3] !== 0 && (value & masks[3]) !== 0) {
					anyAlpha = true;
				}
			}
		}
	}
	if (masks[3] !== 0 && !anyAlpha && bits > 8) {
		for (let i = 3; i < bitmap.data.length; i += 4) {
			bitmap.data[i] = 255;
		}
	}
	return bitmap;
}

// RLE8 and RLE4: palette indices in file order, bottom row first.
function decodeBMPRunLengths(
	data: Uint8Array,
	start: number,
	width: number,
	height: number,
	bits: number,
): Uint8Array {
	const indices = new Uint8Array(width * height);
	let x = 0;
	let y = 0;
	let at = start;
	const put = (index: number) => {
		if (x < width && y < height) {
			indices[y * width + x] = index;
		}
		x++;
	};
	while (at + 1 < data.length && y < height) {
		const count = data[at++];
		const value = data[at++];
		if (count > 0) {
			for (let i = 0; i < count; i++) {
				put(bits === 8 ? value : i % 2 === 0 ? value >> 4 : value & 15);
			}
			continue;
		}
		if (value === 0) {
			x = 0;
			y++;
		} else if (value === 1) {
			break;
		} else if (value === 2) {
			x += data[at++];
			y += data[at++];
		} else {
			// An absolute run, padded to a whole 16-bit word.
			const bytes = bits === 8 ? value : Math.ceil(value / 2);
			for (let i = 0; i < value; i++) {
				const byte = data[at + (bits === 8 ? i : i >> 1)];
				put(bits === 8 ? byte : i % 2 === 0 ? byte >> 4 : byte & 15);
			}
			at += bytes + (bytes & 1);
		}
	}
	return indices;
}
