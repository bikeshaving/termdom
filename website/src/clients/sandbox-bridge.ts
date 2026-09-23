/**
 * A TerminalTransport carried over a message port, so a program can run in
 * a worker while the emulator it draws on stays in the page. The page holds
 * the real transport and pumps its streams into messages; the worker holds
 * a transport whose streams are those messages. Frame ordering rests on a
 * write resolving once the emulator has parsed it, so a write is answered.
 */
import type {
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
} from "../../../src/index.ts";

/** Page to worker. */
export type HostMessage =
	| {type: "data"; text: string}
	| {type: "resize"; cols: number; rows: number}
	| {type: "written"; id: number}
	| {type: "closed"; info: TerminalCloseInfo};

/** Worker to page. */
export type WorkerMessage =
	| {type: "write"; id: number; text: string; height: number | null}
	| {type: "close"; info: TerminalCloseInfo}
	| {type: "error"; message: string};

/** The part of a Worker or a MessagePort the bridge uses. */
export interface Port {
	postMessage(message: unknown): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
}

/**
 * The page's end: reads the transport's input and resizes into messages,
 * and writes what the worker sends. `onheight` hears the rows the
 * program's document takes, which the worker reports with each write.
 */
export function hostTransport(
	transport: TerminalTransport,
	port: Port,
	onheight: (rows: number) => void,
): {stop(): void} {
	const writer = transport.writable.getWriter();
	const reader = transport.readable.getReader();
	const resizeReader = transport.resizes.getReader();
	let stopped = false;

	void (async () => {
		for (;;) {
			const {value, done} = await reader.read();
			if (done || stopped) return;
			port.postMessage({type: "data", text: value} satisfies HostMessage);
		}
	})().catch(() => {});
	void (async () => {
		for (;;) {
			const {value, done} = await resizeReader.read();
			if (done || stopped) return;
			port.postMessage({type: "resize", ...value} satisfies HostMessage);
		}
	})().catch(() => {});

	const onmessage = (event: MessageEvent): void => {
		const message = event.data as WorkerMessage;
		if (stopped || typeof message !== "object" || message === null) return;
		if (message.type === "write") {
			if (message.height !== null) onheight(message.height);
			void writer.write(message.text).then(
				() =>
					port.postMessage(
						{type: "written", id: message.id} satisfies HostMessage,
					),
				() => {},
			);
		} else if (message.type === "close") {
			transport.close(message.info);
		}
	};
	port.addEventListener("message", onmessage);

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			port.removeEventListener("message", onmessage);
			void reader.cancel().catch(() => {});
			void resizeReader.cancel().catch(() => {});
			writer.releaseLock();
		},
	};
}

/**
 * The worker's end: a transport whose input, resizes and acknowledgements
 * arrive as messages, and whose writes leave as them. `measure` answers
 * the rows the document takes, sent along with each write so the page can
 * size its pane to the program.
 */
export function workerTransport(
	port: Port,
	size: TerminalSize,
	measure: () => number | null,
): TerminalTransport {
	let {cols, rows} = size;
	let nextId = 1;
	const pending = new Map<number, () => void>();
	let input!: ReadableStreamDefaultController<string>;
	let resizes!: ReadableStreamDefaultController<TerminalSize>;
	let closeSession!: (info: TerminalCloseInfo) => void;
	const closed = new Promise<TerminalCloseInfo>((resolve) => {
		closeSession = resolve;
	});

	port.addEventListener("message", (event: MessageEvent) => {
		const message = event.data as HostMessage;
		if (typeof message !== "object" || message === null) return;
		switch (message.type) {
			case "data":
				input.enqueue(message.text);
				break;
			case "resize":
				cols = message.cols;
				rows = message.rows;
				resizes.enqueue({cols, rows});
				break;
			case "written": {
				const resolve = pending.get(message.id);
				pending.delete(message.id);
				resolve?.();
				break;
			}
			case "closed":
				closeSession(message.info);
				break;
		}
	});

	return {
		get cols() {
			return cols;
		},
		get rows() {
			return rows;
		},
		colorDepth: "rgb",
		sharesScreen: false,
		interactive: true,
		ready: Promise.resolve(),
		closed,
		readable: new ReadableStream<string>(
			{
				start(controller) {
					input = controller;
				},
			},
			{highWaterMark: 0},
		),
		resizes: new ReadableStream<TerminalSize>(
			{
				start(controller) {
					resizes = controller;
				},
			},
			{highWaterMark: 0},
		),
		writable: new WritableStream<string>({
			write: (text) =>
				new Promise<void>((resolve) => {
					const id = nextId++;
					pending.set(id, resolve);
					port.postMessage(
						{type: "write", id, text, height: measure()} satisfies WorkerMessage,
					);
				}),
		}),
		close(info: TerminalCloseInfo = {}) {
			port.postMessage({type: "close", info} satisfies WorkerMessage);
		},
	};
}
