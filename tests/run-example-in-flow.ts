/**
 * Runs one example under three shell rows, in a process of its own, and
 * presses keys. Exits 0 when the example drew and left the shell's rows
 * as they were, and 1 with the reason on stderr otherwise. A frame that
 * scrolls the terminal under the rows it was given throws from the
 * mock, which ends the process with that error.
 *
 *   bun tests/run-example-in-flow.ts prism
 */
import {MockProcess} from "./test-utils.ts";

interface Loaded {
	contents: string;
	loader: "ts";
}

const {Bun} = globalThis as unknown as {
	Bun: {
		file(path: string): {text(): Promise<string>};
		plugin(options: {
			name: string;
			setup(build: {
				onLoad(
					options: {filter: RegExp},
					load: (args: {path: string}) => Promise<Loaded>,
				): void;
			}): void;
		}): void;
	};
};

// The runner's own way out, before an example's is taken from it below.
const exit = process.exit.bind(process);
const name = process.argv[2];
const example = new URL(`../examples/${name}.ts`, import.meta.url);
const SHELL = ["$ cd termdom", "$ ls", "$ bun examples/run.ts"];
// Digits, arrows and Tab: what the examples pick, move and switch with.
// Never q, which quits.
const KEYS = ["2", "3", "\x1b[B", "\x1b[B", "\t", "\x1b[C", "1", "\x1b[A"];

const terminal = new MockProcess({cols: 100, rows: 40});
(terminal as any).terminal.write(SHELL.map((line) => `${line}\r\n`).join(""));
await new Promise((resolve) => setTimeout(resolve, 20));

const made: unknown[] = [];
(globalThis as any).__flowTermDOM = (Base: any) =>
	class extends Base {
		constructor(options: object = {}) {
			super({...options, transport: terminal.sharedTransport});
			made.push(this);
		}
	};
Bun.plugin({
	name: "example in flow",
	setup(build) {
		build.onLoad(
			{filter: /\/examples\/[^/]+\.ts$/},
			async ({path}) => ({
				contents: (await Bun.file(path).text()).replaceAll(
					"new TermDOM(",
					"new ((globalThis as any).__flowTermDOM(TermDOM))(",
				),
				loader: "ts",
			}),
		);
	},
});

// An example that quits on a key ends through the mock's process.exit,
// which throws. That is a way to finish, not a failure.
function quit(error: unknown): boolean {
	return error instanceof Error &&
		error.message.startsWith("Mock process.exit");
}

function fail(error: unknown): void {
	if (!quit(error)) {
		console.error(error instanceof Error ? error.message : error);
		exit(1);
	}
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The command line the example would have had, which some read, run from
// the examples, which fuzzy-finder lists, rather than whatever the suite
// is writing around it.
process.argv = [process.argv[0], example.pathname];
process.chdir(new URL(".", example).pathname);
// An example that ends itself ends the same way.
process.exit = ((code?: number) => {
	throw new Error(`Mock process.exit(${code ?? 0})`);
}) as typeof process.exit;
// Written to and settled, by the clock of what reaches the terminal, not a
// guess at it: a loaded machine draws later than a quiet one.
let writes = 0;
let frames = 0;
const write = terminal.stdout.write.bind(terminal.stdout);
terminal.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
	writes++;
	if (String(chunk).includes("\x1b7")) {
		frames++;
	}
	return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof terminal.stdout.write;

// An animation never settles, so a second is enough of it.
async function settle(): Promise<void> {
	for (let waited = 0; waited < 1000;) {
		const before = writes;
		await wait(150);
		waited += 150;
		if (writes === before) {
			return;
		}
	}
}

try {
	await import(example.href);
} catch (error) {
	if (!quit(error)) {
		throw error;
	}
}
for (let waited = 0; frames === 0 && waited < 10000; waited += 50) {
	await wait(50);
}
await settle();
for (const key of KEYS) {
	terminal.stdin.simulateResponse(key);
	await settle();
}

// From the top of the normal screen's scrollback: a page taller than the
// screen pushes the shell's rows up into it, one drawn too high writes
// over them, and a fullscreen page draws on the alternate screen.
const buffer = (terminal as any).terminal.buffer.normal;
const rows = SHELL.map((_, row) =>
	buffer.getLine(row)?.translateToString(true));
if (made.length === 0) {
	console.error(`${name} made no TermDOM`);
	exit(1);
}
if (JSON.stringify(rows) !== JSON.stringify(SHELL)) {
	console.error(`the shell's rows became ${JSON.stringify(rows)}`);
	exit(1);
}
exit(0);
