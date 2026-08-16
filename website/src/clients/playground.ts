/**
 * The playground: an editor, a terminal, and TermDOM running between them in
 * the reader's own browser. Nothing here talks to a server -- the code in the
 * editor is compiled and run on the page it is typed on.
 */
import {Copy, jsx} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank";
import {renderer} from "@b9g/crank/dom";
import {css} from "@emotion/css";
import {Terminal} from "@xterm/xterm";
import {ContentAreaElement} from "@b9g/revise/contentarea.js";
import {transform} from "sucrase";

import type {
	TerminalTransport,
	TerminalSize,
	TerminalCloseInfo,
} from "../../../src/index.js";
import {CodeEditor, editorHeight} from "../components/code-editor.js";
import {installIMEQuirks} from "./ime.js";
// The programs themselves arrive in the page, in the script element the view
// wrote them to; the model exports the element ids both sides agree on.
import {
	EXAMPLES_SCRIPT_ID,
	SANDBOX_CONFIG_ID,
} from "../models/playground-examples.js";
import type {
	PlaygroundExample,
	SandboxConfig,
} from "../models/playground-examples.js";

if (!window.customElements.get("content-area")) {
	window.customElements.define("content-area", ContentAreaElement);
}

function readExamples(): PlaygroundExample[] {
	const script = document.getElementById(EXAMPLES_SCRIPT_ID);
	return script ? JSON.parse(script.textContent!) : [];
}

/**
 * How much terminal a context gets.
 *
 * The playground page is somewhere to work, so it gets the terminal the
 * examples are written against: eighty columns, and twenty-four rows, which is
 * one more than the tallest of them paints. An embed is a figure in an
 * argument, and a pane far taller than its program is a black void with a
 * program at the top of it -- the three programs embedded on the home page
 * paint 4x36, 11x35 and 7x45, so an embed gets 56x14 and the slack is
 * deliberate rather than left over. `editorLines` is whole lines, so the box ends where a line
 * does.
 */
const PAGE_GEOMETRY = {cols: 80, rows: 24, editorLines: 20};
const EMBED_GEOMETRY = {cols: 56, rows: 14, editorLines: 13};

const FONT_SIZE = 13;
// The emulator's cell in the font stack below, measured rather than guessed.
const CELL_WIDTH = 7.83;
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
const EDITOR_CELL_WIDTH = 8.4;
const EDITOR_CHROME = 80;

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
}

interface SandboxWindow extends Window {
	__start?: (url: string) => Promise<unknown>;
	__transport?: TerminalTransport;
}

function readSandboxConfig(): SandboxConfig | null {
	const script = document.getElementById(SANDBOX_CONFIG_ID);
	return script ? (JSON.parse(script.textContent!) as SandboxConfig) : null;
}

/**
 * The sandbox document: an import map resolving the specifiers the examples
 * use, and a bootstrap that runs a module URL on request. `<` is escaped so
 * no asset URL can close the script element it is written into.
 */
/** The specifiers served from the page's own assets. */
function localImports(config: SandboxConfig): Record<string, string> {
	return {
		"@b9g/termdom": config.termdom,
		"node:fs": config.nodefs,
		"node:path": config.nodefs,
		"node:url": config.nodefs,
		"node:os": config.nodefs,
		"node:module": config.nodeModule,
		"@b9g/crank/standalone": config.crankStandalone,
		"@b9g/crank/dom": config.crankDom,
		"marked": config.marked,
		"marked-highlight": config.markedHighlight,
		"@tanstack/table-core": config.tanstackTableCore,
	};
}

const IMPORT_SPECIFIER =
	/(?:^|\n)\s*import\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;

/**
 * The import map for one program: the page's own modules first, and any
 * bare specifier the code names beyond them resolved to a CDN -- the same
 * open door the crank playground holds. Relative and node-prefixed
 * specifiers are not the map's business.
 */
function importMapFor(config: SandboxConfig, code: string): string {
	const imports = localImports(config);
	for (const match of code.matchAll(IMPORT_SPECIFIER)) {
		const specifier = match[1];
		if (specifier in imports) continue;
		if (/^[./]/.test(specifier) || specifier.startsWith("node:")) continue;
		imports[specifier] = `https://esm.sh/${specifier}`;
	}
	return JSON.stringify({imports}).replace(/</g, "\\u003c");
}

function sandboxHTML(config: SandboxConfig, code: string): string {
	const importMap = importMapFor(config, code);
	return [
		"<!doctype html>",
		'<meta charset="utf-8">',
		'<script type="importmap">' + importMap + "</" + "script>",
		'<script type="module">',
		'globalThis.process = {argv: ["node", "example.ts"], env: {},' +
			' cwd: () => "/workspace/termdom", platform: "linux",' +
			' stdin: {isTTY: true}, stdout: {isTTY: true}, stderr: {isTTY: true}};',
		"window.__start = (url) => import(url);",
		"</" + "script>",
	].join("\n");
}

/**
 * Run `code` as an ES module in a fresh same-origin iframe against
 * `terminal`.
 *
 * The code runs as written -- the import, the construction, the attach --
 * because the iframe's import map resolves `@b9g/termdom` to a build of the
 * engine whose parameterless construction takes the transport the workbench
 * put on the sandbox's globalThis. Stopping a run removes the iframe, and
 * the realm takes its timers, frames and listeners with it.
 */
async function runProgram(
	terminal: Terminal,
	code: string,
	report: (error: unknown) => void,
): Promise<Run> {
	const config = readSandboxConfig();
	if (!config) throw new Error("The page carries no sandbox configuration.");
	const transport = new XtermTransport(terminal);

	const iframe = document.createElement("iframe");
	iframe.style.display = "none";
	iframe.setAttribute("aria-hidden", "true");
	iframe.srcdoc = sandboxHTML(config, code);
	const loaded = new Promise<void>((resolve) => {
		iframe.addEventListener("load", () => resolve(), {once: true});
	});
	document.body.appendChild(iframe);
	await loaded;

	const sandbox = iframe.contentWindow as SandboxWindow | null;
	if (!sandbox?.__start) {
		iframe.remove();
		throw new Error("The sandbox failed to boot.");
	}

	sandbox.__transport = transport;
	sandbox.addEventListener("error", (event) => {
		const ev = event as ErrorEvent;
		report(ev.error ?? ev.message);
	});
	sandbox.addEventListener("unhandledrejection", (event) => {
		report((event as PromiseRejectionEvent).reason);
	});

	// The editor holds TypeScript, the way the repository does; the module
	// that runs is the same text with the types erased. A type error is a
	// parse error here, reported like any other.
	const javascript = transform(code, {transforms: ["typescript"]}).code;
	const url = URL.createObjectURL(
		new Blob([javascript], {type: "text/javascript"}),
	);

	// The module about to run is the sandbox's entry point: the guard a
	// runnable-and-importable example ends with compares itself to argv[1],
	// and in this realm argv[1] is the workbench's blob.
	(sandbox as SandboxWindow & {__mainModuleURL?: string}).__mainModuleURL =
		url;

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		URL.revokeObjectURL(url);
		transport.abort();
		iframe.remove();
		transport.close();
	};

	try {
		await sandbox.__start(url);
	} catch (error) {
		await stop();
		throw error;
	}

	return {stop};
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
		runNonce,
		onstatus,
	}: {
		code: string;
		cols: number;
		rows: number;
		runNonce: number;
		onstatus: (status: Status) => void;
	},
) {
	const terminal = new Terminal({
		cols,
		rows,
		convertEol: false,
		cursorBlink: false,
		fontSize: FONT_SIZE,
		fontFamily:
			'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
		theme: {
			background: TERMINAL_BACKGROUND,
			foreground: TERMINAL_FOREGROUND,
		},
	});

	let root!: HTMLDivElement;
	let current: Run | null = null;
	let autoRunTimer = 0;
	let chain: Promise<void> = Promise.resolve();

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
				terminal.open(root);
				// After `open`: the emulator's element and textarea, which the
				// IME work listens on, are made there.
				installIMEQuirks(terminal);
				void run();
			});

			// The half fills whatever the grid gives it, and the emulator sits
			// at its top left. Where the terminal is the narrower of the two
			// the surplus is terminal background, which is a screen with
			// nothing painted on it rather than a hole in the workbench.
			yield jsx`
				<div
					ref=${(el: HTMLDivElement) => (root = el)}
					class=${css`
						padding: 0.5rem;
						min-width: 0;
						overflow-x: auto;
						background-color: ${TERMINAL_BACKGROUND};
					`}
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
	max-width: 1440px;
	margin: 0 auto;
	padding: 5rem 1.2rem 2rem;
`;

/* The workbench's title bar: whatever the page puts here, the run button, and
   the status the run reports. It sits inside the frame, one step back from the
   panes the way the page's background sits behind its surfaces, so the
   workbench reads as a single block rather than a control loose above two
   boxes. The controls are the site's own: a surface, a hairline border and the
   radius `code` and `pre` are given. */
const toolbar = css`
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 0.5rem;
	margin: 0;
	padding: 0.5rem 0.6rem;
	flex-wrap: wrap;
	background-color: var(--bg-color);
	border-bottom: 1px solid var(--border-color);

	label {
		font-size: 0.8rem;
		color: var(--muted-color);
	}

	select,
	button {
		font: inherit;
		font-size: 0.85rem;
		line-height: 1.4;
		color: var(--text-color);
		background-color: var(--surface-color);
		border: 1px solid var(--border-color);
		border-radius: 6px;
		padding: 0.25rem 0.7rem;
	}

	button {
		cursor: pointer;
		font-weight: bold;
	}

	select:hover,
	button:hover {
		border-color: var(--highlight-color);
	}

	button:hover {
		color: var(--highlight-color);
	}

	select:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--highlight-color);
		outline-offset: 1px;
	}

	button kbd {
		font: inherit;
		font-weight: normal;
		color: var(--muted-color);
		margin-left: 0.4rem;
	}
`;

/* The name of the file in the editor, where an embed has no picker to carry
   it. It is also what the static figure shows before the embed hydrates, in
   the same place, so the bar does not change shape when it does. */
const filename = css`
	font-size: 0.8rem;
	color: var(--muted-color);
	margin: 0 0.2rem 0 0.1rem;
`;

/**
 * Editor beside terminal, or editor above terminal.
 *
 * Which one is a question about the width the workbench has, not the width
 * the window has -- the same component sits in a 900px column on the home
 * page and across the playground page -- so it is a container query, and the
 * workbench is the container.
 *
 * The two halves meet on a rule rather than across a gap: they are one
 * instrument, and the frame around them draws the outside edge. The rule
 * turns with the layout. Both halves stretch to the taller of them, so the
 * frame closes on a straight edge whichever way they are stacked.
 */
function panes(cols: number) {
	return css`
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: stretch;

		> * + * {
			border-top: 1px solid var(--border-color);
		}

		@container workbench (min-width: ${sideBySideWidth(cols)}px) {
			grid-template-columns: minmax(0, 1fr) auto;

			> * + * {
				border-top: none;
				border-left: 1px solid var(--border-color);
			}
		}
	`;
}

/* The frame. The site draws a surface as a hairline border and an 8px radius
   -- `pre`, the install command, the cast player -- and the workbench is one
   surface, so it is drawn the same way and the panes inside it have no edges
   of their own. */
const workbench = css`
	container: workbench / inline-size;
	margin: 0;
	border: 1px solid var(--border-color);
	border-radius: 8px;
	overflow: hidden;
	background-color: var(--surface-color);
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

/* In the toolbar rather than under the panes, taking the room the controls
   leave and giving a long message an ellipsis rather than a second row. */
const statusLine = css`
	flex: 1 1 12rem;
	min-width: 0;
	margin: 0;
	font-size: 0.85rem;
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
 * puts beside the run button -- the picker, on the playground page.
 *
 * The editor re-renders itself as it is typed in, so a keystroke arrives here
 * as `contentchange` and the editor is handed back a `Copy`; only a value
 * chosen from outside -- an example from the picker -- is rendered into it.
 */
function* Workbench(
	this: Context,
	{
		value,
		name,
		title,
		geometry,
		controls: extraControls,
	}: {
		value: string;
		name: string;
		/** The file in the editor, where nothing else in the bar names it. */
		title?: string;
		geometry: {cols: number; rows: number; editorLines: number};
		controls?: unknown;
	},
) {
	let code = value;
	let shown = value;
	let updateEditor = true;
	let status: Status = {message: "", failed: false};
	// Bumped to ask the terminal pane for a run that does not wait out the
	// typing delay. The button and the shortcut are the same request.
	let runNonce = 0;
	let root!: HTMLDivElement;

	this.addEventListener("contentchange", (ev: any) => {
		this.refresh(() => {
			code = ev.target.value;
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

	for ({value, name, title, geometry, controls: extraControls} of this) {
		// A value from outside is a new program; a value this component's own
		// editor produced is already in `code`.
		if (value !== shown) {
			shown = code = value;
			updateEditor = true;
		}

		this.schedule(() => {
			updateEditor = false;
		});

		yield jsx`
			<div ref=${(el: HTMLDivElement) => (root = el)} class=${workbench}>
				<div class=${toolbar}>
					${title ? jsx`<span class=${filename}>${title}</span>` : null}
					${extraControls}
					<button id=${`${name}-run`} type="button" onclick=${runNow}>
						Run <kbd>${RUN_KEY_LABEL}</kbd>
					</button>
					<p
						id=${`${name}-status`}
						class="playground-status ${statusLine}"
						data-state=${status.failed ? "error" : "ok"}>
						${status.message}
					</p>
				</div>

				<div class=${panes(geometry.cols)}>
					<div class=${editorPane(geometry.editorLines)}>
						<${CodeEditor}
							copy=${!updateEditor}
							value=${code}
							language="javascript"
							showGutter
						/>
					</div>
					<${TerminalPane}
						code=${code}
						cols=${geometry.cols}
						rows=${geometry.rows}
						runNonce=${runNonce}
						onstatus=${onstatus}
					/>
				</div>
			</div>
		`;
	}
}

/** The playground page: the picker, and a workbench under it. */
function* Playground(this: Context) {
	const examples = readExamples();
	let example = examples[0];

	const onexamplechange = (ev: Event) => {
		const id = (ev.target as HTMLSelectElement).value;
		const chosen = examples.find((each) => each.id === id);
		if (!chosen) return;
		this.refresh(() => {
			example = chosen;
		});
	};

	const picker = jsx`
		<label for="playground-examples">Example</label>
		<select
			id="playground-examples"
			value=${example.id}
			onchange=${onexamplechange}
		>
			${examples.map(
				(each) => jsx`
					<option key=${each.id} value=${each.id}>${each.label}</option>
				`,
			)}
		</select>
	`;

	for ({} of this) {
		yield jsx`
			<main class=${container}>
				<h1 class=${css`
					font-size: 2.2rem;
					margin: 0 0 1rem;
				`}>Playground</h1>
				<${Workbench}
					value=${example.code}
					name="playground"
					geometry=${PAGE_GEOMETRY}
					controls=${picker}
				/>
			</main>
		`;
	}
}

/**
 * The embeds on the home page.
 *
 * Each `<figure data-playground="id">` holds the program, highlighted at build
 * time, and stays that way until it comes near the viewport: five terminals
 * booting at load is not what someone scrolling a home page asked for. What
 * replaces it is the same workbench the playground page renders, with the
 * program already in it.
 */
function hydrateEmbeds(): void {
	const embeds = [
		...document.querySelectorAll<HTMLElement>("[data-playground]"),
	].filter((embed) => !embed.hasAttribute("data-playground-ready"));
	if (!embeds.length) return;

	const examples = readExamples();
	const mount = (embed: HTMLElement): void => {
		const example = examples.find((each) => each.id === embed.dataset.playground);
		if (!example) return;
		embed.setAttribute("data-playground-ready", "");
		embed.textContent = "";
		renderer.render(
			jsx`
				<${Workbench}
					value=${example.code}
					name=${`playground-${example.id}`}
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

const root = document.getElementById("playground");
if (root) {
	renderer.render(jsx`<${Playground} />`, root);
}

hydrateEmbeds();
