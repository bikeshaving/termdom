#!/usr/bin/env bun
// A termdom app served over SSH. Each connection gets its own DOM, its own
// renderer, and a ProcessLike adapter wrapped around the SSH channel -- the
// same seam the test harness uses. The library needs no changes: an SSH
// session is a TTY like any other.
//
//   bun examples/ssh-server.ts [port]      (default 2222)
//   ssh -p 2222 localhost                  (any user, no password)
//
// This is the shape of `ssh termdom.org`: the landing page as a living app.
import {Server, type PseudoTtyInfo, type ServerChannel} from "ssh2";
import {EventEmitter} from "node:events";
import {execSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {TermDOM, type ProcessLike} from "../src/index.js";

const PORT = parseInt(process.argv[2] ?? "2222", 10);
const HOST_KEY = new URL("../.sshkeys/host_ed25519", import.meta.url).pathname;

// A throwaway host key, generated on first run and gitignored.
if (!existsSync(HOST_KEY)) {
	execSync(`mkdir -p "${new URL("../.sshkeys", import.meta.url).pathname}"`);
	execSync(`ssh-keygen -t ed25519 -N "" -f "${HOST_KEY}" -q`);
}

/**
 * Wrap an SSH channel as a ProcessLike: the channel is stdout and stdin, the
 * pty request supplies the size, and window-change resizes become SIGWINCH.
 */
function channelProcess(
	channel: ServerChannel,
	info: PseudoTtyInfo,
): ProcessLike & {resize(cols: number, rows: number): void} {
	const stdout = {
		isTTY: true,
		columns: info.cols || 80,
		rows: info.rows || 24,
		write(chunk: any, encoding?: any, callback?: any): boolean {
			if (typeof encoding === "function") {
				callback = encoding;
				encoding = undefined;
			}
			return channel.write(chunk, encoding, callback);
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
	channel.on("data", (data: Buffer) => stdin.emit("data", data));

	const proc = new (class extends EventEmitter {
		stdout = stdout;
		stdin = stdin;
		env = {
			TERM: (info as {term?: string}).term || "xterm-256color",
			COLORTERM: "truecolor",
		};
		exit(code?: number): never {
			channel.close();
			throw new Error(`session exit(${code ?? 0})`);
		}
		resize(cols: number, rows: number): void {
			stdout.columns = cols;
			stdout.rows = rows;
			this.emit("SIGWINCH");
		}
	})();

	return proc as unknown as ProcessLike & {
		resize(cols: number, rows: number): void;
	};
}

/** The app a visitor lands in. One instance per connection. */
function serveSession(proc: ProcessLike, onDone: () => void): () => void {
	const termdom = new TermDOM({process: proc, detectCursor: false});
	const {document} = termdom;
	termdom.setViewportMode("document");

	const style = document.createElement("style");
	style.textContent = `
	  .banner { color: cyan; font-weight: bold; }
	  .tag { color: #888; }
	  .section { padding: 1 0 0 0; }
	  .k { color: yellow; display: inline; }
	  .spin { color: green; display: inline; }
	  .bar-f { color: green; display: inline; }
	  .bar-t { color: #444; display: inline; }
	  .link { color: cyan; text-decoration: underline; }
	  .hint { color: #666; padding: 1 0 0 0; }
	`;
	document.head.appendChild(style);

	document.body.innerHTML = `
	  <div class="banner">termdom — HTML, CSS and the DOM for terminals</div>
	  <div class="tag">this page is a DOM, rendered to your terminal over ssh</div>
	  <div class="section"><span class="k">spinner </span><span class="spin" id="spin"></span></div>
	  <div class="section"><span class="k">render  </span><span class="bar-f" id="f"></span><span class="bar-t" id="t"></span></div>
	  <div class="section">every glyph you see is an element: <span class="link">github.com/bikeshaving/termdom</span></div>
	  <div class="section" id="echo">press keys — the DOM hears them as KeyboardEvents</div>
	  <div class="hint">resize your terminal · q to disconnect</div>
	`;

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let n = 0;
	const interval = setInterval(() => {
		document.getElementById("spin")!.textContent =
			frames[n % frames.length] + " live";
		const fill = n % 24;
		document.getElementById("f")!.textContent = "█".repeat(fill);
		document.getElementById("t")!.textContent = "░".repeat(24 - fill);
		n++;
	}, 90);

	document.addEventListener("keydown", (event: Event) => {
		const key = (event as KeyboardEvent).key;
		if (key === "q") {
			cleanup();
			onDone();
			return;
		}
		document.getElementById("echo")!.textContent =
			`press keys — the DOM hears them as KeyboardEvents (last: ${JSON.stringify(key)})`;
	});

	function cleanup(): void {
		clearInterval(interval);
		termdom.dispose();
	}
	return cleanup;
}

const server = new Server({hostKeys: [readFileSync(HOST_KEY)]}, (client) => {
	client.on("authentication", (ctx) => ctx.accept());
	client.on("ready", () => {
		client.on("session", (accept) => {
			const session = accept();
			let ptyInfo: PseudoTtyInfo | null = null;
			session.on("pty", (acceptPty, _reject, info) => {
				ptyInfo = info;
				acceptPty?.();
			});
			session.on("window-change", (acceptWc, _reject, info) => {
				acceptWc?.();
				proc?.resize(info.cols, info.rows);
			});
			let proc: (ProcessLike & {resize(c: number, r: number): void}) | null =
				null;
			session.on("shell", (acceptShell) => {
				const channel = acceptShell();
				proc = channelProcess(
					channel,
					ptyInfo ?? ({cols: 80, rows: 24} as PseudoTtyInfo),
				);
				const cleanup = serveSession(proc, () => {
					channel.write("\r\nthanks for visiting · npm i @b9g/termdom\r\n");
					channel.close();
				});
				channel.on("close", cleanup);
			});
		});
	});
	client.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`termdom over ssh: ssh -p ${PORT} localhost`);
});
