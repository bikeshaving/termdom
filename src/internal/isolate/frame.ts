/**
 * A frame's document shown from an isolate of its own. The page that
 * holds the iframe lives in another heap, so the frame paints into cells
 * and posts them, and everything it hears, from keys to messages and
 * responses, arrives through receive().
 */
import "./install.ts";
import "../frames.ts";

import {Cascade} from "../cssom.ts";
import type {Document, Window} from "../dom.ts";
import {Exchange, type TerminalTransport} from "../exchange.ts";
import {exportGrid, Framebuffer} from "../framebuffer.ts";
import {createFrameEngine} from "../frames.ts";
import {dispatchInput, Input, resolvePendingHover} from "../input.ts";
import {Layout} from "../layout.ts";
import {_} from "../slots.ts";
import {createWindow} from "../window.ts";
import {
	type FrameInit,
	host,
	type HostMessage,
	type IsolateHost,
	setHost,
} from "./host.ts";
import {deliverError, deliverResponse} from "./network.ts";
import {fireTimer, queueTask} from "./timers.ts";

export {fireTimer};

function nullTransport(cols: number, rows: number): TerminalTransport {
	return {
		cols,
		rows,
		readable: new ReadableStream<string>(),
		writable: new WritableStream<string>(),
		resizes: new ReadableStream(),
		sharesScreen: false,
		interactive: false,
		ready: Promise.resolve(),
		closed: new Promise<never>(() => {}),
		close() {},
	};
}

interface Frame {
	receive(message: HostMessage): void;
	dispose(): void;
}

let frame: Frame | null = null;

export function start(callbacks: IsolateHost, init: FrameInit): void {
	if (frame !== null) {
		throw new Error("This isolate already shows a frame.");
	}
	setHost(callbacks);
	frame = createFrame(init);
}

export function receive(message: HostMessage): void {
	frame?.receive(message);
}

export function dispose(): void {
	frame?.dispose();
	frame = null;
}

function createFrame(init: FrameInit): Frame {
	let {cols, rows, cellWidth, cellHeight, pixelRatio} = init;
	const window = createWindow(
		init.html,
		init.url,
		"text/html",
		init.scripting,
	) as unknown as Window;
	const document = window.document as unknown as Document;
	const parent = createWindow(
		"<!DOCTYPE html><html><head></head><body></body></html>",
		`${init.parentOrigin}/`,
	) as unknown as Window;
	_(window).parentWindow = parent;

	let queued = false;
	let disposed = false;
	let title = "";
	let loaded = false;
	const schedule = (): void => {
		if (queued || disposed) {
			return;
		}
		queued = true;
		queueTask(paint);
	};

	const exchange = createExchange(parent, init);
	const loads = new AbortController();
	const engine = createFrameEngine(
		document,
		window,
		{
			colorDepth: init.colorDepth,
			exchange,
			cellSize: {width: cellWidth, height: cellHeight},
			devicePixelRatio: pixelRatio,
			images: "cells",
			canvas: "cells",
			load: (request) => fetch(request),
			loadSignal: loads.signal,
			reportUncaught: (error) => {
				host.log("error", `Uncaught ${describe(error)}`);
			},
			cellPixels: () => ({
				width: Math.round(cellWidth * pixelRatio),
				height: Math.round(cellHeight * pixelRatio),
			}),
			pixelRatio: () => pixelRatio,
		},
		schedule,
	);
	const extra = _(document).extra;
	extra.framebuffer.measurer = exchange;
	const input = new Input(
		document as unknown as globalThis.Document,
		extra.layout,
		extra.cascade,
		extra.framebuffer,
		() => {},
	);

	for (const [
		target,
		view,
	] of [["self", window], ["parent", parent]] as const) {
		view.navigation.addEventListener("navigate", (event) => {
			const navigate = event as NavigateEvent;
			if (navigate.hashChange || !navigate.cancelable) {
				return;
			}
			navigate.preventDefault();
			host.post({type: "navigate", target, url: navigate.destination.url});
		});
	}
	// The frame's postMessage to its parent lands on the stand-in, past the
	// targetOrigin check, and goes on to the page.
	parent.addEventListener("message", (event) => {
		host.post({
			type: "message",
			data: (event as MessageEvent).data,
			targetOrigin: init.parentOrigin,
		});
	});

	schedule();

	function paint(): void {
		queued = false;
		if (disposed) {
			return;
		}
		resolvePendingHover(input);
		const grid = engine.fit(cols, rows);
		host.post({type: "paint", cells: exportGrid(grid), caret: engine.caret});
		if (document.title !== title) {
			title = document.title;
			host.post({type: "title", title});
		}
		if (!loaded) {
			loaded = true;
			host.post({type: "load"});
		}
	}

	return {
		receive(message) {
			if (disposed) {
				return;
			}
			switch (message.type) {
				case "resize":
					cols = message.cols;
					rows = message.rows;
					cellWidth = message.cellWidth;
					cellHeight = message.cellHeight;
					pixelRatio = message.pixelRatio;
					schedule();
					return;
				case "input":
					dispatchInput(input, message.item);
					schedule();
					return;
				case "message": {
					const target = message.targetOrigin;
					if (
						target !== "*" &&
						target !== window.origin &&
						!(target === "/" && message.origin === window.origin)
					) {
						return;
					}
					const view = window as unknown as typeof globalThis;
					view.dispatchEvent(
						new view.MessageEvent("message", {
							data: message.data,
							origin: message.origin,
							source: view.parent,
						}),
					);
					return;
				}
				case "response":
					deliverResponse(message.id, message.response);
					return;
				case "fetchError":
					deliverError(message.id, message.message);
					return;
			}
		},
		dispose() {
			disposed = true;
			loads.abort();
			engine.dispose();
		},
	};
}

// The terminal a frame's engine is told about. In a page, a frame shares
// the exchange of the document its iframe is in. Here that document is
// the blank one standing in for the page, on a transport that writes
// nowhere and asks the terminal nothing.
function createExchange(window: Window, init: FrameInit): Exchange {
	const layout = new Layout(window, init.cols, init.rows);
	const cascade = new Cascade(window, layout);
	const framebuffer = new Framebuffer(init.rows, init.cols, init.colorDepth);
	return new Exchange(
		nullTransport(init.cols, init.rows),
		window,
		layout,
		cascade,
		framebuffer,
		init.colorScheme,
	);
}

function describe(error: unknown): string {
	return error instanceof Error
		? error.stack ?? `${error.name}: ${error.message}`
		: String(error);
}
