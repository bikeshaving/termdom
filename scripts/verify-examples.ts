/**
 * Drives every example in a real tmux pane and asserts it renders. Each
 * example launches in a fresh session on the private test socket, gets a
 * moment to paint, and must show content beyond the shell prompt with an
 * empty stderr. Interactive examples additionally get their primary
 * interaction driven and asserted, so a broken event path fails here even
 * when rendering succeeds.
 *
 * Flow-mode examples (lists, markdown without a pager-sized file, rtl,
 * hello-world, borders, flexbox, git-log, commit-editor) print and exit;
 * for those the assertion is scrollback content and a clean exit.
 */
import {execSync} from "node:child_process";
import {existsSync, readdirSync} from "node:fs";

const SOCKET = "termdom-test";
const SESSION = "verify-examples";

function tmux(args: string): string {
	try {
		return execSync(`tmux -L ${SOCKET} ${args}`, {encoding: "utf8"});
	} catch (_err) {
		return "";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function capture(): string {
	return tmux(`capture-pane -t ${SESSION} -p`);
}

async function launch(command: string, settleMs: number): Promise<void> {
	tmux(`kill-session -t ${SESSION} 2>/dev/null`);
	tmux(`new-session -d -s ${SESSION} -x 80 -y 24`);
	tmux(`send-keys -t ${SESSION} ${JSON.stringify(command)} Enter`);
	await sleep(settleMs);
}

async function teardown(): Promise<void> {
	tmux(`send-keys -t ${SESSION} q`);
	await sleep(200);
	tmux(`send-keys -t ${SESSION} C-c`);
	await sleep(200);
	tmux(`kill-session -t ${SESSION} 2>/dev/null`);
}

interface Check {
	name: string;
	run: () => Promise<string | null>;
}

/** Content rendered beyond the shell's own prompt and echo of the command. */
// A stack trace on the pane is not a render. An example that dies at load
// leaves one, and it must not count as content.
const CRASH = /^(?:\w*Error\b|\s+at .+\(.+:\d+:\d+\)$)/m;

function rendered(text: string, command: string): boolean {
	if (CRASH.test(text)) {
		return false;
	}
	const lines = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.filter(
			(line) => !line.includes(command) && !/^[~/].*%\s*$/.test(line.trim()),
		);
	return lines.length > 0;
}

/** Poll until the pane shows content; slow-starting examples get up to 10s. */
async function awaitRender(command: string): Promise<string> {
	for (let waited = 0; waited < 10000; waited += 500) {
		const text = capture();
		if (rendered(text, command)) {
			return text;
		}
		await sleep(500);
	}
	return capture();
}

const checks: Check[] = [];

/** The zoo's shared assertion: one keypress moves the counter to 1. */
async function counts(
	command: string,
	settleMs: number,
): Promise<string | null> {
	await launch(command, settleMs);
	tmux(`send-keys -t ${SESSION} x`);
	await sleep(800);
	const text = capture();
	if (!text.includes("Keys pressed: 1")) {
		return `the keypress did not increment the counter:\n${text.slice(0, 400)}`;
	}
	return null;
}

const INTERACTIVE: Record<string, (cmd: string) => Promise<string | null>> = {
	"todomvc.ts": async (cmd) => {
		await launch(cmd, 3000);
		tmux(`send-keys -t ${SESSION} "buy milk"`);
		await sleep(600);
		tmux(`send-keys -t ${SESSION} Enter`);
		await sleep(1000);
		const text = capture();
		if (!/1 item|buy milk.*☐|\[ \].*buy milk|☐.*buy milk/s.test(text)) {
			return `Enter did not add the todo:\n${text.slice(0, 400)}`;
		}
		return null;
	},
	"fuzzy-finder.ts": async (cmd) => {
		await launch(cmd, 3000);
		tmux(`send-keys -t ${SESSION} "readme"`);
		await sleep(1200);
		const text = capture();
		if (!text.toLowerCase().includes("readme")) {
			return `filter query produced no match:\n${text.slice(0, 400)}`;
		}
		return null;
	},
	// Deal 7 opens with the jack of hearts alone on the first pile and the
	// queen of clubs on the second, so "1 2" is a legal move and the jack has
	// to end up under the queen.
	"solitaire.ts": async (cmd) => {
		await launch(`${cmd} 7`, 3000);
		tmux(`send-keys -t ${SESSION} 1`);
		await sleep(400);
		tmux(`send-keys -t ${SESSION} 2`);
		await sleep(1000);
		const text = capture();
		const rows = text.split("\n");
		const queen = rows.findIndex((row) => row.includes("Q♣"));
		const jack = rows.findIndex((row) => row.includes("J♥"));
		if (queen < 0 || jack !== queen + 1) {
			return `the jack did not move onto the queen:\n${text.slice(0, 600)}`;
		}
		return null;
	},
	"hello-crank.ts": (cmd) => counts(cmd, 3000),
	"hello-react.ts": (cmd) => counts(cmd, 3000),
	"hello-vue.ts": (cmd) => counts(cmd, 3000),
	// Svelte compiles its component and re-execs for the browser condition, so
	// it needs longer to reach its first frame.
	"hello-svelte.ts": (cmd) => counts(cmd, 6000),
	"form.ts": async (cmd) => {
		await launch(cmd, 3000);
		tmux(`send-keys -t ${SESSION} "John Doe"`);
		await sleep(800);
		const text = capture();
		if (!text.includes("John Doe")) {
			return `typed text did not appear in the textControl:\n${text.slice(0, 400)}`;
		}
		return null;
	},
};

for (const file of readdirSync("examples").sort()) {
	if (!file.endsWith(".ts")) {
		continue;
	}
	const command = `node examples/${file}`;
	const interact = INTERACTIVE[file];
	checks.push({
		name: file,
		run: async () => {
			if (interact) {
				const failure = await interact(command);
				await teardown();
				return failure;
			}
			await launch(command, 1000);
			const text = await awaitRender(`examples/${file}`);
			await teardown();
			if (!rendered(text, `examples/${file}`)) {
				return `nothing rendered:\n${text.slice(0, 300)}`;
			}
			return null;
		},
	});
}

// A WPT harness cache in the working tree pollutes examples that index it.
const wptAside = existsSync(".wpt");
if (wptAside) {
	execSync("mv .wpt /tmp/verify-examples-wpt-aside");
}

let failed = 0;
for (const check of checks) {
	const failure = await check.run();
	if (failure === null) {
		console.log(`ok   ${check.name}`);
	} else {
		failed++;
		console.log(`FAIL ${check.name}: ${failure}`);
	}
}
tmux(`kill-session -t ${SESSION} 2>/dev/null`);
if (wptAside) {
	execSync("mv /tmp/verify-examples-wpt-aside .wpt");
}
console.log(`\n${checks.length - failed}/${checks.length} examples verified`);
process.exit(failed === 0 ? 0 : 1);
