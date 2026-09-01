#!/usr/bin/env bun
/**
 * Record a termdom demo as an asciinema v2 .cast file -- no screen capture,
 * no terminal, no timing jitter. A ProcessLike timestamps every byte the
 * renderer writes, and a script of keystrokes drives the app. The output
 * plays in asciinema-player on any web page and uploads to asciinema.org.
 *
 *   bun scripts/record.ts tree > tree.cast
 *   bun scripts/record.ts form > form.cast
 *   bun scripts/record.ts animated > animated.cast
 */
import {EventEmitter} from "node:events";
import {TermDOM, transportFromProcess, type ProcessLike} from "../src/index.js";

const COLS = 78;
const ROWS = 24;

interface CastEvent {
	time: number;
	data: string;
}

function makeRecorder(
	cols = COLS,
	rows = ROWS,
): {
	proc: ProcessLike;
	events: CastEvent[];
	pressKey: (key: string) => void;
	clock: {now: number};
} {
	const events: CastEvent[] = [];
	const clock = {now: 0};

	const stdout = {
		isTTY: true,
		columns: cols,
		rows,
		write(chunk: any, encoding?: any, callback?: any): boolean {
			if (typeof encoding === "function") {
				callback = encoding;
			}
			events.push({time: clock.now, data: String(chunk)});
			callback?.();
			return true;
		},
	};

	const stdin = new (class extends EventEmitter {
		isTTY: boolean;
		constructor(...args: ConstructorParameters<typeof EventEmitter>) {
			super(...args);
			this.isTTY = true;
		}

		setRawMode(): this {
			return this;
		}

		resume(): this {
			return this;
		}

		pause(): this {
			return this;
		}

		setEncoding(): this {
			return this;
		}
	})();

	const proc = new (class extends EventEmitter {
		stdout: typeof stdout;
		stdin: typeof stdin;
		env: {TERM: string; COLORTERM: string};
		constructor(...args: ConstructorParameters<typeof EventEmitter>) {
			super(...args);
			this.stdout = stdout;
			this.stdin = stdin;
			this.env = {TERM: "xterm-256color", COLORTERM: "truecolor"};
		}

		exit(): never {
			throw new Error("recording finished");
		}
	})() as unknown as ProcessLike;

	return {
		proc,
		events,
		pressKey: (key: string) => stdin.emit("data", Buffer.from(key)),
		clock,
	};
}

/** Let queued renders and stdout writes settle between scripted actions. */
function settle(): Promise<unknown> {
	return new Promise((resolve) => setTimeout(resolve, 30));
}

type Step = number | string | (() => void | Promise<void>);

/** Run a demo: numbers advance the recorded clock, strings are keystrokes. */
async function record(
	setup: (termdom: TermDOM) => void | Promise<void> | (() => void),
	steps: Step[],
	cols = COLS,
	rows = ROWS,
): Promise<void> {
	const {proc, events, pressKey, clock} = makeRecorder(cols, rows);
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	termdom.attach();
	const teardown = await setup(termdom);
	await new Promise<void>((r) =>
		termdom.window.requestAnimationFrame(() => r()),
	);

	for (const step of steps) {
		if (typeof step === "number") {
			clock.now += step;
		} else if (typeof step === "string") {
			pressKey(step);
		} else {
			await step();
		}
		await settle();
	}

	if (typeof teardown === "function") {
		teardown();
	}
	termdom.dispose();

	const header = {
		version: 2,
		width: cols,
		height: rows,
		env: {TERM: "xterm-256color"},
	};
	const lines = [JSON.stringify(header)];
	for (const event of events) {
		lines.push(JSON.stringify([event.time, "o", event.data]));
	}

	console.log(lines.join("\n"));
}

const demos: Record<string, () => Promise<void>> = {
	async tree() {
		const {default: run} = await import("./record-demos/tree.js");
		await record(run.setup, run.steps);
	},
	async form() {
		const {default: run} = await import("./record-demos/form.js");
		await record(run.setup, run.steps);
	},
	async animated() {
		const {default: run} = await import("./record-demos/animated.js");
		await record(run.setup, run.steps);
	},
	async solitaire() {
		const {default: run} = await import("./record-demos/solitaire.js");
		await record(run.setup, run.steps, 100, 32);
	},
	async readme() {
		const {default: run} = await import("./record-demos/readme.js");
		await record(run.setup, run.steps, 44, 5);
	},
};

const name = process.argv[2];
if (!name || !(name in demos)) {
	console.error(
		`usage: bun scripts/record.ts <${Object.keys(demos).join("|")}>`,
	);
	process.exit(1);
}
await demos[name]();
process.exit(0);
