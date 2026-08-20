// A chat client for ch.at (an LLM reachable over plain HTTP)
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

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
	/* Flat like the UA's input family: the › sigil is the prompt chrome, so
	   the UA border box around the composer read as a second, mismatched
	   frame. Borderless, rows=1 sizes the content: one row until the text
	   wraps. */
	textarea { flex-grow: 1; border: none; padding: 0; }
`;
document.head.appendChild(style);

const title = document.createElement("div");
title.className = "title";
title.textContent = " ch.at";
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = " ask anything · Enter send · Ctrl+J newline · Esc quit";
const log = document.createElement("div");
const prompt = document.createElement("div");
prompt.className = "prompt";
const sigil = document.createElement("span");
sigil.className = "sigil";
sigil.textContent = "› ";
const input = document.createElement("textarea");
input.autofocus = true;
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

function scrollToPrompt(): void {
	prompt.scrollIntoView();
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
	if (busy || !text) {
		return;
	}
	busy = true;
	input.value = "";
	turns.push({role: "user", text});
	addMessage("user", text);

	const bot = addMessage("assistant", "…");
	const botMsg = bot.parentElement!.parentElement as HTMLElement;
	botMsg.classList.add("pending");
	scrollToPrompt();

	const conversation = turns
		.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
		.join("\n");
	const url = `https://ch.at/?q=${encodeURIComponent(conversation)}`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		const res = await fetch(url, {signal: controller.signal});
		if (!res.ok || !res.body) {
			throw new Error(`HTTP ${res.status}`);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let raw = "";
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				break;
			}
			raw += decoder.decode(value, {stream: true});
			const answer = answerFrom(raw);
			if (answer) {
				botMsg.classList.remove("pending");
				bot.data = answer;
				scrollToPrompt();
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
		scrollToPrompt();
	}
}

// Capture phase, so preventDefault runs BEFORE the textarea's own keydown and
// suppresses the newline it would otherwise insert: Enter sends the message,
// and Ctrl+J adds a line to a multi-line one. A terminal cannot report
// Shift+Enter -- it sends the same byte as Enter -- so the newline lives on the
// chord it can report.
document.addEventListener(
	"keydown",
	(event: Event) => {
		const e = event as KeyboardEvent;
		if (e.key === "Escape" || (e.ctrlKey && e.key === "c")) {
			term.window.close();
		} else if (e.ctrlKey && e.key === "j") {
			e.preventDefault();
			const at = input.selectionStart ?? input.value.length;
			input.value = input.value.slice(0, at) + "\n" + input.value.slice(at);
			input.setSelectionRange(at + 1, at + 1);
		} else if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	},
	true,
);

scrollToPrompt();

// No terminal (piped/CI): run one scripted exchange so the example is testable
// and inspectable without typing, then exit.
if (!process.stdout.isTTY) {
	input.value = "In one short sentence, what is a terminal emulator?";
	await send();
	term.window.close();
}
