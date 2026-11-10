/**
 * What passes between a page and a frame whose document is in another
 * isolate. The page draws the frame's box with the cells the frame
 * paints, and hands it input, its size and messages. Each message is
 * plain data and typed arrays, so any isolate a backend makes can carry
 * it: isolated-vm's, a Worker's, or QuickJS's.
 */
import type {
	ColorDepth,
	WireFocus,
	WireKey,
	WireMouse,
	WirePaste,
} from "./exchange.ts";
import type {Caret, GridCells} from "./framebuffer.ts";

/** A frame's document and the terminal it is drawn for. */
export interface FrameInit {
	url: string;
	html: string;
	// The origin of the window the frame's iframe is in, which the frame's
	// parent and top have.
	parentOrigin: string;
	cols: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	pixelRatio: number;
	colorDepth: ColorDepth;
	colorScheme: "light" | "dark";
	reducedMotion: boolean;
	scripting: boolean;
}

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

export type FrameMessage =
	{type: "paint"; cells: GridCells; caret: Caret | null} |
	{type: "title"; title: string} |
	// The frame went to another document, or sent its parent to one.
	// A form's POST carries its method, its encoded fields and their type.
	{
		type: "navigate";
		target: "self" | "parent";
		url: string;
		method?: string;
		body?: Uint8Array | null;
		contentType?: string;
	} |
	// The frame's document changed its URL in place: pushState,
	// replaceState or a fragment.
	{type: "history"; url: string; replace: boolean} |
	{type: "load"} |
	{type: "message"; data: unknown; targetOrigin: string} |
	{type: "fetch"; id: number; request: FrameRequest} |
	{type: "abortFetch"; id: number} |
	// The frame ran past its time or memory, or failed to start, and its
	// isolate is gone.
	{type: "crash"; reason: string};

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

/** A frame running in an isolate, as its page holds it. */
export interface IsolatedFrame {
	send(message: HostMessage): void;
	dispose(): void;
}

/**
 * Starts a frame in an isolate of its own. What the frame sends arrives
 * through `receive`, never during the call that made the frame.
 */
export type FrameIsolator = (
	init: FrameInit,
	receive: (message: FrameMessage) => void,
) => IsolatedFrame;
