#!/usr/bin/env node
// A chat client for ch.at (an LLM reachable over plain HTTP) written as a web
// page: a scrolling transcript, a real <input> to type into, and the reply
// STREAMED token-by-token into a growing DOM node -- a good test of live updates
// and reflow, not just a static render. No API key, no SDK: just fetch().
//
//   node examples/chat.ts
//
//   type a message · Enter send · Shift+Enter newline · Esc or Ctrl-c quit
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const {document, window} = term;

const style = document.createElement("style");
style.textContent = `
	.title { color: cyan; font-weight: bold; }
	.hint { color: #666666; margin-bottom: 1px; }
	.msg { margin-top: 1px; }
	.msg .who { font-weight: bold; }
	.msg.you .who { color: #5fafff; }
	.msg.bot .who { color: #87d787; }
	.msg .body { display: block; }
	.msg.pending .body { color: #808080; }
	.prompt { display: flex; flex-direction: row; margin-top: 1px; }
	.prompt .sigil { color: #ff8700; font-weight: bold; }
	textarea { flex-grow: 1; }
`;
document.head.appendChild(style);

const title = document.createElement("div");
title.className = "title";
title.textContent = " ch.at";
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent =
	" ask anything · Enter send · Shift+Enter newline · Esc quit";
const log = document.createElement("div");
const prompt = document.createElement("div");
prompt.className = "prompt";
const sigil = document.createElement("span");
sigil.className = "sigil";
sigil.textContent = "› ";
const input = document.createElement("textarea");
input.setAttribute("rows", "1");
input.setAttribute("placeholder", "message ch.at…");
prompt.append(sigil, input);
document.body.append(title, hint, log, prompt);

interface Turn {
	role: "user" | "assistant";
	text: string;
}
const turns: Turn[] = [];

function addMessage(role: "user" | "assistant", text: string): Text {
	const msg = document.createElement("div");
	msg.className = `msg ${role === "user" ? "you" : "bot"}`;
	const who = document.createElement("span");
	who.className = "who";
	who.textContent = role === "user" ? "you  " : "ch.at  ";
	const body = document.createElement("span");
	body.className = "body";
	const node = document.createTextNode(text);
	body.appendChild(node);
	msg.append(who, body);
	log.appendChild(msg);
	return node;
}

async function scrollToPrompt(): Promise<void> {
	prompt.scrollIntoView();
	await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
}

// The reply is streamed. ch.at echoes the whole prompt as `Q: ...` then adds a
// final `A: <answer>` line, so the answer is whatever follows the LAST `\nA: `
// the server appends (our own turns are labelled User:/Assistant:, never A:).
function answerFrom(raw: string): string {
	const marker = raw.lastIndexOf("\nA: ");
	return marker >= 0 ? raw.slice(marker + 4) : "";
}

let busy = false;

async function send(): Promise<void> {
	const text = input.value.trim();
	if (busy || !text) return;
	busy = true;
	input.value = "";
	turns.push({role: "user", text});
	addMessage("user", text);

	const bot = addMessage("assistant", "…");
	const botMsg = bot.parentElement!.parentElement as HTMLElement;
	botMsg.classList.add("pending");
	await scrollToPrompt();

	const conversation = turns
		.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
		.join("\n");
	const url = `https://ch.at/?q=${encodeURIComponent(conversation)}`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		const res = await fetch(url, {signal: controller.signal});
		if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let raw = "";
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			raw += decoder.decode(value, {stream: true});
			const answer = answerFrom(raw);
			if (answer) {
				botMsg.classList.remove("pending");
				bot.data = answer;
				await scrollToPrompt();
			}
		}
		clearTimeout(timeout);
		const answer = answerFrom(raw).trim() || "(no answer)";
		bot.data = answer;
		botMsg.classList.remove("pending");
		turns.push({role: "assistant", text: answer});
	} catch (err) {
		botMsg.classList.remove("pending");
		bot.data = `⚠ ${(err as Error).message}`;
		turns.pop(); // drop the user turn whose reply failed, so context stays clean
	} finally {
		busy = false;
		await scrollToPrompt();
	}
}

// Capture phase, so preventDefault runs BEFORE the textarea's own keydown and
// suppresses the newline it would otherwise insert: Enter sends, and Shift+Enter
// falls through to the textarea to add a line to a multi-line message.
document.addEventListener(
	"keydown",
	(event: Event) => {
		const e = event as KeyboardEvent;
		if (e.key === "Escape" || (e.ctrlKey && e.key === "c")) {
			term.dispose();
			process.exit(0);
		} else if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	},
	true,
);

input.focus();
await scrollToPrompt();

// No terminal (piped/CI): run one scripted exchange so the example is testable
// and inspectable without typing, then exit.
if (!process.stdout.isTTY) {
	input.value = "In one short sentence, what is a terminal emulator?";
	await send();
	term.dispose();
	process.exit(0);
}
