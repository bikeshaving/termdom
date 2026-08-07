/**
 * Real-terminal verification against tmux.
 *
 *   npm run verify:tmux
 *
 * The unit suite renders into an xterm-headless mock; this drives the same
 * examples through an actual tmux server -- real grid, real reflow, real
 * scrollback -- and asserts on captured panes. tmux and the mock have
 * disagreed in both directions before, which is exactly why this exists.
 *
 * Everything runs on the private `-L termdom-test` socket; the user's own
 * tmux server is never touched. Examples resolve `@b9g/termdom` through the
 * package's dist, so a stale dist silently tests yesterday's engine -- the
 * harness rebuilds first when any source file is newer than the build.
 */
import {execFileSync, execSync} from "child_process";
import {readdirSync, statSync} from "fs";
import {join} from "path";

const SOCKET = "termdom-test";
const ROOT = join(import.meta.dirname, "..");

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], {encoding: "utf8"});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Newest mtime under a directory, recursively. */
function newestMtime(dir: string): number {
	let newest = 0;
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const path = join(dir, entry.name);
		const mtime = entry.isDirectory()
			? newestMtime(path)
			: statSync(path).mtimeMs;
		if (mtime > newest) newest = mtime;
	}
	return newest;
}

function ensureFreshDist(): void {
	let distTime = 0;
	try {
		distTime = statSync(join(ROOT, "dist/index.js")).mtimeMs;
	} catch {
		// No dist at all; build below.
	}
	if (newestMtime(join(ROOT, "src")) > distTime) {
		console.log("dist is stale; rebuilding…");
		execSync("npm run build", {cwd: ROOT, stdio: "inherit"});
	}
}

interface Scenario {
	name: string;
	command: string;
	cols?: number;
	rows?: number;
	/** Settle time before the first capture, in ms. */
	settle?: number;
	run(pane: Pane): Promise<void>;
}

class Pane {
	#session: string;
	constructor(session: string) {
		this.#session = session;
	}

	/** Visible pane text, ANSI stripped, right-trimmed rows. */
	screen(): string[] {
		return tmux("capture-pane", "-t", this.#session, "-p").split("\n");
	}

	/** Visible pane text with SGR escapes preserved. */
	screenANSI(): string {
		return tmux("capture-pane", "-t", this.#session, "-p", "-e");
	}

	/** Scrollback + screen; length minus the pane height is history depth. */
	full(): string[] {
		return tmux("capture-pane", "-t", this.#session, "-p", "-S", "-").split(
			"\n",
		);
	}

	historyDepth(rows: number): number {
		return Math.max(0, this.full().length - 1 - rows);
	}

	async resize(cols: number, rows: number): Promise<void> {
		tmux(
			"resize-window",
			"-t",
			this.#session,
			"-x",
			`${cols}`,
			"-y",
			`${rows}`,
		);
		await sleep(700);
	}

	sendKeys(...keys: string[]): void {
		tmux("send-keys", "-t", this.#session, ...keys);
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

const scenarios: Scenario[] = [
	{
		name: "chat composer: bordered textarea is 3 rows and lights up on focus",
		command: "node examples/chat.ts",
		cols: 118,
		run: async (pane) => {
			const screen = pane.screen();
			const top = screen.findIndex((l) => l.includes("┌"));
			assert(top > 0, "no border top row on screen");
			assert(
				screen[top + 1].includes("│") &&
					screen[top + 1].includes("message ch.at"),
				"row below border top is not the placeholder content row",
			);
			assert(screen[top + 2].includes("└"), "no border bottom on third row");
			assert(
				pane.screenANSI().includes("38;2;95;175;255"),
				"focused composer border does not carry the outline accent color",
			);
		},
	},
	{
		name: "emoji exit: wide characters keep their columns through the static flush",
		command: "node scripts/fixtures/emoji-exit.ts",
		cols: 60,
		settle: 2500,
		run: async (pane) => {
			const text = pane.full().join("\n");
			assert(
				text.includes("a🙂b🎉c end-marker"),
				"emoji row shifted or lost columns on the exit reprint",
			);
			assert(text.includes("🙂 one wide"), "wide-char row missing after exit");
		},
	},
	{
		name: "resize: a widening resize adds nothing to the scrollback",
		command: "node examples/flexbox-demo.ts",
		cols: 60,
		run: async (pane) => {
			assert(
				pane.historyDepth(30) === 0,
				"scrollback is not empty before the resize",
			);
			await pane.resize(100, 30);
			const depth = pane.historyDepth(30);
			assert(
				depth === 0,
				`widening resize pushed ${depth} rows into scrollback`,
			);
			assert(
				pane.screen().some((l) => l.includes("TTY Flexbox Demo")),
				"frame missing after resize",
			);
		},
	},
	{
		name: "resize: narrowing garbage stays within the terminal's own reflow",
		command: "node examples/flexbox-demo.ts",
		cols: 100,
		run: async (pane) => {
			await pane.resize(60, 30);
			// The terminal itself pushes rewrapped overflow above the screen top
			// before the app ever sees SIGWINCH; that bound is one old frame.
			// Anything past it would be the app stranding copies again.
			const depth = pane.historyDepth(30);
			assert(
				depth <= 30,
				`narrowing left ${depth} scrollback rows -- more than one reflowed frame`,
			);
			assert(
				pane.screen().some((l) => l.includes("TTY Flexbox Demo")),
				"frame missing after resize",
			);
		},
	},
];

async function main(): Promise<void> {
	ensureFreshDist();
	try {
		tmux("kill-server");
	} catch {
		// No server running on the private socket; fine.
	}

	let failures = 0;
	for (const scenario of scenarios) {
		const session = `verify-${scenarios.indexOf(scenario)}`;
		const cols = scenario.cols ?? 100;
		const rows = scenario.rows ?? 30;
		try {
			tmux(
				"new-session",
				"-d",
				"-s",
				session,
				"-x",
				`${cols}`,
				"-y",
				`${rows}`,
				`cd ${ROOT} && ${scenario.command}; sleep 60`,
			);
			await sleep(scenario.settle ?? 3500);
			await scenario.run(new Pane(session));
			console.log(`✓ ${scenario.name}`);
		} catch (err) {
			failures++;
			console.error(`✗ ${scenario.name}`);
			console.error(`  ${(err as Error).message}`);
		} finally {
			try {
				tmux("kill-session", "-t", session);
			} catch {
				// Session already gone.
			}
		}
	}

	try {
		tmux("kill-server");
	} catch {
		// Last session's exit already stopped it.
	}
	if (failures > 0) {
		console.error(`\n${failures} of ${scenarios.length} scenarios failed`);
		process.exit(1);
	}
	console.log(`\nall ${scenarios.length} scenarios passed`);
}

await main();
