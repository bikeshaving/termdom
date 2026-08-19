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

const kSession = Symbol("session");

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
		const mtime = entry.isDirectory() ?
				newestMtime(path) :
			statSync(path).mtimeMs;
		if (mtime > newest) {
			newest = mtime;
		}
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
	declare [kSession]: string;
	constructor(session: string) {
		this[kSession] = session;
	}

	/** Visible pane text, ANSI stripped, right-trimmed rows. */
	screen(): string[] {
		return tmux("capture-pane", "-t", this[kSession], "-p").split("\n");
	}

	/** Visible pane text with SGR escapes preserved. */
	screenANSI(): string {
		return tmux("capture-pane", "-t", this[kSession], "-p", "-e");
	}

	/** Scrollback + screen; length minus the pane height is history depth. */
	full(): string[] {
		return tmux("capture-pane", "-t", this[kSession], "-p", "-S", "-").split(
			"\n",
		);
	}

	historyDepth(rows: number): number {
		return Math.max(0, this.full().length - 1 - rows);
	}

	/** A tmux format expanded against this pane (e.g. #{mouse_any_flag}). */
	display(format: string): string {
		return tmux("display-message", "-t", this[kSession], "-p", format).trim();
	}

	async resize(cols: number, rows: number): Promise<void> {
		tmux(
			"resize-window",
			"-t",
			this[kSession],
			"-x",
			`${cols}`,
			"-y",
			`${rows}`,
		);
		await sleep(700);
	}

	sendKeys(...keys: string[]): void {
		tmux("send-keys", "-t", this[kSession], ...keys);
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

const scenarios: Scenario[] = [
	{
		name: "chat composer: flat one-row field with the accent focus underline",
		command: "node examples/chat.ts",
		cols: 118,
		run: async (pane) => {
			const screen = pane.screen();
			const row = screen.findIndex(
				(l) => l.includes("›") && l.includes("message ch.at"),
			);
			assert(row > 0, "sigil and placeholder do not share the composer row");
			assert(
				!screen.some((l) => l.includes("┌")),
				"composer still draws a border box",
			);
			const ansi = pane.screenANSI().split("\n")[row];
			assert(
				ansi.includes("38;2;95;175;255"),
				"focused composer does not carry the outline accent color",
			);
			assert(
				/\x1b\[(?:[0-9]+;)*4(?:;[0-9]+)*m/.test(ansi),
				"focused composer row is not underlined",
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
		// tmux measures these clusters the way the width tables do, so what it
		// witnesses is the asking rather than the learning: a frame that appends
		// DSR after emoji-presentation glyphs and repaints over itself must
		// leave a row indistinguishable from one that never asked -- no reply
		// echoed into the cells, no column pushed along by the query.
		name: "emoji presentation: the queries a frame carries leave no mark",
		command: "node scripts/fixtures/vs16-repaint.ts",
		cols: 60,
		settle: 3000,
		run: async (pane) => {
			const row = pane.screen().find((line) => line.includes("☀"));
			assert(row !== undefined, "emoji row is not on screen");
			assert(
				row!.trimEnd() === "☀️☁️🌤️⛅️❤️ BBBB end",
				`emoji row is not what was painted: ${JSON.stringify(row)}`,
			);
		},
	},
	{
		name: "fuzzy-finder: navigation repaints on its own, keystrokes faster than frames",
		command: "node examples/fuzzy-finder.ts",
		cols: 70,
		rows: 14,
		run: async (pane) => {
			// The selection marker row: starts with the marker glyph, below the
			// input row (which carries the same sigil). tmux renders the NBSP
			// as a plain space, so match on the glyph alone.
			const marked = () =>
				pane
					.screen()
					.findIndex((l, i) => i >= 2 && l.trimStart().startsWith("\u203a"));
			const before = marked();
			assert(before > 0, "no selection marker on screen");
			// Two batched Downs in one chunk: the screen must land on the
			// SECOND row down -- a frozen or one-behind screen is the drained-
			// mutation bug. No frame is awaited anywhere but the wall clock.
			pane.sendKeys("Down", "Down");
			await sleep(900);
			const after = marked();
			assert(
				after === before + 2,
				`marker moved ${after - before} rows for two Downs (at ${after})`,
			);
		},
	},
	{
		name: "markdown pager: the fixed status bar pins while the camera scrolls",
		command: "node examples/markdown.ts",
		cols: 90,
		rows: 16,
		run: async (pane) => {
			const bottom = () =>
				pane
					.screen()
					.filter((l) => l.trim())
					.pop() ?? "";
			assert(
				bottom().includes("sample") && bottom().includes("0%"),
				"status bar missing from the viewport's bottom row",
			);
			pane.sendKeys("Space");
			await sleep(900);
			const after = bottom();
			assert(
				after.includes("sample"),
				"status bar did not stay pinned through a page scroll",
			);
			assert(
				!after.includes(" 0%"),
				"the absolute-positioned percentage did not update",
			);

			// Line scrolls ride the DECSTBM+DL/IL scroll transform; a camera
			// move is a view change, and none of it may reach the scrollback.
			const depthBefore = pane.historyDepth(16);
			for (let i = 0; i < 8; i++) {
				pane.sendKeys("Down");
				await sleep(120);
			}
			for (let i = 0; i < 4; i++) {
				pane.sendKeys("Up");
				await sleep(120);
			}
			const depthAfter = pane.historyDepth(16);
			assert(
				depthAfter === depthBefore,
				`scroll transform leaked into scrollback: depth ${depthBefore} -> ${depthAfter}`,
			);
			assert(
				bottom().includes("sample"),
				"status bar did not survive line scrolling in both directions",
			);

			// Quitting must hand the terminal back: tmux tracks whether the
			// app left mouse reporting on, which is what sprays SGR reports
			// into the freed shell.
			pane.sendKeys("q");
			await sleep(600);
			assert(
				pane.display("#{mouse_any_flag}") === "0",
				"quitting left mouse reporting enabled",
			);
			assert(
				pane.display("#{cursor_flag}") === "1",
				"quitting left the cursor hidden",
			);
			// The quit payout must put the document into the scrollback
			// exactly ONCE. A full ED from the home row would make tmux
			// archive the final frame above the payout -- the document twice,
			// interleaved -- so the payout clears per row instead.
			const copies = pane
				.full()
				.filter((line) =>
					line.includes("exercises the whole element set"),
				).length;
			assert(
				copies === 1,
				`quit payout left ${copies} copies of the document in scrollback`,
			);
		},
	},
	{
		name: "resize: a widening resize adds nothing to the scrollback",
		command: "node examples/flexbox.ts",
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
				pane.screen().some((l) => l.includes("TermDOM flexbox")),
				"frame missing after resize",
			);
		},
	},
	{
		name: "resize: narrowing garbage stays within the terminal's own reflow",
		command: "node examples/flexbox.ts",
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
				pane.screen().some((l) => l.includes("TermDOM flexbox")),
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
