/**
 * A TermDOM behind an SSH server. Every shell session that connects gets a
 * document of its own, rendered over that session's channel: the channel
 * stands in for the pty, the pty request gives the size and TERM, and a
 * window-change becomes the resize a local terminal would signal.
 *
 *   node examples/ssh.ts
 *   ssh -p 2222 localhost          # from another terminal; any password
 *
 * The host key is generated on each start, so a client that connected
 * before will warn that it changed. Set SSH_HOST_KEY to a PEM file to keep
 * one. Set SSH_PORT to listen elsewhere than 2222.
 */
import {generateKeyPairSync} from "node:crypto";
import {EventEmitter} from "node:events";
import {readFileSync} from "node:fs";

import {type ProcessLike, TermDOM, transportFromProcess} from "@b9g/termdom";
import ssh2, {type ServerChannel} from "ssh2";

const PORT = Number(process.env.SSH_PORT ?? 2222);

function hostKey(): string {
	const path = process.env.SSH_HOST_KEY;
	if (path) {
		return readFileSync(path, "utf8");
	}
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: {type: "pkcs1", format: "pem"},
		privateKeyEncoding: {type: "pkcs1", format: "pem"},
	}).privateKey;
}

interface Pty {
	term: string;
	cols: number;
	rows: number;
}

/**
 * The process-shaped view of one SSH session that transportFromProcess
 * reads: stdin is the channel, stdout writes back to it and carries the
 * pty's size, SIGWINCH fires on a window-change, and exit ends the
 * channel with the app's status.
 */
class SessionProcess extends EventEmitter implements ProcessLike {
	readonly stdin: ProcessLike["stdin"];
	readonly stdout: ProcessLike["stdout"];
	readonly env: Record<string, string | undefined>;
	readonly channel: ServerChannel;

	constructor(channel: ServerChannel, pty: Pty, env: Record<string, string>) {
		super();
		this.channel = channel;
		this.env = {TERM: pty.term, ...env};
		const stdin = channel as unknown as NonNullable<ProcessLike["stdin"]>;
		stdin.isTTY = true;
		stdin.setRawMode = () => stdin;
		this.stdin = stdin;
		this.stdout = {
			isTTY: true,
			columns: pty.cols,
			rows: pty.rows,
			write: (chunk, encoding, callback) => {
				const done = typeof encoding === "function" ? encoding : callback;
				channel.write(chunk, (error) => done?.(error ?? undefined));
				return true;
			},
		};
	}

	resize(cols: number, rows: number): void {
		this.stdout.columns = cols;
		this.stdout.rows = rows;
		this.emit("SIGWINCH");
	}

	exit(code = 0): never {
		this.channel.exit(code);
		this.channel.end();
		this.channel.close();
		return undefined as never;
	}
}

const sessions = new Set<TermDOM>();
let served = 0;

function serve(
	channel: ServerChannel,
	pty: Pty,
	env: Record<string, string>,
	connection: {on(event: "close", listener: () => void): unknown},
): SessionProcess {
	const proc = new SessionProcess(channel, pty, env);
	const termdom = new TermDOM({
		transport: transportFromProcess(proc, {sharesScreen: false}),
	});
	const {document, window} = termdom;
	served++;
	sessions.add(termdom);
	// The channel closes when the app quits; the connection closes when
	// the client hangs up. Either ends the session.
	const ended = (): void => {
		if (!sessions.delete(termdom)) {
			return;
		}
		proc.emit("SIGHUP");
		refreshStatus();
	};
	channel.on("close", ended);
	connection.on("close", ended);

	document.body.innerHTML = `
		<style>
			body { padding: 1px 2ch; }
			h1 { color: #5fafff; font-weight: bold; }
			.keys { margin-top: 1px; color: #ffd700; }
			.log { margin-top: 1px; height: 6px; overflow: hidden; }
			.log div { color: #87d787; }
			.hint { margin-top: 1px; color: #808080; }
		</style>
		<h1>termdom over ssh</h1>
		<div>session ${served} of this server, ${pty.term} at ${pty.cols}×${pty.rows}</div>
		<div class="keys">type anything · q quits</div>
		<div class="log"></div>
		<div class="hint">each session is its own document; resize the window to see it relayout</div>
	`;
	const log = document.querySelector(".log")!;
	document.addEventListener("keydown", (event) => {
		const key = (event as KeyboardEvent).key;
		if (key === "q") {
			window.close();
			return;
		}
		const line = document.createElement("div");
		line.textContent = `key: ${JSON.stringify(key)}`;
		log.prepend(line);
	});
	termdom.attach();
	refreshStatus();
	return proc;
}

// ssh2 is CommonJS, so its classes come off the default export.
const server = new ssh2.Server({hostKeys: [hostKey()]}, (client) => {
	// A demo: every password and every key is accepted.
	client.on("authentication", (context) => context.accept());
	client.on("ready", () => {
		client.on("session", (acceptSession) => {
			const session = acceptSession();
			const pty: Pty = {term: "xterm-256color", cols: 80, rows: 24};
			const env: Record<string, string> = {};
			let proc: SessionProcess | null = null;
			session.on("pty", (accept, _reject, info) => {
				pty.term = info.term || pty.term;
				pty.cols = info.cols || pty.cols;
				pty.rows = info.rows || pty.rows;
				accept?.();
			});
			session.on("env", (accept, _reject, info) => {
				env[info.key] = info.val;
				accept?.();
			});
			session.on("window-change", (accept, _reject, info) => {
				proc?.resize(info.cols, info.rows);
				accept?.();
			});
			session.on("shell", (accept) => {
				proc = serve(accept(), pty, env, client);
			});
		});
	});
	client.on("error", () => {});
});

// The server's own terminal shows what it is doing, so the example has a
// screen of its own to look at while sessions come and go.
const local = new TermDOM();
local.document.body.innerHTML = `
	<style>
		body { padding: 0 1ch; }
		.title { color: white; background: blue; padding: 0 1ch; }
		.status { margin-top: 1px; }
		.error { color: red; }
	</style>
	<div class="title">termdom ssh server</div>
	<div class="status">starting…</div>
`;
local.attach();

function refreshStatus(): void {
	const status = local.document.querySelector(".status")!;
	status.textContent = `ssh -p ${PORT} localhost · ${sessions.size} connected, ${served} served · Ctrl+C stops`;
}

server.on("error", (error: Error) => {
	const status = local.document.querySelector(".status")!;
	status.className = "status error";
	status.textContent = `cannot listen on port ${PORT}: ${error.message}`;
});
server.listen(PORT, "127.0.0.1", refreshStatus);
