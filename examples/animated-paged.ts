#!/usr/bin/env bun
// The animated dashboard, but in *document* (paged) mode: we own a region of the
// screen and repaint a window of the document into it. Nothing commits to the
// scrollback, so a frame taller than the viewport clips instead of flooding, and
// a resize can never orphan a copy. The cost is the one we decided to stop
// apologising for: this region is not in the scrollback, so the terminal's own
// search does not reach it. You page it with the keys below instead.
import {TermDOM} from "../src/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;
termdom.setViewportMode("document");

const style = document.createElement("style");
style.textContent = `
  .app { padding: 1ch 2ch; }
  .title { color: cyan; }
  .section { padding: 1 0; }
  .label { color: white; }
  .spinner, .dots, .braille, .clock, .bounce { display: inline; }
  .spinner { color: green; }
  .dots { color: yellow; }
  .braille { color: magenta; }
  .clock { color: cyan; }
  .bounce { color: red; }
  .bar-container { display: flex; flex-direction: row; }
  .bar-track { color: #555; display: inline; }
  .bar-fill { color: green; display: inline; }
  .bar-pct { color: white; display: inline; padding-left: 1ch; }
  .log-title { color: cyan; padding-top: 1; }
  .log-line { color: #888; }
  .hint { color: #666; padding-top: 1; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.className = "app";
app.innerHTML = `
  <h2 class="title">Terminal Animations — paged</h2>
  <div class="section"><span class="label">Spinner:    </span><span class="spinner" id="spinner"></span></div>
  <div class="section"><span class="label">Loading:    </span><span class="dots" id="dots"></span></div>
  <div class="section"><span class="label">Progress:   </span><span class="bar-container"><span class="bar-fill" id="fill"></span><span class="bar-track" id="track"></span><span class="bar-pct" id="pct"></span></span></div>
  <div class="section"><span class="label">Braille:    </span><span class="braille" id="braille"></span></div>
  <div class="section"><span class="label">Clock:      </span><span class="clock" id="clock"></span></div>
  <div class="section"><span class="label">Bounce:     </span><span class="bounce" id="bounce"></span></div>
  <div class="log-title">Event log — live (j/k scroll pauses follow, G resumes)</div>
`;
document.body.appendChild(app);

// A real, growing log: every entry below is an event that actually happened.
// The document grows while the camera holds still -- unless it is at the tail,
// where it follows, like a log viewer should.
const log = document.createElement("div");
app.appendChild(log);
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = "↑/↓ or j/k to scroll · g/G top/bottom · q to quit";
app.appendChild(hint);

let follow = true;
function logEvent(text: string): void {
	const now = new Date();
	const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
	const line = document.createElement("div");
	line.className = "log-line";
	line.textContent = `  [${stamp}] ${text}`;
	log.appendChild(line);
	// Keep the transcript bounded; the oldest rows fall off the top.
	while (log.childElementCount > 200) log.firstElementChild!.remove();
	if (follow) {
		termdom.scrollDocumentBy(document.body.scrollHeight);
	}
}

const $ = (id: string) => document.getElementById(id)!;
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const brailleFrames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const clockFrames = [
	"🕐",
	"🕑",
	"🕒",
	"🕓",
	"🕔",
	"🕕",
	"🕖",
	"🕗",
	"🕘",
	"🕙",
	"🕚",
	"🕛",
];
let frame = 0;
let progress = 0;
let bouncePos = 0;
let bounceDir = 1;
const bounceWidth = 20;

function tick() {
	$("spinner").textContent =
		spinnerFrames[frame % spinnerFrames.length] + " Processing...";
	const dotCount = frame % 4;
	$("dots").textContent =
		"Please wait" + ".".repeat(dotCount) + " ".repeat(3 - dotCount);
	const barWidth = 30;
	const filled = Math.round((progress / 100) * barWidth);
	$("fill").textContent = "█".repeat(filled);
	$("track").textContent = "░".repeat(barWidth - filled);
	$("pct").textContent = `${Math.round(progress)}%`;
	progress = progress + 0.5;
	if (progress > 100) {
		progress = 0;
		logEvent("progress lap complete");
	}
	$("braille").textContent =
		brailleFrames[frame % brailleFrames.length] + " Computing...";
	$("clock").textContent = clockFrames[frame % clockFrames.length];
	$("bounce").textContent =
		" ".repeat(bouncePos) + "●" + " ".repeat(bounceWidth - bouncePos);
	bouncePos += bounceDir;
	if (bouncePos >= bounceWidth || bouncePos <= 0) bounceDir *= -1;
	frame++;
	if (frame % 75 === 0 && renderCount > 0) {
		const fps = (renderCount / 6).toFixed(1); // 75 frames at 80ms = ~6s window
		logEvent(`${fps} fps · slowest frame ${renderPeak.toFixed(1)}ms`);
		renderCount = 0;
	}
}

document.addEventListener("keydown", (e: Event) => {
	const key = (e as KeyboardEvent).key;
	if (key === "q") {
		clearInterval(interval);
		termdom.dispose();
		process.exit(0);
	} else if (key === "ArrowDown" || key === "j") {
		follow = false;
		termdom.scrollDocumentBy(1);
		void termdom.render();
	} else if (key === "ArrowUp" || key === "k") {
		follow = false;
		termdom.scrollDocumentBy(-1);
		void termdom.render();
	} else if (key === "g") {
		follow = false;
		termdom.scrollDocumentBy(-9999);
		void termdom.render();
	} else if (key === "G") {
		follow = true;
		termdom.scrollDocumentBy(9999);
		void termdom.render();
	} else {
		logEvent(`key pressed: ${JSON.stringify(key)}`);
	}
});

let renderCount = 0;
let renderPeak = 0;
const observer = new termdom.window.MutationObserver(async () => {
	const start = performance.now();
	await termdom.render();
	// Most calls coalesce into an in-flight frame and return at once; the peak
	// is the cost of a frame that actually painted.
	renderPeak = Math.max(renderPeak, performance.now() - start);
	renderCount++;
});
observer.observe(document.body, {
	childList: true,
	subtree: true,
	characterData: true,
});

const interval = setInterval(tick, 80);
tick();
await termdom.render();
