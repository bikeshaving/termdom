/**
 * The thread images decode on, started as a web Worker. It takes
 * `{id, bytes}`, or `{id, drawing}` for an SVG the page has read, and
 * answers `{id, width, height, naturalWidth,
 * naturalHeight, data, full}` with the pixels' buffers transferred: those
 * kept to draw cells from, at most MAX_KEPT_PIXELS, and the full ones
 * when those are fewer. Or it answers `{id, error}`. It answers
 * `{ready: true}` first, so the page can tell a worker that never started
 * from one that failed on an image.
 */
import {
	decodeImageForPage,
	rasterizeDrawingForPage,
} from "./internal/images.ts";
import type {SVGDrawing} from "./internal/svgraster.ts";

interface WorkerScope {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: {data: unknown}) => void,
	): void;
}

const scope = globalThis as unknown as WorkerScope;

async function answer(data: unknown): Promise<void> {
	const {id, bytes, drawing} = data as {
		id: number;
		bytes?: ArrayBuffer;
		drawing?: SVGDrawing;
	};
	try {
		const bitmap = drawing === undefined
			? await decodeImageForPage(new Uint8Array(bytes!))
			: await rasterizeDrawingForPage(drawing);
		const pixels = bitmap.data.buffer as ArrayBuffer;
		const full = bitmap.full?.buffer as ArrayBuffer | undefined;
		scope.postMessage({
			id,
			width: bitmap.width,
			height: bitmap.height,
			naturalWidth: bitmap.naturalWidth,
			naturalHeight: bitmap.naturalHeight,
			data: pixels,
			full,
		}, full === undefined ? [pixels] : [pixels, full]);
	} catch (error) {
		scope.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

scope.addEventListener("message", (event) => {
	answer(event.data).catch(() => {});
});
scope.postMessage({ready: true});
