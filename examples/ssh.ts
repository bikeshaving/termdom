/**
 * A TermDOM behind an SSH server. Every shell session that connects gets a
 * document of its own, rendered over that session's channel through a
 * TerminalTransport: the channel carries input and frames, the pty request
 * gives the size and TERM, and a window-change becomes a resize.
 *
 *   node examples/ssh.ts [port]
 *   ssh -p 2222 localhost          # from another terminal; any password
 *
 * The ed25519 host key is generated on the first start and kept at
 * ~/.cache/termdom/ssh-host-key, so a client that connected before is not
 * warned that the host changed. Replace that file to use a key of your own.
 *
 * This server accepts everyone, which suits a demo. To serve an app to
 * real users, let OpenSSH do the SSH: a Match block in sshd_config with
 * `ForceCommand node /path/to/app.ts` runs the app in place of a shell,
 * on a real pty, and the app needs nothing but `new TermDOM()`.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

import {
  TermDOM,
  type TerminalCloseInfo,
  type TerminalSize,
  type TerminalTransport,
} from "@b9g/termdom";
import ssh2, {type ServerChannel} from "ssh2";

const PORT = Number(process.argv[2] ?? 2222);

function hostKey(): string {
  const path = join(homedir(), ".cache", "termdom", "ssh-host-key");
  if (existsSync(path)) {
    return readFileSync(path, "utf8");
  }
  // OpenSSH's own key format, which ssh2 reads for ed25519 where it does
  // not read node:crypto's PKCS8.
  const {private: privateKey} = ssh2.utils.generateKeyPairSync("ed25519");
  mkdirSync(join(path, ".."), {recursive: true});
  writeFileSync(path, privateKey, {mode: 0o600});
  return privateKey;
}

interface Pty {
  term: string;
  cols: number;
  rows: number;
}

interface Session {
  transport: TerminalTransport;
  resize(cols: number, rows: number): void;
}

/**
 * One SSH session as a terminal. Closing it ends the channel with the
 * app's status; the client hanging up closes the session.
 */
function sessionFromChannel(
  channel: ServerChannel,
  pty: Pty,
  connection: {on(event: "close", listener: () => void): unknown},
): Session {
  let {cols, rows} = pty;
  let resized: ReadableStreamDefaultController<TerminalSize> | null = null;
  const closed = new Promise<TerminalCloseInfo>((resolve) => {
    channel.on("close", () => resolve({}));
    connection.on("close", () => resolve({}));
  });
  const decoder = new TextDecoder();
  let onData: ((chunk: Uint8Array) => void) | null = null;
  const transport: TerminalTransport = {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    // The client's terminal keeps its shell above the connection, so the
    // document anchors under the ssh command as a local one does under
    // its prompt, and paints from there down.
    sharesScreen: true,
    interactive: true,
    readable: new ReadableStream<string>({
      start(controller) {
        onData = (chunk) => {
          controller.enqueue(decoder.decode(chunk, {stream: true}));
        };
        channel.on("data", onData);
      },
      cancel() {
        channel.off("data", onData!);
      },
    }),
    writable: new WritableStream<string>({
      write: (chunk) => new Promise<void>((resolve, reject) => {
        channel.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    }),
    resizes: new ReadableStream<TerminalSize>({
      start(controller) {
        resized = controller;
      },
      cancel() {
        resized = null;
      },
    }),
    ready: Promise.resolve(),
    closed,
    close(info) {
      channel.exit(info?.status ?? 0);
      channel.end();
    },
  };
  return {
    transport,
    resize(nextCols, nextRows) {
      cols = nextCols;
      rows = nextRows;
      resized?.enqueue({cols, rows});
    },
  };
}

const sessions = new Set<TermDOM>();
let served = 0;

function serve(session: Session, pty: Pty): void {
  const termdom = new TermDOM({transport: session.transport});
  const {document, window} = termdom;
  served++;
  sessions.add(termdom);
  session.transport.closed.then(() => {
    sessions.delete(termdom);
    refreshStatus();
  });

  document.body.innerHTML = `
    <style>
      body { padding: 1px 2ch; }
      h1 { color: #5fafff; font-weight: bold; }
      .keys { margin-top: 1px; color: #ffd700; }
      .log { margin-top: 1px; }
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
    log.append(line);
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  termdom.attach();
  refreshStatus();
}

// ssh2 is CommonJS, so its classes come off the default export.
const server = new ssh2.Server({hostKeys: [hostKey()]}, (client) => {
  // A demo: every password and every key is accepted.
  client.on("authentication", (context) => context.accept());
  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      const session = acceptSession();
      const pty: Pty = {term: "xterm-256color", cols: 80, rows: 24};
      let current: Session | null = null;
      session.on("pty", (accept, _reject, info) => {
        pty.term = info.term || pty.term;
        pty.cols = info.cols || pty.cols;
        pty.rows = info.rows || pty.rows;
        accept?.();
      });
      session.on("window-change", (accept, _reject, info) => {
        current?.resize(info.cols, info.rows);
        accept?.();
      });
      session.on("shell", (accept) => {
        current = sessionFromChannel(accept(), pty, client);
        serve(current, pty);
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
