#!/usr/bin/env node
// The trace hook and the state snapshot, driven headless: a scripted scene
// runs against an in-memory terminal, every event the engine reports is
// written to a file as NDJSON, and the run prints a two-line summary.
//
// This is the debugging harness -- no tmux, no real tty, nothing to attach
// to. Run it and grep the log for the fact you are after:
//
//   node examples/trace.ts
//   TERMDOM_TRACE=/tmp/run.ndjson node examples/trace.ts
//   grep '"frame.transformed"' /tmp/run.ndjson
//   grep '"frame.skipped"' /tmp/run.ndjson | grep unchanged
import {TermDOM, type TerminalTransport, type TraceEvent} from "@b9g/termdom";
import {writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const path =
	process.env.TERMDOM_TRACE ?? join(tmpdir(), "termdom-trace.ndjson");

/** The headless terminal below, and the two ways a scene drives it. */
interface HeadlessTerminal {
	transport: TerminalTransport;
	type(text: string): void;
	resize(cols: number, rows: number): void;
}

/**
 * A terminal with nobody at the other end: keystrokes go in through `type`,
 * frames go nowhere, and `resize` moves the size the engine reads. Interactive
 * on purpose -- the frame pipeline, the modes and the scroll bands are what
 * this is here to show.
 */
function headlessTerminal(cols: number, rows: number): HeadlessTerminal {
	const size = {cols, rows};
	let keys!: ReadableStreamDefaultController<string>;
	let sizes!: ReadableStreamDefaultController<{cols: number; rows: number}>;
	const transport: TerminalTransport = {
		get cols() {
			return size.cols;
		},
		get rows() {
			return size.rows;
		},
		colorDepth: "rgb",
		interactive: true,
		sharesScreen: false,
		readable: new ReadableStream<string>({
			start(controller) {
				keys = controller;
			},
		}),
		writable: new WritableStream<string>({write() {}}),
		resizes: new ReadableStream<{cols: number; rows: number}>({
			start(controller) {
				sizes = controller;
			},
		}),
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		close() {},
	};
	return {
		transport,
		type: (text: string) => keys.enqueue(text),
		resize: (nextCols: number, nextRows: number) => {
			size.cols = nextCols;
			size.rows = nextRows;
			sizes.enqueue({cols: nextCols, rows: nextRows});
		},
	};
}

const lines: string[] = [];
const counts = new Map<string, number>();
let wireWrites = 0;
let wireBytes = 0;

const terminal = headlessTerminal(40, 12);
const dom = new TermDOM({
	transport: terminal.transport,
	trace: (event: TraceEvent) => {
		lines.push(JSON.stringify(event));
		counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
		if (event.type === "wire.write") {
			wireWrites++;
			wireBytes += event.bytes;
		}
	},
});

const rows = Array.from(
	{length: 40},
	(_, i) => `<div>row ${i}</div>`,
).join("");
const {document} = dom;
document.body.innerHTML =
	"<div id=\"head\">TRACE DEMO</div>" +
	`<div id="pane" style="height:8em;overflow-y:scroll">${rows}</div>` +
	"<input id=\"field\" value=\"\">" +
	"<div id=\"foot\">FOOTER</div>";

function frame(): Promise<void> {
	return new Promise<void>((resolve) => {
		dom.window.requestAnimationFrame(() => resolve());
	});
}

function settle(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

await dom.attach();
await frame();

// A mutation: one frame's worth of repaint.
document.getElementById("head")!.textContent = "TRACE DEMO -- mutated";
await frame();

// Typing: decoded input items, and the frames they cause.
(document.getElementById("field") as HTMLInputElement).focus();
terminal.type("hello");
await frame();

// A scroll box moving is a band the terminal shifts for us.
document.getElementById("pane")!.scrollTop = 4;
await frame();

// A resize, coalesced by the engine's own debounce.
terminal.resize(50, 14);
await settle(200);

// The alternate screen, in and out.
await document.getElementById("head")!.requestFullscreen();
await frame();
const inFullscreen = dom.snapshot();
await document.exitFullscreen();
await frame();

const before = dom.snapshot();
await dom.dispose();

writeFileSync(path, lines.join("\n") + "\n");

const tally = (name: string) => counts.get(name) ?? 0;
console.log(
	`${lines.length} events -> ${path} · ` +
	`${tally("frame.repainted")} repainted, ` +
	`${tally("frame.transformed")} transformed, ` +
	`${tally("frame.skipped")} skipped · ` +
	`${wireWrites} writes, ${wireBytes} bytes`,
);
console.log(
	`snapshot: ${before.cols}x${before.rows} at scrollTop ${before.scrollTop}, ` +
	`region top ${before.screenTop}, ${before.lifecycle}, ` +
	`modes [${before.modes.join(" ")}], ` +
	`fullscreen was ${inFullscreen.fullscreenElement}, ` +
	`screen ${before.screen.split("\n").length - 1} rows`,
);
