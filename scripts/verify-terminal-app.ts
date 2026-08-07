/**
 * Baseline verification against the real Terminal.app.
 *
 *   npm run verify:terminal
 *
 * Terminal.app is the support baseline, and no mock answers for it: this
 * drives real windows over AppleScript -- run a scenario, read the tab's
 * `contents` (visible screen) and `history` (screen + scrollback), resize
 * through the tab's row/column properties -- and asserts on what the real
 * renderer shows. Capture is plain text: geometry, wrapping, wide-character
 * columns and scrollback are checkable; colors are not (that is what the
 * tmux harness's -e captures are for).
 *
 * Local-only by nature: it opens windows and needs the one-time Automation
 * permission (System Settings > Privacy & Security > Automation) for the
 * calling terminal to control Terminal.app. Each scenario's window closes
 * when it finishes.
 */
import {execFileSync, execSync} from "child_process";
import {statSync} from "fs";
import {join} from "path";

const ROOT = join(import.meta.dirname, "..");

function osascript(script: string): string {
	return execFileSync("osascript", ["-e", script], {encoding: "utf8"}).trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function ensureFreshDist(): void {
	// The tmux harness carries the full staleness check; here the cheap probe
	// is enough to catch the common case of running straight after an edit.
	try {
		statSync(join(ROOT, "dist/index.js"));
	} catch {
		execSync("npm run build", {cwd: ROOT, stdio: "inherit"});
	}
}

/**
 * One Terminal.app window running a command. The tab's tty is the ONLY
 * identity used, ever: `front window` can be anyone's window, and closing or
 * killing by anything fuzzier risks the user's own sessions. Every query
 * walks to exactly the tab with this tty; teardown kills exactly the
 * processes on this tty and closes exactly the window holding it.
 */
class TerminalWindow {
	#tty: string;
	#windowId: string;

	constructor(command: string, cols: number, rows: number) {
		// Resolve BOTH identities up front, while the tab is alive: the tty
		// addresses the tab for reads and scopes the teardown kills, and the
		// window id is what close() uses -- a dead tab stops answering for its
		// tty, but a window closes by id in any state.
		const [tty, windowId] = osascript(`
			tell application "Terminal"
				set newTab to do script "cd ${ROOT} && ${command}"
				set number of columns of newTab to ${cols}
				set number of rows of newTab to ${rows}
				set ttyId to tty of newTab
				repeat with w in (get windows)
					try
						if tty of selected tab of w is ttyId then
							return ttyId & "|" & (id of w)
						end if
					end try
				end repeat
				error "window for " & ttyId & " not found"
			end tell
		`).split("|");
		this.#tty = tty;
		this.#windowId = windowId;
	}

	#tabProperty(property: "contents" | "history"): string {
		// The tab must be addressed as `selected tab of w`, never through a
		// loop variable: `contents of t` hits AppleScript's dereference
		// operator and returns the tab's specifier string instead of its text.
		// Every window this harness opens holds exactly one (selected) tab.
		return osascript(`
			tell application "Terminal"
				repeat with w in (get windows)
					try
						if tty of selected tab of w is "${this.#tty}" then
							return ${property} of selected tab of w
						end if
					end try
				end repeat
				error "harness tab ${this.#tty} not found"
			end tell
		`);
	}

	/** The visible screen as plain text. */
	contents(): string {
		return this.#tabProperty("contents");
	}

	/** Screen plus scrollback as plain text. */
	history(): string {
		return this.#tabProperty("history");
	}

	async resize(cols: number, rows: number): Promise<void> {
		osascript(`
			tell application "Terminal"
				repeat with w in (get windows)
					try
						if tty of selected tab of w is "${this.#tty}" then
							set number of columns of selected tab of w to ${cols}
							set number of rows of selected tab of w to ${rows}
							return
						end if
					end try
				end repeat
			end tell
		`);
		await sleep(900);
	}

	async close(): Promise<void> {
		// End the scenario's processes first -- closing a busy tab pops
		// Terminal's confirm sheet, which strands the window AND blocks every
		// later scripted close. pkill -t does not match reliably on macOS, so
		// list the tty's pids with ps and kill each one.
		try {
			const pids = execFileSync(
				"ps",
				["-t", this.#tty.replace("/dev/", ""), "-o", "pid="],
				{encoding: "utf8"},
			)
				.split("\n")
				.map((l) => parseInt(l, 10))
				.filter((pid) => Number.isFinite(pid));
			for (const pid of pids) {
				try {
					process.kill(pid);
				} catch {
					// Already gone, or not ours (login is root's); the shell
					// dying is what frees the tab either way.
				}
			}
		} catch {
			// No processes on the tty; it already exited.
		}
		await sleep(500);
		// Close by window id: a dead tab stops answering for its tty, but the
		// id keeps working in any state. Cleanup must never throw.
		try {
			osascript(`
				tell application "Terminal"
					close (every window whose id is ${this.#windowId})
				end tell
			`);
		} catch (err) {
			console.error(
				`  warning: window ${this.#windowId} did not close: ${(err as Error).message}`,
			);
		}
	}
}

/** Rows of `text` that hold anything, with trailing blanks dropped. */
function nonEmptyRows(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0);
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

interface Scenario {
	name: string;
	command: string;
	cols?: number;
	rows?: number;
	settle?: number;
	run(win: TerminalWindow): Promise<void>;
}

const scenarios: Scenario[] = [
	{
		name: "chat composer: bordered textarea is 3 rows in Terminal.app",
		command: "node examples/chat.ts",
		cols: 118,
		run: async (win) => {
			const rows = win.contents().split(/\r?\n/);
			const top = rows.findIndex((l) => l.includes("┌"));
			assert(top >= 0, "no border top row on screen");
			assert(
				rows[top + 1]?.includes("│") &&
					rows[top + 1]?.includes("message ch.at"),
				"row below border top is not the placeholder content row",
			);
			assert(rows[top + 2]?.includes("└"), "no border bottom on third row");
		},
	},
	{
		name: "emoji exit: wide characters keep their columns in Terminal.app",
		command: "node scripts/fixtures/emoji-exit.ts",
		cols: 60,
		settle: 3000,
		run: async (win) => {
			const text = win.history();
			assert(
				text.includes("a🙂b🎉c end-marker"),
				"emoji row shifted or lost columns on the exit reprint",
			);
			assert(text.includes("🙂 one wide"), "wide-char row missing after exit");
		},
	},
	{
		name: "resize: the frame survives a narrow-and-back without duplicating itself",
		command: "node examples/flexbox.ts",
		cols: 100,
		run: async (win) => {
			await win.resize(70, 30);
			await win.resize(100, 30);
			const headers = nonEmptyRows(win.contents()).filter((l) =>
				l.includes("TTY Flexbox Demo"),
			);
			assert(
				headers.length === 1,
				`expected exactly one frame header on screen, found ${headers.length}`,
			);
		},
	},
];

async function main(): Promise<void> {
	ensureFreshDist();
	try {
		osascript(`tell application "Terminal" to count windows`);
	} catch {
		console.error(
			"cannot control Terminal.app -- grant Automation permission to this terminal in System Settings > Privacy & Security > Automation",
		);
		process.exit(2);
	}

	let failures = 0;
	for (const scenario of scenarios) {
		let win: TerminalWindow | undefined;
		try {
			win = new TerminalWindow(
				scenario.command,
				scenario.cols ?? 100,
				scenario.rows ?? 30,
			);
			await sleep(scenario.settle ?? 3500);
			await scenario.run(win);
			console.log(`✓ ${scenario.name}`);
		} catch (err) {
			failures++;
			console.error(`✗ ${scenario.name}`);
			console.error(`  ${(err as Error).message}`);
		} finally {
			await win?.close();
		}
	}

	if (failures > 0) {
		console.error(`\n${failures} of ${scenarios.length} scenarios failed`);
		process.exit(1);
	}
	console.log(`\nall ${scenarios.length} scenarios passed`);
}

await main();
