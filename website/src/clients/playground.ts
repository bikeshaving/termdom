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
import {CodeEditor, editorHeight} from "../components/code-editor.js";
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

/**
 * How much terminal a context gets.
 *
 * The playground page is somewhere to work, so it gets the terminal the
 * examples are written against: eighty columns, and twenty-four rows, which is
 * one more than the tallest of them paints. An embed is a figure in an
 * argument, and a pane far taller than its program is a black void with a
 * program at the top of it -- the two programs embedded on the home page paint
 * 11x35 and 7x45, so an embed gets 56x14 and the slack is deliberate rather
 * than left over. `editorLines` is whole lines, so the box ends where a line
 * does.
 */
const PAGE_GEOMETRY = {cols: 80, rows: 24, editorLines: 20};
const EMBED_GEOMETRY = {cols: 56, rows: 14, editorLines: 13};

const FONT_SIZE = 13;
// The emulator's cell in the font stack below, measured rather than guessed.
const CELL_WIDTH = 7.83;
// What the pane adds around the emulator's own box: its padding and border.
const PANE_CHROME = 15;
const GAP = 16;
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
			GAP +
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
				void run();
			});

			// The pane is as wide as the emulator inside it and no wider: a
			// terminal stretched to fill a column is a column of background.
			yield jsx`
				<div
					ref=${(el: HTMLDivElement) => (root = el)}
					class="${pane} ${css`
						padding: 0.4rem;
						width: max-content;
						max-width: 100%;
						overflow-x: auto;
						justify-self: start;
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
	max-width: 1440px;
	margin: 0 auto;
	padding: 5rem 1.2rem 2rem;
`;

/* One row: whatever the page puts here, the run button, and the status the
   run reports. The status shares the row rather than hanging below the panes,
   so the workbench reads as a single block. */
const toolbar = css`
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 0.6rem;
	margin: 0 0 0.5rem;
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

/**
 * Editor beside terminal, or editor above terminal.
 *
 * Which one is a question about the width the workbench has, not the width
 * the window has -- the same component sits in a 900px column on the home
 * page and across the playground page -- so it is a container query, and the
 * workbench is the container.
 */
function panes(cols: number) {
	return css`
		display: grid;
		gap: ${GAP}px;
		grid-template-columns: minmax(0, 1fr);
		align-items: start;

		@container workbench (min-width: ${sideBySideWidth(cols)}px) {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	`;
}

const workbench = css`
	container: workbench / inline-size;
	margin: 0;
`;

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
		geometry,
		controls: extraControls,
	}: {
		value: string;
		name: string;
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

	for ({value, name, geometry, controls: extraControls} of this) {
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
					<div class="${pane} ${css`
						min-width: 0;
						/* The height is the editor's own box: the pane's border
						   sits outside it, so the last row stays whole. */
						box-sizing: content-box;
						height: ${editorHeight(geometry.editorLines)};
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
