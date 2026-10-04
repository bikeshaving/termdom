/**
 * The thread images decode on. It takes `{id, bytes}` and answers
 * `{id, width, height, data}` with the pixels' buffer transferred, or
 * `{id, error}`. It answers `{ready: true}` first, so the page can tell
 * a worker that never started from one that failed on an image.
 *
 * A web worker answers through its global scope. Node's worker_threads
 * answer through parentPort.
 */
import {decodeImage} from "./internal/images.ts";

interface Port {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	on?(type: "message", listener: (data: unknown) => void): void;
	addEventListener?(
		type: "message",
		listener: (event: {data: unknown}) => void,
	): void;
}

interface WorkerThreads {
	parentPort?: Port | null;
}

interface NodeProcess {
	getBuiltinModule?(id: string): WorkerThreads | undefined;
}

function getNodeParent(): Port | null {
	const process = (globalThis as {process?: NodeProcess}).process;
	if (process?.getBuiltinModule === undefined) {
		return null;
	}
	return process.getBuiltinModule("node:worker_threads")?.parentPort ?? null;
}

const nodeParent = getNodeParent();
const port: Port = nodeParent ?? (globalThis as unknown as Port);

async function answer(data: unknown): Promise<void> {
	const {id, bytes} = data as {id: number; bytes: ArrayBuffer};
	try {
		const bitmap = await decodeImage(new Uint8Array(bytes));
		const pixels = bitmap.data.buffer as ArrayBuffer;
		port.postMessage(
			{id, width: bitmap.width, height: bitmap.height, data: pixels},
			[pixels],
		);
	} catch (error) {
		port.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

if (nodeParent !== null) {
	nodeParent.on!("message", (data) => {
		answer(data).catch(() => {});
	});
} else {
	port.addEventListener!("message", (event) => {
		answer(event.data).catch(() => {});
	});
}
port.postMessage({ready: true});
