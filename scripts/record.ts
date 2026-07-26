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
import {TermDOM, type ProcessLike} from "../src/index.js";

const COLS = 78;
const ROWS = 24;

interface CastEvent {
	time: number;
	data: string;
}

function makeRecorder(): {
	proc: ProcessLike;
	events: CastEvent[];
	pressKey: (key: string) => void;
	clock: {now: number};
} {
	const events: CastEvent[] = [];
	const clock = {now: 0};

	const stdout = {
		isTTY: true,
		columns: COLS,
		rows: ROWS,
		write(chunk: any, encoding?: any, callback?: any): boolean {
			if (typeof encoding === "function") callback = encoding;
			events.push({time: clock.now, data: String(chunk)});
			callback?.();
			return true;
		},
	};

	const stdin = new (class extends EventEmitter {
		isTTY = true;
		setRawMode() {
			return this;
		}
		resume() {
			return this;
		}
		pause() {
			return this;
		}
		setEncoding() {
			return this;
		}
	})();

	const proc = new (class extends EventEmitter {
		stdout = stdout;
		stdin = stdin;
		env = {TERM: "xterm-256color", COLORTERM: "truecolor"};
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

type Step = number | string | (() => void | Promise<void>);

/** Run a demo: numbers advance the recorded clock, strings are keystrokes. */
async function record(
	setup: (termdom: TermDOM) => void | Promise<void> | (() => void),
	steps: Step[],
): Promise<void> {
	const {proc, events, pressKey, clock} = makeRecorder();
	const termdom = new TermDOM({process: proc, detectCursor: false});
	const teardown = await setup(termdom);
	await termdom.render();

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

	if (typeof teardown === "function") teardown();
	termdom.dispose();

	const header = {
		version: 2,
		width: COLS,
		height: ROWS,
		env: {TERM: "xterm-256color"},
	};
	const lines = [JSON.stringify(header)];
	for (const event of events) {
		lines.push(JSON.stringify([event.time, "o", event.data]));
	}
	// eslint-disable-next-line no-console
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
