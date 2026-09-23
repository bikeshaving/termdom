/**
 * The examples page: an editor, a terminal, and TermDOM running between them in
 * the reader's own browser. Nothing here talks to a server -- the code in the
 * editor is compiled and run on the page it is typed on.
 */
import {Copy, jsx} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank";
import {renderer} from "@b9g/crank/dom";
import {css} from "@emotion/css";
import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import {Unicode11Addon} from "@xterm/addon-unicode11";
import {ContentAreaElement} from "@b9g/revise/contentarea.js";
import {transform} from "sucrase";

import type {
	TerminalTransport,
	TerminalSize,
	TerminalCloseInfo,
} from "../../../src/index.ts";
import {hostTransport} from "./sandbox-bridge.js";
import type {WorkerMessage} from "./sandbox-bridge.js";
import {CodeEditor, editorHeight} from "../components/code-editor.js";
import {installIMEQuirks} from "./ime.js";
// The programs themselves arrive in the page, in the script element the view
// wrote them to; the model exports the element ids both sides agree on.
import {
	EXAMPLES_SCRIPT_ID,
	FILES_SCRIPT_ID,
	SANDBOX_CONFIG_ID,
} from "../models/examples.js";
import type {
	Example,
	SandboxConfig,
} from "../models/examples.js";

if (!window.customElements.get("content-area")) {
	window.customElements.define("content-area", ContentAreaElement);
}

function readExamples(): Example[] {
	const script = document.getElementById(EXAMPLES_SCRIPT_ID);
	return script ? JSON.parse(script.textContent!) : [];
}

/**
 * How much terminal a context gets.
 *
 * The examples page is somewhere to work, so it gets the terminal the
 * examples are written against: eighty columns, and twenty-four rows, which is
 * one more than the tallest of them paints. An embed is a figure in an
 * argument, and a pane far taller than its program is a black void with a
 * program at the top of it, so an embed starts at fourteen rows and then
 * follows its program, between four rows and the page's twenty-four; its
 * columns widen to the pane, with fifty-six as the floor a narrow box
 * scrolls to. `editorLines` is whole lines, so the box ends where a line
 * does.
 */
const PAGE_GEOMETRY = {cols: 80, rows: 24, editorLines: 20};
const EMBED_GEOMETRY = {
	cols: 56,
	rows: 14,
	editorLines: 13,
	grow: {min: 4, max: 24},
};

// The page's own size, so the emulator's cells are the page's cells.
const FONT_SIZE = 16;
// The emulator measures its cell once, when it opens, so it opens after the
// page's font has arrived rather than measuring the fallback and painting
// wider than its box once the swap comes.
const FONT_READY: Promise<unknown> = document.fonts
	.load(`${FONT_SIZE}px "Atkinson Hyperlegible Mono"`)
	.catch(() => undefined);
// The emulator's cell in the font stack below, measured rather than guessed.
const CELL_WIDTH = 10.11;
// What the pane adds around the emulator's own box: its padding.
const PANE_CHROME = 16;
// The rule between the two halves, which is all that separates them.
const SEAM = 1;
// An editor is worth putting beside a terminal only if a line fits in it. The
// examples' 95th-percentile line runs 56 to 124 columns; sixty-four is where
// the shorter half of them stop needing a horizontal scroll, and it is a fair
// half of any width that can hold both.
const EDITOR_MIN_COLUMNS = 64;
// The editor's own cell, and what its padding, gutter and border add.
const EDITOR_CELL_WIDTH = 10.11;
const EDITOR_CHROME = 96;

/**
 * The width at which the editor and a `cols`-wide terminal can sit side by
 * side. Below it they stack, because the alternative is an editor clipped
 * mid-token beside a terminal with room to spare.
 */
function sideBySideWidth(cols: number): number {
	return Math.round(
		cols * CELL_WIDTH +
			PANE_CHROME +
			SEAM +
			EDITOR_MIN_COLUMNS * EDITOR_CELL_WIDTH +
			EDITOR_CHROME,
	);
}

// The emulator keeps its own colours in either scheme: a terminal is a dark
// screen, and a program's own background colours are read against this one.
const TERMINAL_BACKGROUND = "#0d1117";
const TERMINAL_FOREGROUND = "#e6edf3";
// Long enough that a burst of typing is one run, short enough that a pause
// feels like the program restarting on its own.
const AUTO_RUN_DELAY = 700;
const RUN_KEY_LABEL = /Mac|iPhone|iPad/.test(navigator.platform)
	? "⌘⏎"
	: "Ctrl⏎";

/**
 * An xterm.js instance as a TerminalTransport.
 *
 * The engine asks a transport for its size, its color depth, and its two
 * streams, and this answers with the emulator's: writes are `Terminal.write`,
 * reads are `onData` (keys, mouse reports, bracketed-paste bodies and the
 * emulator's own replies to the engine's queries, all interleaved, which is
 * exactly what the session expects to demultiplex).
 *
 * `sharesScreen` is false because the pane holds nothing but this program --
 * there is no shell prompt above it to anchor beneath, so rendering starts at
 * row 0.
 */
class XtermTransport implements TerminalTransport {
	readonly colorDepth = "rgb" as const;
	readonly sharesScreen = false;
	readonly interactive = true;
	readonly ready = Promise.resolve();
	readonly closed: Promise<TerminalCloseInfo>;
	readonly readable: ReadableStream<string>;
	readonly writable: WritableStream<string>;
	readonly resizes: ReadableStream<TerminalSize>;

	#terminal: Terminal;
	#closeSession!: (info: TerminalCloseInfo) => void;
	#dataSubscription: {dispose(): void} | null = null;
	#resizeSubscription: {dispose(): void} | null = null;
	#dead = false;

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
		this.closed = new Promise((resolve) => {
			this.#closeSession = resolve;
		});

		// Both readable ends subscribe on the first pull and unsubscribe when
		// cancelled, so a transport nobody reads never takes the emulator's
		// input -- the same contract the process transport keeps with a tty.
		this.readable = new ReadableStream<string>(
			{
				pull: (controller) => {
					if (this.#dataSubscription) return;
					this.#dataSubscription = terminal.onData((data) =>
						controller.enqueue(data),
					);
				},
				cancel: () => {
					this.#dataSubscription?.dispose();
					this.#dataSubscription = null;
				},
			},
			{highWaterMark: 0},
		);

		this.resizes = new ReadableStream<TerminalSize>(
			{
				pull: (controller) => {
					if (this.#resizeSubscription) return;
					this.#resizeSubscription = terminal.onResize(({cols, rows}) =>
						controller.enqueue({cols, rows}),
					);
				},
				cancel: () => {
					this.#resizeSubscription?.dispose();
					this.#resizeSubscription = null;
				},
			},
			{highWaterMark: 0},
		);

		// Resolve on the emulator's own callback: a written frame is one the
		// emulator has parsed, which is what frame ordering rests on. A dead
		// transport swallows writes: chunks its realm queued before dying must
		// not drain onto the next program's screen.
		this.writable = new WritableStream<string>({
			write: (chunk) => {
				if (this.#dead) return Promise.resolve();
				return new Promise<void>((resolve) => terminal.write(chunk, resolve));
			},
		});
	}

	get cols(): number {
		return this.#terminal.cols;
	}

	get rows(): number {
		return this.#terminal.rows;
	}

	/**
	 * The pane outlives the program, so this ends the session without ending
	 * anything else: the runner has already flushed and disposed by the time
	 * a `window.close()` reaches here.
	 */
	close(info: TerminalCloseInfo = {}): void {
		this.#closeSession(info);
	}

	/**
	 * Cut the transport off from the emulator: no more input taken, no more
	 * writes delivered. Stopping a run calls this before the pane resets, so
	 * nothing a dead program queued lands on the next one's screen.
	 */
	abort(): void {
		this.#dead = true;
		this.#dataSubscription?.dispose();
		this.#dataSubscription = null;
		this.#resizeSubscription?.dispose();
		this.#resizeSubscription = null;
	}
}

/** One program's lifetime: its sandbox, and the way to end it. */
interface Run {
	stop(): Promise<void>;
	/** The rows the program's document takes, or null before it has one. */
	contentRows(): number | null;
}

/** The repository's files the page carries, for the sandbox's filesystem. */
function readWorkspaceFiles(): Record<string, string> {
	const script = document.getElementById(FILES_SCRIPT_ID);
	return script ? (JSON.parse(script.textContent!) as Record<string, string>) : {};
}

function readSandboxConfig(): SandboxConfig | null {
	const script = document.getElementById(SANDBOX_CONFIG_ID);
	return script ? (JSON.parse(script.textContent!) as SandboxConfig) : null;
}

/**
 * The specifiers the page serves itself: the repository's own engine, and
 * the browser implementations of the node builtins. Everything else a
 * program imports is someone else's package and comes from the CDN. The
 * program runs from a blob URL, which nothing relative can resolve
 * against, so every one is made absolute.
 */
function localImports(config: SandboxConfig): Record<string, string> {
	const absolute = (path: string) => new URL(path, location.href).href;
	return {
		"@b9g/termdom": absolute(config.termdom),
		"node:fs": absolute(config.nodefs),
		"node:path": absolute(config.nodefs),
		"node:url": absolute(config.nodefs),
		"node:os": absolute(config.nodefs),
	};
}

const STATIC_IMPORT =
	/(\b(?:import|export)\s*(?:[^"'`;]*?\s+from\s*)?)(["'])([^"'\n]+)\2/g;
const DYNAMIC_IMPORT = /(\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;

/**
 * A worker has no import map, so the program's own imports are resolved
 * in its text: the page's modules to their URLs, and any bare specifier
 * beyond them to a CDN -- the same open door the crank playground holds.
 * A relative specifier is left as written, and fails as it did.
 */
function resolveImports(config: SandboxConfig, javascript: string): string {
	const imports = localImports(config);
	const resolve = (specifier: string): string => {
		if (specifier in imports) return imports[specifier];
		if (/^[./]/.test(specifier) || /^[a-z]+:/.test(specifier)) {
			return specifier;
		}
		return `https://esm.sh/${specifier}`;
	};
	return javascript
		.replace(
			STATIC_IMPORT,
			(_, head: string, quote: string, specifier: string) =>
				`${head}${quote}${resolve(specifier)}${quote}`,
		)
		.replace(
			DYNAMIC_IMPORT,
			(_, head: string, quote: string, specifier: string) =>
				`${head}${quote}${resolve(specifier)}${quote}`,
		);
}

/**
 * Run `code` as an ES module in a fresh worker against `terminal`.
 *
 * The code runs as written -- the import, the construction, the attach --
 * because `@b9g/termdom` resolves to a build of the engine whose
 * parameterless construction takes the transport the worker was started
 * with, and the terminal stays in the page, reached over the bridge. A
 * worker has no document or window, so a program that supplies them as
 * globals for a library that reads them finds the same absence it finds
 * under Node. Stopping a run terminates the worker, and the thread takes
 * its timers, frames and listeners with it.
 */
async function runProgram(
	terminal: Terminal,
	code: string,
	report: (error: unknown) => void,
): Promise<Run> {
	const config = readSandboxConfig();
	if (!config) throw new Error("The page carries no sandbox configuration.");
	const transport = new XtermTransport(terminal);

	// The editor holds TypeScript, the way the repository does; the module
	// that runs is the same text with the types erased. A type error is a
	// parse error here, reported like any other.
	const javascript = resolveImports(
		config,
		transform(code, {transforms: ["typescript"]}).code,
	);
	const url = URL.createObjectURL(
		new Blob([javascript], {type: "text/javascript"}),
	);

	const worker = new Worker(new URL(config.worker, location.href), {
		type: "module",
	});
	worker.addEventListener("error", (event) => {
		event.preventDefault();
		report(event.message);
	});
	worker.addEventListener("message", (event) => {
		const message = event.data as WorkerMessage;
		if (message?.type === "error") report(message.message);
	});

	let height: number | null = null;
	const channel = new MessageChannel();
	const bridge = hostTransport(transport, channel.port1, (rows) => {
		height = rows;
	});

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		URL.revokeObjectURL(url);
		bridge.stop();
		transport.abort();
		worker.terminate();
		transport.close();
	};

	const contentRows = (): number | null => (stopped ? null : height);

	worker.postMessage(
		{
			type: "init",
			files: readWorkspaceFiles(),
			program: url,
			cols: terminal.cols,
			rows: terminal.rows,
			port: channel.port2,
		},
		[channel.port2],
	);

	return {stop, contentRows};
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		const name = error.name || "Error";
		return `${name}: ${error.message}`;
	}

	return String(error);
}

/*** Components ***/

/**
 * The terminal half: an emulator opened once, and one program at a time
 * running against it.
 *
 * The emulator, its element and the run loop all outlive any single program,
 * so this yields a `Copy` after the first render -- Crank never touches the
 * subtree xterm.js owns. A new `code` prop is a new program, run once the
 * typing stops; a new `runNonce` is the reader asking for one now.
 *
 * Runs happen one after another, on a chain rather than in parallel: starting
 * a program is asynchronous -- the engine attaches, and the code itself may
 * await -- and a program that is stopped writes its way off the screen. Let
 * two overlap and a slow program's teardown lands on top of the next one's
 * first frame, leaving a blank pane and no error to show for it.
 */
function* TerminalPane(
	this: Context,
	{
		code,
		cols,
		rows,
		fill,
		grow,
		runNonce,
		onstatus,
	}: {
		code: string;
		cols: number;
		rows: number;
		/** Take the size of the box instead of the given geometry. */
		fill?: boolean;
		/**
		 * Follow the program: as many rows as its document takes, between
		 * these two, so a short program is not a screen of black under it.
		 */
		grow?: {min: number; max: number};
		runNonce: number;
		onstatus: (status: Status) => void;
	},
) {
	const terminal = new Terminal({
		cols,
		rows,
		convertEol: false,
		cursorBlink: false,
		// The Unicode version below is proposed API.
		allowProposedApi: true,
		fontSize: FONT_SIZE,
		fontFamily:
			'"Atkinson Hyperlegible Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
		theme: {
			background: TERMINAL_BACKGROUND,
			foreground: TERMINAL_FOREGROUND,
		},
	});

	// The emulator ships Unicode 6 widths, which predate emoji: it would draw
	// a 🎯 in one cell while the engine, on UAX #11, lays it out in two.
	// Version 11 is the one both sides agree on.
	terminal.loadAddon(new Unicode11Addon());
	terminal.unicode.activeVersion = "11";

	// A filling pane takes its geometry from its own box, so the terminal is
	// as big as the window makes it. A fixed pane keeps its rows but widens
	// to the box, with `cols` as the floor -- the addon measures the box in
	// cells either way. The padding is on the emulator's element, which is
	// the padding the addon subtracts; on the box it would be counted as
	// room for a row that then paints half under the edge.
	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);
	// The rows a fixed pane holds: the given ones, or what the program
	// takes once it has painted and the pane follows it.
	let wantRows = rows;
	const fit = (): void => {
		if (fill) {
			fitAddon.fit();
			return;
		}
		const dims = fitAddon.proposeDimensions();
		if (dims && dims.cols) {
			const target = Math.max(cols, dims.cols);
			if (target !== terminal.cols || wantRows !== terminal.rows) {
				terminal.resize(target, wantRows);
			}
		}
	};

	let root!: HTMLDivElement;
	let current: Run | null = null;
	let autoRunTimer = 0;
	let chain: Promise<void> = Promise.resolve();

	// A growing pane asks the program for its height a few times a second:
	// the document is the program's to change whenever it likes, and a
	// frame it paints is not something the pane hears about. It keeps the
	// tallest it has seen: a program whose output comes and goes would
	// otherwise move the page under the reader with every change.
	let tallest = 0;
	const follow = (): void => {
		if (!grow) return;
		const content = current?.contentRows();
		if (!content) return;
		tallest = Math.max(tallest, content);
		const next = Math.min(grow.max, Math.max(grow.min, tallest));
		if (next !== wantRows) {
			wantRows = next;
			fit();
		}
	};
	if (grow) {
		const timer = window.setInterval(follow, 250);
		this.cleanup(() => window.clearInterval(timer));
	}

	const run = (): Promise<void> => {
		window.clearTimeout(autoRunTimer);
		// `code` is read when the turn comes rather than when it is asked for,
		// so a run queued behind another starts the latest text.
		return (chain = chain.then(async () => {
			const previous = current;
			current = null;
			await previous?.stop();
			terminal.reset();
			onstatus({message: "Running.", failed: false});
			try {
				current = await runProgram(terminal, code, (error) =>
					onstatus({message: describeError(error), failed: true}),
				);
			} catch (error) {
				onstatus({message: describeError(error), failed: true});
			}
		}));
	};

	const scheduleRun = (): void => {
		window.clearTimeout(autoRunTimer);
		autoRunTimer = window.setTimeout(() => void run(), AUTO_RUN_DELAY);
	};

	this.cleanup(() => {
		window.clearTimeout(autoRunTimer);
		chain = chain.then(async () => {
			await current?.stop();
			current = null;
			terminal.dispose();
		});
	});

	let initial = true;
	let lastCode = code;
	let lastNonce = runNonce;
	for ({code, runNonce, onstatus} of this) {
		if (initial) {
			this.after(() => {
				void FONT_READY.then(() => {
					terminal.open(root);
					// After `open`: the emulator's element and textarea, which
					// the IME work listens on, are made there.
					installIMEQuirks(terminal);
					fit();
					// The box changes with the window, and the program hears
					// about it the way a program in a terminal does: the
					// emulator resizes, and the transport carries the new
					// size to the session.
					const observer = new ResizeObserver(() => {
						if (root.clientWidth > 0 && root.clientHeight > 0) {
							fit();
						}
					});
					observer.observe(root);
					this.cleanup(() => observer.disconnect());
					void run();
				});
			});

			// The half fills whatever the grid gives it, and the emulator sits
			// at its top left. Where the terminal is the narrower of the two
			// the surplus is terminal background, which is a screen with
			// nothing painted on it rather than a hole in the workbench.
			yield jsx`
				<div
					ref=${(el: HTMLDivElement) => (root = el)}
					class=${
						fill
							? css`
									min-width: 0;
									min-height: 0;
									overflow: hidden;
									background-color: ${TERMINAL_BACKGROUND};
									> .xterm {
										padding: 0.5rem;
									}
								`
							: css`
									min-width: 0;
									overflow-x: auto;
									background-color: ${TERMINAL_BACKGROUND};
									> .xterm {
										padding: 0.5rem;
									}
								`
					}
				/>
			`;
			initial = false;
		} else {
			if (runNonce !== lastNonce) {
				void run();
			} else if (code !== lastCode) {
				scheduleRun();
			}

			yield jsx`<${Copy} />`;
		}

		lastCode = code;
		lastNonce = runNonce;
	}
}

interface Status {
	message: string;
	failed: boolean;
}

const container = css`
	max-width: 160ch;
	margin: 0 auto;
	padding: calc(var(--bar-height) + 2lh) 2ch 2lh;
`;

/* The examples page is a window's worth of workbench: the navbar is fixed
   at the top, and what is left of the viewport is the frame. Nothing scrolls
   but the editor's own text. */
const pageShell = css`
	max-width: 160ch;
	margin: 0 auto;
	padding: calc(var(--bar-height) + 1lh) 2ch 1lh;
	height: 100dvh;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 1lh;
`;

/* The workbench's title bar: whatever the page puts here, the run button, and
   the status the run reports. It sits inside the frame, one step back from the
   panes the way the page's background sits behind its surfaces, so the
   workbench reads as a single block rather than a control loose above two
   boxes. It is one row of controls between the half row the frame's stroke
   leaves above and the half row above the rule under it; the pane below
   owns the other half of the rule's row, so the gutter's rule meets it. */
const toolbar = css`
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 1ch;
	margin: 0;
	padding: 0.5lh 1.5ch 0.5lh;
	flex-wrap: wrap;
	background: var(--rule) bottom center / 100% 1px no-repeat var(--bg-color);

	label {
		color: var(--muted-color);
	}

	button {
		font: inherit;
		color: var(--text-color);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-weight: bold;
	}

	button:hover {
		background-color: var(--highlight-color);
		color: var(--bg-color);
	}

	button:focus-visible {
		outline: 1px solid var(--highlight-color);
		outline-offset: 0;
	}

	button kbd {
		font: inherit;
		font-weight: normal;
		color: var(--muted-color);
		margin-left: 1ch;
	}
`;

/* The name of the file in the editor, where an embed has no picker to carry
   it. It is also what the static figure shows before the embed hydrates, in
   the same place, so the bar does not change shape when it does. */
const filename = css`
	color: var(--muted-color);
	margin: 0;
`;

/**
 * Editor beside terminal, or editor above terminal.
 *
 * Which one is a question about the width the workbench has, not the width
 * the window has -- the same component sits in a 900px column on the home
 * page and across the examples page -- so it is a container query, and the
 * workbench is the container.
 *
 * The two halves meet on a rule rather than across a gap: they are one
 * instrument, and the frame around them draws the outside edge. The rule
 * turns with the layout. Both halves stretch to the taller of them, so the
 * frame closes on a straight edge whichever way they are stacked.
 */
// A filling terminal has no fixed width, so the two halves sit side by side
// once the box can hold the editor and a terminal worth reading -- fifty
// columns, which is where the examples' output stops wrapping.
const FILL_MIN_COLUMNS = 50;

function panes(cols: number, fill?: boolean) {
	return css`
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: stretch;
		${fill
			? `
		flex: 1;
		min-height: 0;
		grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
		`
			: ""}

		/* The rule between the halves runs down the middle of the cell that
		   separates them, and reaches the frame's stroke at either end. */
		> * + * {
			position: relative;
			margin-top: 1lh;
		}

		> * + *::before {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			top: -0.5lh;
			height: 1px;
			background-color: currentColor;
			pointer-events: none;
		}

		@container workbench (min-width: ${sideBySideWidth(fill ? FILL_MIN_COLUMNS : cols)}px) {
			grid-template-columns: ${fill ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr) auto"};
			${fill ? "grid-template-rows: minmax(0, 1fr);" : ""}

			> * + * {
				margin-top: 0;
				margin-left: 1ch;
			}

			> * + *::before {
				top: 0;
				bottom: 0;
				left: -0.5ch;
				right: auto;
				width: 1px;
				height: auto;
			}
		}
	`;
}

/* Filling the window: the frame is the page's one block, and the panes
   inside it split whatever height the window leaves. */
const workbenchFill = css`
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
`;

/* The editor half when the workbench fills: as tall as the row it is in,
   scrolling inside itself, because a program is longer than a window. */
const editorPaneFill = css`
	display: flex;
	min-width: 0;
	min-height: 0;
	background-color: var(--surface-color);

	> * {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}
`;

/* The frame. The site draws a box as a stroke down the middle of the cell
   around it -- `pre`, the install command -- and the workbench is one box,
   so it is drawn the same way: half a cell of padding puts the stroke on the
   content's edge, where the rules inside it meet it. */
const workbench = css`
	container: workbench / inline-size;
	position: relative;
	margin: 0;
	padding: 0.5lh 0.5ch;
	overflow: hidden;

	&::before {
		content: "";
		position: absolute;
		inset: 0.5lh 0.5ch;
		border: 1px solid currentColor;
		pointer-events: none;
		z-index: 1;
	}
`;

/* The editor half. Its height is a whole number of the editor's own rows, and
   the row of the grid is as tall as the taller half, so the terminal beside it
   stretches to meet it and the frame closes on a straight edge. */
function editorPane(lines: number) {
	return css`
		display: flex;
		min-width: 0;
		height: ${editorHeight(lines)};
		background-color: var(--surface-color);

		> * {
			flex: 1 1 auto;
			min-width: 0;
		}
	`;
}

/* The terminal alone, filling the frame, while the editor drawer is shut. */
const paneSolo = css`
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	grid-template-rows: minmax(0, 1fr);
	flex: 1;
	min-height: 0;
`;

const EDITOR_PREFERENCE = "examples:editor";

function readEditorPreference(): boolean {
	try {
		return localStorage.getItem(EDITOR_PREFERENCE) === "open";
	} catch {
		return false;
	}
}

function writeEditorPreference(open: boolean): void {
	try {
		localStorage.setItem(EDITOR_PREFERENCE, open ? "open" : "closed");
	} catch {
		// A page that cannot remember still toggles.
	}
}

/* In the toolbar rather than under the panes, taking the room the controls
   leave and giving a long message an ellipsis rather than a second row. */
const statusLine = css`
	flex: 1 1 24ch;
	min-width: 0;
	margin: 0;
	color: var(--muted-color);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;

	&[data-state="error"] {
		color: #f85149;
	}
`;

/**
 * An editor, a terminal and the program that passes between them.
 *
 * The page and the embeds on the home page are the same thing rendered in two
 * places: this owns the one string, the editor owns the text, and the terminal
 * pane owns the running program. `controls` is whatever the surrounding page
 * puts beside the run button -- the picker, on the examples page.
 *
 * The editor re-renders itself as it is typed in, so a keystroke arrives here
 * as `contentchange` and the editor is handed back a `Copy`; only a value
 * chosen from outside -- an example from the picker -- is rendered into it.
 */
function* Workbench(
	this: Context,
	{
		value,
		valueEpoch = 0,
		name,
		title,
		geometry,
		fill,
		drawer,
		oncode,
		controls: extraControls,
	}: {
		value: string;
		/** Bumped to re-seat `value` even when the string is unchanged. */
		valueEpoch?: number;
		name: string;
		/** The file in the editor, where nothing else in the bar names it. */
		title?: string;
		geometry: {
			cols: number;
			rows: number;
			editorLines: number;
			grow?: {min: number; max: number};
		};
		/** Fill the box this is given instead of sizing to the geometry. */
		fill?: boolean;
		/**
		 * The editor is a drawer beside the terminal, closed until asked for:
		 * the terminal is what a visitor came to see, and the editor is there
		 * for the one who came to change it. Remembered across pages.
		 */
		drawer?: boolean;
		/** Hears what the editor holds, the outside value included. */
		oncode?: (code: string) => void;
		controls?: unknown;
	},
) {
	let code = value;
	let editorOpen = !drawer || readEditorPreference();
	const toggleEditor = (): void => {
		this.refresh(() => {
			editorOpen = !editorOpen;
			writeEditorPreference(editorOpen);
		});
	};
	let shown = value;
	let shownEpoch = valueEpoch;
	let updateEditor = true;
	let status: Status = {message: "", failed: false};
	// Bumped to ask the terminal pane for a run that does not wait out the
	// typing delay. The button and the shortcut are the same request.
	let runNonce = 0;
	let root!: HTMLDivElement;

	this.addEventListener("contentchange", (ev: any) => {
		this.refresh(() => {
			code = ev.target.value;
			oncode?.(code);
		});
	});

	const onstatus = (next: Status) => {
		this.refresh(() => {
			status = next;
		});
	};

	const runNow = () => {
		this.refresh(() => {
			runNonce++;
		});
	};

	// Ctrl/Cmd-Enter runs without waiting out the delay, from either place the
	// keyboard can be. It listens in the capture phase, on this instance's own
	// element: both things that take keys here stop the event before it
	// bubbles -- the emulator cancels the keys it handles, and the editor turns
	// Enter into an indented newline -- and a page can hold more than one of
	// these, each answering for the keyboard inside it.
	const onkeydown = (ev: KeyboardEvent) => {
		if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey)) return;
		ev.preventDefault();
		ev.stopPropagation();
		runNow();
	};

	this.after(() => {
		root.addEventListener("keydown", onkeydown, true);
		this.cleanup(() => root.removeEventListener("keydown", onkeydown, true));
	});

	for ({
		value,
		valueEpoch = 0,
		name,
		title,
		geometry,
		fill,
		drawer,
		oncode,
		controls: extraControls,
	} of this) {
		// A value from outside is a new program; a value this component's own
		// editor produced is already in `code`.
		if (value !== shown || valueEpoch !== shownEpoch) {
			shown = code = value;
			shownEpoch = valueEpoch;
			updateEditor = true;
		}

		this.schedule(() => {
			updateEditor = false;
		});

		yield jsx`
			<div
				ref=${(el: HTMLDivElement) => (root = el)}
				class=${fill ? `${workbench} ${workbenchFill}` : workbench}>
				<div class=${toolbar}>
					${title ? jsx`<span class=${filename}>${title}</span>` : null}
					${extraControls}
					${drawer
						? jsx`<button
								id=${`${name}-editor`}
								type="button"
								aria-pressed=${editorOpen ? "true" : "false"}
								onclick=${toggleEditor}
							>
								${editorOpen ? "Hide editor" : "Edit"}
							</button>`
						: null}
					<button id=${`${name}-run`} type="button" onclick=${runNow}>
						Run <kbd>${RUN_KEY_LABEL}</kbd>
					</button>
					<p
						id=${`${name}-status`}
						class="example-status ${statusLine}"
						data-state=${status.failed ? "error" : "ok"}>
						${status.message}
					</p>
				</div>

				<div class=${editorOpen ? panes(geometry.cols, fill) : paneSolo}>
					${editorOpen
						? jsx`<div class=${fill ? editorPaneFill : editorPane(geometry.editorLines)}>
								<${CodeEditor}
									copy=${!updateEditor}
									value=${code}
									language="javascript"
									showGutter
								/>
							</div>`
						: null}
					<div class=${terminalSide}>
						<${TerminalPane}
							code=${code}
							cols=${geometry.cols}
							rows=${geometry.rows}
							fill=${fill}
							grow=${geometry.grow}
							runNonce=${runNonce}
							onstatus=${onstatus}
						/>
					</div>
				</div>
			</div>
		`;
	}
}

/* The terminal side: the pane, filling the column it is given. */
const terminalSide = css`
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
	background-color: ${TERMINAL_BACKGROUND};
	> :first-child {
		flex: 1;
		min-height: 0;
	}
`;

/*** Gallery ***/

const GALLERY_GEOMETRY = {cols: 48, rows: 12};

const gallery = css`
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
	gap: 1rem;
	margin: 1.5rem 0 0;
	padding: 0;
	list-style: none;
`;

const card = css`
	position: relative;
	display: flex;
	flex-direction: column;
	padding: 0.5lh 0.5ch;
	overflow: hidden;
	color: inherit;
	text-decoration: none;
	&::before {
		content: "";
		position: absolute;
		inset: 0.5lh 0.5ch;
		border: 1px solid currentColor;
		pointer-events: none;
		z-index: 1;
	}
	&:hover {
		text-decoration: none;
		background: none;
		color: inherit;
	}
	&:hover::before {
		border-color: var(--highlight-color);
	}
	&:focus-visible {
		outline: 1px solid var(--highlight-color);
		outline-offset: 0;
	}
	.thumb {
		/* The pane is a picture here: clicks go to the card, and the program
		   under it keeps running for its own sake. */
		pointer-events: none;
		background-color: ${TERMINAL_BACKGROUND};
		height: ${GALLERY_GEOMETRY.rows * FONT_SIZE * 1.3 + PANE_CHROME}px;
		overflow: hidden;
	}
	.caption {
		padding: 1lh 1.5ch 0.5lh;
		background: var(--rule) top 0.5lh center / 100% 1px no-repeat;
	}
	.title {
		font-weight: bold;
		color: var(--highlight-color);
	}
`;

/**
 * One card: the program running small, once the card comes near the
 * viewport, under its name and what it is about. Twenty programs booting
 * on load is not what a visitor asked for, so a card boots itself when
 * it is about to be seen and stays booted.
 */
function* GalleryCard(this: Context, {example}: {example: Example}) {
	let visible = false;
	let root!: HTMLAnchorElement;
	this.after(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer.disconnect();
					this.refresh(() => {
						visible = true;
					});
				}
			},
			{rootMargin: "200px"},
		);
		observer.observe(root);
		this.cleanup(() => observer.disconnect());
	});
	for ({example} of this) {
		yield jsx`
			<a
				ref=${(el: HTMLAnchorElement) => (root = el)}
				class=${card}
				href=${`#e=${example.id}`}
				data-card=${example.id}
			>
				<div class="thumb" aria-hidden="true">
					${visible
						? jsx`<${TerminalPane}
								code=${example.code}
								cols=${GALLERY_GEOMETRY.cols}
								rows=${GALLERY_GEOMETRY.rows}
								runNonce=${0}
								onstatus=${() => {}}
							/>`
						: null}
				</div>
				<div class="caption">
					<div class="title">${example.label}</div>
				</div>
			</a>
		`;
	}
}

function Gallery({examples}: {examples: Example[]}) {
	return jsx`
		<main class=${container}>
			<h1 class=${css`
				margin: 0;
				background: none;
				padding: 0;
			`}>Examples</h1>
			<ul class=${gallery}>
				${examples.map(
					(example) => jsx`
						<li key=${example.id}>
							<${GalleryCard} example=${example} />
						</li>
					`,
				)}
			</ul>
		</main>
	`;
}

/*** Sharing ***/

/**
 * The page's state as a URL: `#e=<id>` for an example as it ships,
 * `#c=<program>` for anything edited, the program deflated and base64url
 * encoded so a whole example fits in an address bar. Written as the
 * reader types and read once on load, so a link is an example.
 */
const SHARE_DEBOUNCE = 500;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function pipeBytes(
	bytes: Uint8Array,
	stream: {readable: ReadableStream; writable: WritableStream},
): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	void writer.write(bytes);
	void writer.close();
	const chunks: Uint8Array[] = [];
	const reader = stream.readable.getReader();
	for (;;) {
		const {value, done} = await reader.read();
		if (done) break;
		chunks.push(value as Uint8Array);
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function encodeProgram(code: string): Promise<string> {
	const bytes = new TextEncoder().encode(code);
	if (typeof CompressionStream === "undefined") return `r${base64url(bytes)}`;
	return `d${base64url(await pipeBytes(bytes, new CompressionStream("deflate-raw")))}`;
}

async function decodeProgram(text: string): Promise<string | null> {
	try {
		const bytes = fromBase64url(text.slice(1));
		if (text.startsWith("r")) return new TextDecoder().decode(bytes);
		if (text.startsWith("d") && typeof DecompressionStream !== "undefined") {
			return new TextDecoder().decode(
				await pipeBytes(bytes, new DecompressionStream("deflate-raw")),
			);
		}
	} catch {
		// A hash that is not one of ours: the page opens on its default.
	}
	return null;
}

function readShareHash(): {example?: string; program?: string} {
	const params = new URLSearchParams(location.hash.replace(/^#/, ""));
	return {
		example: params.get("e") ?? undefined,
		program: params.get("c") ?? undefined,
	};
}

function writeShareHash(hash: string): void {
	if (location.hash === `#${hash}`) return;
	history.replaceState(null, "", `#${hash}`);
}

/** The examples page: the picker, and a workbench under it. */
function* Examples(this: Context) {
	const examples = readExamples();
	const share = readShareHash();
	// The page opens on the gallery, and on the workbench when the address
	// names a program.
	let mode: "gallery" | "workbench" =
		share.example !== undefined || share.program !== undefined
			? "workbench"
			: "gallery";
	let example =
		examples.find((each) => each.id === share.example) ?? examples[0];
	// What the editor holds when it is not an example as it ships: a program
	// from a shared link, until the reader picks something else.
	let program: string | null = null;
	// True when the editor's text matches no example; the picker shows its
	// placeholder instead of an example name.
	let custom = false;
	// Bumped on every pick, so choosing the example the edits started from
	// still resets the editor to it.
	let pickEpoch = 0;
	let shareTimer = 0;
	let latest = example.code;
	let shareStatus = "";
	// A shared program arrives encoded, so it lands a moment after the page.
	// The same steps serve a hash that changes under the page (a back
	// button, a pasted address), with an example id taking effect at once.
	const applyShare = (next: {example?: string; program?: string}): void => {
		if (next.program !== undefined) {
			const pending = next.program;
			void decodeProgram(pending).then((decoded) => {
				if (decoded === null || readShareHash().program !== pending) return;
				this.refresh(() => {
					mode = "workbench";
					program = decoded;
					custom = true;
					pickEpoch++;
				});
			});
			return;
		}
		const chosen = examples.find((each) => each.id === next.example);
		if (chosen === undefined) {
			if (mode !== "gallery") {
				this.refresh(() => {
					mode = "gallery";
				});
			}
			return;
		}
		if (mode === "workbench" && chosen === example && program === null) {
			return;
		}
		this.refresh(() => {
			mode = "workbench";
			example = chosen;
			program = null;
			custom = false;
			pickEpoch++;
		});
	};
	applyShare(share);
	const onhashchange = (): void => applyShare(readShareHash());
	window.addEventListener("hashchange", onhashchange);
	this.cleanup(() => window.removeEventListener("hashchange", onhashchange));
	// The hash follows the editor: the example's id while the text is one,
	// the program itself once it is not.
	const updateShare = async (): Promise<void> => {
		const match = examples.find((each) => each.code === latest);
		writeShareHash(
			match ? `e=${match.id}` : `c=${await encodeProgram(latest)}`,
		);
	};
	const copyLink = async (): Promise<void> => {
		window.clearTimeout(shareTimer);
		await updateShare();
		try {
			await navigator.clipboard.writeText(location.href);
			shareStatus = "Link copied.";
		} catch {
			shareStatus = "Copy the address bar to share.";
		}
		this.refresh();
		window.setTimeout(() => {
			shareStatus = "";
			this.refresh();
		}, 2500);
	};

	const onexamplechange = (ev: Event) => {
		const id = (ev.target as HTMLSelectElement).value;
		const chosen = examples.find((each) => each.id === id);
		if (!chosen) return;
		this.refresh(() => {
			example = chosen;
			program = null;
			custom = false;
			pickEpoch++;
		});
	};

	const oncode = (code: string) => {
		latest = code;
		window.clearTimeout(shareTimer);
		shareTimer = window.setTimeout(() => void updateShare(), SHARE_DEBOUNCE);
		const match = examples.find((each) => each.code === code);
		const isCustom = match === undefined;
		if (match !== undefined && match !== example) {
			this.refresh(() => {
				example = match;
				custom = false;
			});
		} else if (isCustom !== custom) {
			this.refresh(() => {
				custom = isCustom;
			});
		}
	};

	for ({} of this) {
		if (mode === "gallery") {
			yield jsx`<${Gallery} examples=${examples} />`;
			continue;
		}
		yield jsx`
			<main class=${pageShell}>
				<h1 class=${css`
					margin: 0;
					background: none;
					padding: 0;
				`}>Examples</h1>
				<${Workbench}
					value=${program ?? example.code}
					valueEpoch=${pickEpoch}
					name="example"
					geometry=${PAGE_GEOMETRY}
					fill
					drawer
					oncode=${oncode}
					controls=${jsx`
						<a href="#" class=${filename}>‹ Gallery</a>
						<label for="example-picker">Example</label>
						<span class="dropdown">
							<select
								id="example-picker"
								style=${`width: ${(custom ? "Pick an example…" : example.label).length + 1}ch`}
								onchange=${onexamplechange}
							>
								<option value="" disabled hidden selected=${custom}>Pick an example…</option>
								${examples.map(
									(each) => jsx`
										<option
											key=${each.id}
											value=${each.id}
											selected=${!custom && each.id === example.id}
										>
											${each.label}
										</option>
									`,
								)}
							</select>
						</span>
						<button id="example-share" type="button" onclick=${() => void copyLink()}>
							Share
						</button>
						${shareStatus ? jsx`<span class=${filename}>${shareStatus}</span>` : null}
					`}
				/>
			</main>
		`;
	}
}

/**
 * The embeds on the home page.
 *
 * Each `<figure data-example="id">` holds the program, highlighted at build
 * time, and stays that way until it comes near the viewport: five terminals
 * booting at load is not what someone scrolling a home page asked for. What
 * replaces it is the same workbench the examples page renders, with the
 * program already in it.
 */
function hydrateEmbeds(): void {
	const embeds = [
		...document.querySelectorAll<HTMLElement>("[data-example]"),
	].filter((embed) => !embed.hasAttribute("data-example-ready"));
	if (!embeds.length) return;

	const examples = readExamples();
	const mount = (embed: HTMLElement): void => {
		const example = examples.find((each) => each.id === embed.dataset.example);
		if (!example) return;
		embed.setAttribute("data-example-ready", "");
		embed.textContent = "";
		renderer.render(
			jsx`
				<${Workbench}
					value=${example.code}
					name=${`example-${example.id}`}
					title=${example.label}
					geometry=${EMBED_GEOMETRY}
				/>
			`,
			embed,
		);
	};

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				mount(entry.target as HTMLElement);
			}
		},
		{rootMargin: "200px"},
	);

	for (const embed of embeds) observer.observe(embed);
}

const root = document.getElementById("examples");
if (root) {
	renderer.render(jsx`<${Examples} />`, root);
}

hydrateEmbeds();
