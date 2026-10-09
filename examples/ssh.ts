/**
 * A TermDOM behind an SSH server. Every shell session that connects gets a
 * document of its own, through transportFromSSH: the session's pty request
 * gives the size, its shell request opens the channel that carries input
 * and frames, and a window change becomes a resize.
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

import {TermDOM, transportFromSSH} from "@b9g/termdom";
import ssh2, {type Session} from "ssh2";

const PORT = Number(process.argv[2] ?? 2222);

function hostKey(): string {
  const path = join(homedir(), ".cache", "termdom", "ssh-host-key");
  if (existsSync(path)) {
    return readFileSync(path, "utf8");
  }
  // OpenSSH's own key format, which ssh2 reads for ed25519 where it does
  // not read node:crypto's PKCS8.
  const {private: privateKey} = ssh2.utils.generateKeyPairSync("ed25519");
  mkdirSync(join(path, ".."), {recursive: true, mode: 0o700});
  try {
    writeFileSync(path, privateKey, {mode: 0o600, flag: "wx"});
  } catch (error) {
    // Another server started at the same moment and wrote its key first.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(path, "utf8");
    }
    throw error;
  }
  return privateKey;
}

const sessions = new Set<TermDOM>();
let served = 0;

function serve(session: Session): void {
  const transport = transportFromSSH(session);
  const termdom = new TermDOM({transport});
  const {document, window} = termdom;
  served++;
  sessions.add(termdom);
  transport.closed.then(() => {
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
    <div>session ${served} of this server, <span class="size"></span></div>
    <div class="keys">type anything · q quits</div>
    <div class="log"></div>
    <div class="hint">each session is its own document; resize the window to see it relayout</div>
  `;
  const size = document.querySelector(".size")!;
  const showSize = () => {
    size.textContent = `${window.innerWidth}×${window.innerHeight}`;
  };
  showSize();
  window.addEventListener("resize", showSize);
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
    client.on("session", (accept) => serve(accept()));
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
