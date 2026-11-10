/**
 * What an isolated frame asks of the process that hosts it. The isolate
 * has no timers, randomness, network or output of its own, so each of
 * these is a plain callback the backend provides when it loads the
 * runtime. Messages are plain values and typed arrays, so any backend
 * that copies structured data can carry them.
 */
import type {FrameMessage} from "../isolateprotocol.ts";
import type {ScriptItem} from "./scripts.ts";

export type {
	FrameInit,
	FrameMessage,
	FrameRequest,
	FrameResponse,
	HostMessage,
} from "../isolateprotocol.ts";

export interface IsolateHost {
	post(message: FrameMessage): void;
	log(level: string, text: string): void;
	setTimer(id: number, ms: number): void;
	clearTimer(id: number): void;
	random(length: number): Uint8Array;
	// The scripts the document holds, or that were added to it, for the
	// backend to fetch, compile and run in order.
	scripts(initial: boolean, items: ScriptItem[]): void;
}

function missing(): never {
	throw new Error("The isolate runtime has no host yet.");
}

export const host: IsolateHost = {
	post: missing,
	log: missing,
	setTimer: missing,
	clearTimer: missing,
	random: missing,
	scripts: missing,
};

export function setHost(next: IsolateHost): void {
	host.post = (message) => next.post(message);
	host.log = (level, text) => next.log(level, text);
	host.setTimer = (id, ms) => next.setTimer(id, ms);
	host.clearTimer = (id) => next.clearTimer(id);
	host.random = (length) => next.random(length);
	host.scripts = (initial, items) => next.scripts(initial, items);
}
