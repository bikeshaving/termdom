/**
 * The thread images decode on, started as a web Worker. It takes
 * `{id, bytes}` and answers `{id, width, height, naturalWidth,
 * naturalHeight, data}` with the pixels' buffer transferred, kept at most
 * MAX_KEPT_PIXELS, or `{id, error}`. It answers `{ready: true}` first, so
 * the page can tell a worker that never started from one that failed on
 * an image.
 */
import {decodeImageForPage} from "./internal/images.ts";

interface WorkerScope {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: {data: unknown}) => void,
	): void;
}

const scope = globalThis as unknown as WorkerScope;

async function answer(data: unknown): Promise<void> {
	const {id, bytes} = data as {id: number; bytes: ArrayBuffer};
	try {
		const bitmap = await decodeImageForPage(new Uint8Array(bytes));
		const pixels = bitmap.data.buffer as ArrayBuffer;
		scope.postMessage(
			{
				id,
				width: bitmap.width,
				height: bitmap.height,
				naturalWidth: bitmap.naturalWidth,
				naturalHeight: bitmap.naturalHeight,
				data: pixels,
			},
			[pixels],
		);
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
