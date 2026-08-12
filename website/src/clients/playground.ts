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

import {TermDOM} from "../../../src/index.js";
import type {
	TerminalTransport,
	TerminalSize,
	TerminalCloseInfo,
} from "../../../src/index.js";
import {CodeEditor} from "../components/code-editor.js";
// The model is a build-time module -- it reads the repository's examples off
// disk -- so only its type comes along; the programs themselves arrive in the
// page, in the script element the view wrote them to.
import type {PlaygroundExample} from "../models/playground-examples.js";

if (!window.customElements.get("content-area")) {
	window.customElements.define("content-area", ContentAreaElement);
}

// Matches EXAMPLES_SCRIPT_ID in the model the view renders with.
const EXAMPLES_SCRIPT_ID = "playground-examples-data";

function readExamples(): PlaygroundExample[] {
	const script = document.getElementById(EXAMPLES_SCRIPT_ID);
	return script ? JSON.parse(script.textContent!) : [];
}

const COLS = 80;
const ROWS = 24;
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

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
		this.closed = new Promise((resolve) => {
			this.#closeSession = resolve;
		});

		// Both readable ends subscribe on the first pull and unsubscribe when
		// cancelled, so a transport nobody reads never takes the emulator's
		// input -- the same contract the process transport keeps with a tty.
		let dataSubscription: {dispose(): void} | null = null;
		this.readable = new ReadableStream<string>(
			{
				pull: (controller) => {
					if (dataSubscription) return;
					dataSubscription = terminal.onData((data) =>
						controller.enqueue(data),
					);
				},
				cancel: () => {
					dataSubscription?.dispose();
					dataSubscription = null;
				},
			},
			{highWaterMark: 0},
		);

		let resizeSubscription: {dispose(): void} | null = null;
		this.resizes = new ReadableStream<TerminalSize>(
			{
				pull: (controller) => {
					if (resizeSubscription) return;
					resizeSubscription = terminal.onResize(({cols, rows}) =>
						controller.enqueue({cols, rows}),
					);
				},
				cancel: () => {
					resizeSubscription?.dispose();
					resizeSubscription = null;
				},
			},
			{highWaterMark: 0},
		);

		// Resolve on the emulator's own callback: a written frame is one the
		// emulator has parsed, which is what frame ordering rests on.
		this.writable = new WritableStream<string>({
			write: (chunk) =>
				new Promise<void>((resolve) => terminal.write(chunk, resolve)),
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
}

/**
 * Page globals a program has no business reaching. Shadowed as parameters of
 * the function the code is compiled into, so a reference resolves to
 * `undefined` rather than to the playground's own page. Everything the
 * terminal's window defines shadows the page's equivalent as well (see
 * `runProgram`), which covers `document`, the DOM interfaces and the
 * observers; these are the names left over.
 */
const BLOCKED_GLOBALS = [
	"top",
	"parent",
	"frames",
	"opener",
	"frameElement",
	"location",
	"history",
	"screen",
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"caches",
	"cookieStore",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"EventSource",
	"Worker",
	"SharedWorker",
	"ServiceWorker",
	"BroadcastChannel",
	"Notification",
	"alert",
	"confirm",
	"prompt",
	"print",
	"open",
	"postMessage",
	"importScripts",
];

const RESERVED_WORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"arguments",
	"eval",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const AsyncFunction = Object.getPrototypeOf(async function () {})
	.constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** One program's lifetime: its engine, its timers, and the way to end both. */
interface Run {
	stop(): Promise<void>;
}

/**
 * Compile `code` and run it against a fresh TermDOM attached to `terminal`.
 *
 * The code is compiled into an async function whose parameters shadow the
 * page: `document` and `window` are the terminal's, the timer functions are
 * tracked so `stop()` can cancel them, and the globals that would reach the
 * playground's own page are bound to `undefined`. Callbacks are wrapped so a
 * throw from a timer reports rather than vanishing into the console.
 */
async function runProgram(
	terminal: Terminal,
	code: string,
	report: (error: unknown) => void,
): Promise<Run> {
	const transport = new XtermTransport(terminal);
	const term = new TermDOM({transport});
	const engineWindow = term.window as unknown as Record<string, unknown>;

	const timeouts = new Set<number>();
	const intervals = new Set<number>();
	const frames = new Set<number>();

	const guard =
		(callback: (...args: unknown[]) => unknown) =>
		(...args: unknown[]): unknown => {
			try {
				return callback(...args);
			} catch (error) {
				report(error);
			}
		};

	const names: string[] = [];
	const values: unknown[] = [];
	const bind = (name: string, value: unknown): void => {
		if (names.includes(name)) return;
		names.push(name);
		values.push(value);
	};

	// The first binding of a name wins, so the tracked timers below are bound
	// before the terminal's window contributes its own untracked ones.
	bind("term", term);
	bind("document", term.document);
	bind("window", term.window);
	bind("self", term.window);
	bind("globalThis", term.window);
	bind("setTimeout", (callback: never, delay?: number, ...rest: unknown[]) => {
		const id = window.setTimeout(guard(callback), delay, ...rest);
		timeouts.add(id);
		return id;
	});
	bind("clearTimeout", (id: number) => {
		timeouts.delete(id);
		window.clearTimeout(id);
	});
	bind("setInterval", (callback: never, delay?: number, ...rest: unknown[]) => {
		const id = window.setInterval(guard(callback), delay, ...rest);
		intervals.add(id);
		return id;
	});
	bind("clearInterval", (id: number) => {
		intervals.delete(id);
		window.clearInterval(id);
	});
	// Animation frames come from the engine, not the browser: they are the
	// hook a program uses to wait for a painted frame.
	bind("requestAnimationFrame", (callback: never) => {
		const id = (engineWindow.requestAnimationFrame as (cb: unknown) => number)(
			guard(callback),
		);
		frames.add(id);
		return id;
	});
	bind("cancelAnimationFrame", (id: number) => {
		frames.delete(id);
		(engineWindow.cancelAnimationFrame as (id: number) => void)?.(id);
	});

	// A name the terminal's window defines is a name the page must not
	// supply. Accessors are skipped: `window.scrollY` has to stay live, and a
	// parameter would freeze it at whatever it read when the program started.
	for (const name of Object.getOwnPropertyNames(term.window)) {
		if (!IDENTIFIER.test(name) || RESERVED_WORDS.has(name)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(term.window, name);
		if (!descriptor || descriptor.get) continue;
		bind(name, descriptor.value);
	}

	for (const name of BLOCKED_GLOBALS) bind(name, undefined);

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		for (const id of timeouts) window.clearTimeout(id);
		for (const id of intervals) window.clearInterval(id);
		for (const id of frames) {
			(engineWindow.cancelAnimationFrame as (id: number) => void)?.(id);
		}
		timeouts.clear();
		intervals.clear();
		frames.clear();
		await term.dispose();
		transport.close();
	};

	// Compiled before attaching: a syntax error should surface without the
	// terminal having been taken over and handed straight back.
	//
	// The code goes in a nested scope so that a `const document = ...` of its
	// own shadows the parameter rather than colliding with it, which is what a
	// declaration at the top level of a script does.
	const program = new AsyncFunction(
		...names,
		`"use strict";\nreturn (async () => {\n${code}\n})();\n//# sourceURL=playground.js`,
	);

	try {
		await term.attach();
		await program(...values);
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

const pane = css`
	border: 1px solid var(--border-color);
	border-radius: 6px;
	overflow: hidden;
	background-color: var(--surface-color);
`;

/**
 * The terminal half: an emulator opened once, and one program at a time
 * running against it.
 *
 * The emulator, its element and the run loop all outlive any single program,
 * so this yields a `Copy` after the first render -- Crank never touches the
 * subtree xterm.js owns. A new `code` prop is a new program, run once the
 * typing stops; a new `runNonce` is the reader asking for one now. Either way
 * the running program is stopped and disposed before the next is compiled,
 * and `generation` settles the race where a run starts while an older one is
 * still tearing down.
 */
function* TerminalPane(
	this: Context,
	{
		code,
		runNonce,
		onstatus,
	}: {code: string; runNonce: number; onstatus: (status: Status) => void},
) {
	const terminal = new Terminal({
		cols: COLS,
		rows: ROWS,
		convertEol: false,
		cursorBlink: false,
		fontSize: 13,
		fontFamily:
			'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
		theme: {
			background: TERMINAL_BACKGROUND,
			foreground: TERMINAL_FOREGROUND,
		},
	});

	let root!: HTMLDivElement;
	let current: Run | null = null;
	let generation = 0;
	let autoRunTimer = 0;

	const run = async (): Promise<void> => {
		window.clearTimeout(autoRunTimer);
		const mine = ++generation;
		if (current) {
			const previous = current;
			current = null;
			await previous.stop();
		}

		// A newer run started while the last one was tearing down; that run
		// owns the terminal now.
		if (mine !== generation) return;
		terminal.reset();
		onstatus({message: "Running.", failed: false});
		try {
			const started = await runProgram(terminal, code, (error) =>
				onstatus({message: describeError(error), failed: true}),
			);
			if (mine !== generation) {
				await started.stop();
				return;
			}

			current = started;
		} catch (error) {
			onstatus({message: describeError(error), failed: true});
		}
	};

	const scheduleRun = (): void => {
		window.clearTimeout(autoRunTimer);
		autoRunTimer = window.setTimeout(() => void run(), AUTO_RUN_DELAY);
	};

	this.cleanup(() => {
		window.clearTimeout(autoRunTimer);
		void current?.stop();
		terminal.dispose();
	});

	let initial = true;
	let lastCode = code;
	let lastNonce = runNonce;
	for ({code, runNonce, onstatus} of this) {
		if (initial) {
			this.after(() => {
				terminal.open(root);
				void run();
			});

			yield jsx`
				<div
					ref=${(el: HTMLDivElement) => (root = el)}
					class="${pane} ${css`
						padding: 0.4rem;
						overflow-x: auto;
						background-color: ${TERMINAL_BACKGROUND};
					`}"
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
	max-width: 1200px;
	margin: 0 auto;
	padding: 5rem 1.2rem 2rem;
`;

const controls = css`
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 0.75rem;
	margin: 0 0 1rem;
	flex-wrap: wrap;

	select,
	button {
		font: inherit;
		font-size: 0.9rem;
		color: var(--text-color);
		background-color: var(--surface-color);
		border: 1px solid var(--border-color);
		border-radius: 6px;
		padding: 0.4rem 0.8rem;
	}

	button {
		cursor: pointer;
		font-weight: bold;
	}

	button:hover {
		color: var(--highlight-color);
		border-color: var(--highlight-color);
	}

	button kbd {
		font: inherit;
		font-weight: normal;
		color: var(--muted-color);
		margin-left: 0.4rem;
	}
`;

/* Editor and terminal sit side by side when there is room for eighty columns
   plus an editor, and stack when there is not. */
const panes = css`
	display: grid;
	gap: 1rem;
	grid-template-columns: 1fr;
	align-items: start;

	@media screen and (min-width: 1100px) {
		grid-template-columns: 1fr auto;
	}
`;

const statusLine = css`
	margin: 1rem 0 0;
	font-size: 0.85rem;
	color: var(--muted-color);
	min-height: 1.4em;
	white-space: pre-wrap;

	&[data-state="error"] {
		color: #f85149;
	}
`;

/**
 * The page: the editor owns the text, the terminal pane owns the program, and
 * this owns the one string that passes between them.
 *
 * The editor re-renders itself as it is typed in, so a keystroke arrives here
 * as `contentchange` and the editor is handed back a `Copy`; only a value this
 * component chose -- an example from the picker -- is rendered into it.
 */
function* Playground(this: Context) {
	const examples = readExamples();
	let code = examples[0].code;
	let exampleID = examples[0].id;
	let updateEditor = true;
	let status: Status = {message: "", failed: false};
	// Bumped to ask the terminal pane for a run that does not wait out the
	// typing delay. The button and the shortcut are the same request.
	let runNonce = 0;

	this.addEventListener("contentchange", (ev: any) => {
		this.refresh(() => {
			code = ev.target.value;
		});
	});

	const onexamplechange = (ev: Event) => {
		const id = (ev.target as HTMLSelectElement).value;
		const example = examples.find((each) => each.id === id);
		if (!example) return;
		this.refresh(() => {
			exampleID = example.id;
			code = example.code;
			updateEditor = true;
		});
	};

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
	// keyboard can be. It is a capture-phase listener on the window because
	// both things that take keys here stop the event before it bubbles: the
	// emulator cancels the keys it handles, and the editor turns Enter into an
	// indented newline.
	const onkeydown = (ev: KeyboardEvent) => {
		if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey)) return;
		ev.preventDefault();
		ev.stopPropagation();
		runNow();
	};

	window.addEventListener("keydown", onkeydown, true);
	this.cleanup(() => window.removeEventListener("keydown", onkeydown, true));

	for ({} of this) {
		this.schedule(() => {
			updateEditor = false;
		});

		yield jsx`
			<main class=${container}>
				<h1 class=${css`
					font-size: 2.2rem;
					margin: 0 0 2rem;
				`}>Playground</h1>

				<div class=${controls}>
					<label for="playground-examples">Example</label>
					<select
						id="playground-examples"
						value=${exampleID}
						onchange=${onexamplechange}
					>
						${examples.map(
							(example) => jsx`
								<option key=${example.id} value=${example.id}>
									${example.label}
								</option>
							`,
						)}
					</select>
					<button id="playground-run" type="button" onclick=${runNow}>
						Run <kbd>${RUN_KEY_LABEL}</kbd>
					</button>
				</div>

				<div class=${panes}>
					<div class="${pane} ${css`
						min-width: 0;
						height: 420px;
					`}">
						<${CodeEditor}
							copy=${!updateEditor}
							value=${code}
							language="javascript"
							showGutter
						/>
					</div>
					<${TerminalPane}
						code=${code}
						runNonce=${runNonce}
						onstatus=${onstatus}
					/>
				</div>

				<p
					id="playground-status"
					class=${statusLine}
					data-state=${status.failed ? "error" : "ok"}>
					${status.message}
				</p>
			</main>
		`;
	}
}

const root = document.getElementById("playground");
if (root) {
	renderer.render(jsx`<${Playground} />`, root);
}
