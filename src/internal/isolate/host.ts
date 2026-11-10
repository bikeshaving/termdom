/**
 * What an isolated frame asks of the process that hosts it. The isolate
 * has no timers, randomness, network or output of its own, so each of
 * these is a plain callback the backend provides when it loads the
 * runtime. Messages are plain values and typed arrays, so any backend
 * that copies structured data can carry them.
 */
import type {
	ColorDepth,
	WireFocus,
	WireKey,
	WireMouse,
	WirePaste,
} from "../exchange.ts";
import type {GridCells} from "../framebuffer.ts";
import type {ScriptItem} from "./scripts.ts";

export interface FrameRequest {
	url: string;
	method: string;
	headers: Array<[string, string]>;
	body: Uint8Array | null;
	redirect: RequestRedirect;
	destination: string;
	referrer: string;
}

export interface FrameResponse {
	url: string;
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	redirected: boolean;
	body: Uint8Array | null;
}

export interface FrameCaret {
	col: number;
	row: number;
	shape: number;
	color: number | null;
}

export type FrameMessage =
	{type: "paint"; cells: GridCells; caret: FrameCaret | null} |
	{type: "title"; title: string} |
	{type: "navigate"; target: "self" | "parent"; url: string} |
	{type: "load"} |
	{type: "message"; data: unknown; targetOrigin: string} |
	{type: "fetch"; id: number; request: FrameRequest} |
	{type: "abortFetch"; id: number};

export interface FrameInit {
	url: string;
	html: string;
	parentOrigin: string;
	cols: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	pixelRatio: number;
	colorDepth: ColorDepth;
	colorScheme: "light" | "dark";
	scripting: boolean;
}

export type HostMessage =
	{
		type: "resize";
		cols: number;
		rows: number;
		cellWidth: number;
		cellHeight: number;
		pixelRatio: number;
	} |
	{type: "input"; item: WireKey[] | WireMouse | WirePaste | WireFocus} |
	{type: "message"; data: unknown; origin: string; targetOrigin: string} |
	{type: "response"; id: number; response: FrameResponse} |
	{type: "fetchError"; id: number; message: string};

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
