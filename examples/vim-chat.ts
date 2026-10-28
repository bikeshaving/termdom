/**
 * A chat with ch.at where you write each message in vim, running in an
 * <embed type="application/x-pty">. :wq sends the message and opens vim
 * again for the next one. :q! sends nothing. Ctrl+Q quits. Set EDITOR to
 * use another editor.
 *
 *   bun examples/vim-chat.ts
 */
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {TermDOM} from "@b9g/termdom";

const editor = process.env.EDITOR ?? "vim";
const file = join(mkdtempSync(join(tmpdir(), "vim-chat-")), "message.txt");

const term = new TermDOM({pty: "auto"});
term.attach();
const {document} = term;

document.body.innerHTML = `
  <style>
    body { display: flex; flex-direction: column; height: 100vh; }
    .log { flex: 1; overflow-y: auto; padding: 0 1ch; }
    .msg { margin-top: 1px; white-space: pre-wrap; }
    .who { font-weight: bold; }
    .you .who { color: #5fafff; }
    .bot .who { color: #87d787; }
    .pending { color: gray; }
    .hint { padding: 0 1ch; color: gray; border-top: 1px solid #585858; }
    embed { width: 100%; height: 8px; }
  </style>
  <div class="log"></div>
  <div class="hint">:wq sends · :q! discards · Ctrl+Q quits</div>
`;

const log = document.querySelector(".log")!;
const turns: string[] = [];

function addMessage(role: "you" | "bot", text: string): HTMLElement {
  const message = document.createElement("div");
  message.className = `msg ${role}`;
  message.innerHTML = `<div class="who"></div><div class="body"></div>`;
  message.querySelector(".who")!.textContent = role === "you" ? "you" : "ch.at";
  message.querySelector(".body")!.textContent = text;
  log.append(message);
  message.scrollIntoView({block: "nearest"});
  return message.querySelector(".body")!;
}

async function ask(text: string): Promise<void> {
  turns.push(`User: ${text}`);
  addMessage("you", text);
  const body = addMessage("bot", "…");
  body.classList.add("pending");
  try {
    const response = await fetch(
      `https://ch.at/?q=${encodeURIComponent(turns.join("\n"))}`,
    );
    const raw = await response.text();
    const answer = raw.slice(raw.lastIndexOf("\nA: ") + 4).trim();
    turns.push(`Assistant: ${answer}`);
    body.textContent = answer;
  } catch (error) {
    turns.pop();
    body.textContent = `⚠ ${(error as Error).message}`;
  }
  body.classList.remove("pending");
  body.scrollIntoView({block: "nearest"});
}

function compose(): void {
  writeFileSync(file, "");
  const embed = document.createElement("embed");
  embed.type = "application/x-pty";
  embed.src = `${editor} '${file}'`;
  embed.addEventListener("close", () => {
    embed.remove();
    const text = readFileSync(file, "utf8").trim();
    if (text) {
      void ask(text);
    }
    compose();
  });
  document.body.append(embed);
  embed.focus();
}

document.addEventListener(
  "keydown",
  (event) => {
    if (event.ctrlKey && event.key === "q") {
      event.preventDefault();
      void term.dispose();
    }
  },
  true,
);

compose();
