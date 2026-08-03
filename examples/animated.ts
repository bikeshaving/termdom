#!/usr/bin/env bun
import {TermDOM} from "@b9g/termdom";

const termdom = new TermDOM();
const {document} = termdom;

const style = document.createElement("style");
style.textContent = `
  .app { padding: 1ch 2ch; }
  .title { color: cyan; }
  .section { padding: 1 0; }
  .label { color: white; }
  .spinner { color: green; display: inline; }
  .dots { color: yellow; display: inline; }
  .bar-container { display: flex; flex-direction: row; }
  .bar-track { color: #555; display: inline; }
  .bar-fill { color: green; display: inline; }
  .bar-pct { color: white; display: inline; padding-left: 1ch; }
  .braille { color: magenta; display: inline; }
  .clock { color: cyan; display: inline; }
  .bounce { color: red; display: inline; }
  .status { color: #666; padding-top: 1px; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.className = "app";

const title = document.createElement("h2");
title.className = "title";
title.textContent = "Terminal Animations";
app.appendChild(title);

// Spinner
const spinnerSection = document.createElement("div");
spinnerSection.className = "section";
const spinnerLabel = document.createElement("span");
spinnerLabel.className = "label";
spinnerLabel.textContent = "Spinner:    ";
const spinner = document.createElement("span");
spinner.className = "spinner";
spinnerSection.appendChild(spinnerLabel);
spinnerSection.appendChild(spinner);
app.appendChild(spinnerSection);

// Dots loader
const dotsSection = document.createElement("div");
dotsSection.className = "section";
const dotsLabel = document.createElement("span");
dotsLabel.className = "label";
dotsLabel.textContent = "Loading:    ";
const dots = document.createElement("span");
dots.className = "dots";
dotsSection.appendChild(dotsLabel);
dotsSection.appendChild(dots);
app.appendChild(dotsSection);

// Progress bar
const barSection = document.createElement("div");
barSection.className = "section";
const barLabel = document.createElement("span");
barLabel.className = "label";
barLabel.textContent = "Progress:   ";
const barContainer = document.createElement("div");
barContainer.className = "bar-container";
const barFill = document.createElement("span");
barFill.className = "bar-fill";
const barTrack = document.createElement("span");
barTrack.className = "bar-track";
const barPct = document.createElement("span");
barPct.className = "bar-pct";
barContainer.appendChild(barFill);
barContainer.appendChild(barTrack);
barContainer.appendChild(barPct);
barSection.appendChild(barLabel);
barSection.appendChild(barContainer);
app.appendChild(barSection);

// Braille spinner
const brailleSection = document.createElement("div");
brailleSection.className = "section";
const brailleLabel = document.createElement("span");
brailleLabel.className = "label";
brailleLabel.textContent = "Braille:    ";
const braille = document.createElement("span");
braille.className = "braille";
brailleSection.appendChild(brailleLabel);
brailleSection.appendChild(braille);
app.appendChild(brailleSection);

// Clock
const clockSection = document.createElement("div");
clockSection.className = "section";
const clockLabel = document.createElement("span");
clockLabel.className = "label";
clockLabel.textContent = "Clock:      ";
const clock = document.createElement("span");
clock.className = "clock";
clockSection.appendChild(clockLabel);
clockSection.appendChild(clock);
app.appendChild(clockSection);

// Bouncing ball
const bounceSection = document.createElement("div");
bounceSection.className = "section";
const bounceLabel = document.createElement("span");
bounceLabel.className = "label";
bounceLabel.textContent = "Bounce:     ";
const bounce = document.createElement("span");
bounce.className = "bounce";
bounceSection.appendChild(bounceLabel);
bounceSection.appendChild(bounce);
app.appendChild(bounceSection);

// Status
const status = document.createElement("div");
status.className = "status";
status.textContent = "Press q to quit";
app.appendChild(status);

document.body.appendChild(app);

// Animation state
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

function updateAnimations() {
	// Spinner
	spinner.textContent =
		spinnerFrames[frame % spinnerFrames.length] + " Processing...";

	// Dots
	const dotCount = frame % 4;
	dots.textContent =
		"Please wait" + ".".repeat(dotCount) + " ".repeat(3 - dotCount);

	// Progress bar
	const barWidth = 30;
	const filled = Math.round((progress / 100) * barWidth);
	barFill.textContent = "█".repeat(filled);
	barTrack.textContent = "░".repeat(barWidth - filled);
	barPct.textContent = `${Math.round(progress)}%`;
	progress = (progress + 0.5) % 101;

	// Braille spinner
	braille.textContent =
		brailleFrames[frame % brailleFrames.length] + " Computing...";

	// Clock
	clock.textContent = clockFrames[frame % clockFrames.length];

	// Bouncing ball
	bounce.textContent =
		" ".repeat(bouncePos) + "●" + " ".repeat(bounceWidth - bouncePos);
	bouncePos += bounceDir;
	if (bouncePos >= bounceWidth || bouncePos <= 0) bounceDir *= -1;

	frame++;
}

// Keyboard handler
document.addEventListener("keydown", (e: Event) => {
	const ke = e as KeyboardEvent;
	if (ke.key === "q") {
		clearInterval(interval);
		termdom.dispose();
		process.exit(0);
	}
});

// Start animation loop
const interval = setInterval(updateAnimations, 80);
updateAnimations();

await new Promise<void>((r) => termdom.window.requestAnimationFrame(() => r()));
