/**
 * A dashboard laid out by grid-template-areas: the whole shape of the screen
 * stated once, in a picture of itself, and every panel placed by naming the
 * area it belongs in.
 */
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body {
		margin: 0;
	}
	#dashboard {
		display: grid;
		grid-template-areas:
			"masthead masthead masthead"
			"nav      chart    stats"
			"nav      log      log"
			"status   status   status";
		grid-template-columns: 18ch 1fr 24ch;
		grid-template-rows: 1px 8px 1fr 1px;
		gap: 0 1ch;
		height: 22px;
	}
	#masthead {
		grid-area: masthead;
		background-color: #1c3f7a;
		color: white;
		padding: 0 1ch;
		display: grid;
		grid-template-columns: 1fr auto;
	}
	#masthead .clock {
		justify-self: end;
	}
	#nav {
		grid-area: nav;
		border: 1px solid #5fafff;
		padding: 0 1ch;
	}
	#nav b {
		color: #5fafff;
	}
	#chart {
		grid-area: chart;
		border: 1px solid #666666;
		padding: 0 1ch;
		display: grid;
		grid-template-columns: repeat(auto-fill, 4ch);
		align-items: end;
	}
	#chart span {
		color: #5fd7af;
	}
	#stats {
		grid-area: stats;
		border: 1px solid #666666;
		padding: 0 1ch;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0 1ch;
	}
	#stats .value {
		justify-self: end;
		color: #ffd75f;
	}
	#log {
		grid-area: log;
		border: 1px solid #666666;
		padding: 0 1ch;
	}
	#log .row {
		display: grid;
		grid-template-columns: 8ch 10ch 1fr;
		gap: 0 1ch;
	}
	#log .level {
		color: #ff8787;
	}
	#status {
		grid-area: status;
		background-color: #262626;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		padding: 0 1ch;
	}
	#status .center {
		justify-self: center;
	}
	#status .right {
		justify-self: end;
	}
`;
document.head.appendChild(style);

const dashboard = document.createElement("div");
dashboard.id = "dashboard";
document.body.appendChild(dashboard);

function panel(id: string, html: string): HTMLElement {
	const element = document.createElement("div");
	element.id = id;
	element.innerHTML = html;
	dashboard.appendChild(element);
	return element;
}

panel(
	"masthead",
	`<span>TermDOM grid — areas, tracks and lines</span><span class="clock">--:--:--</span>`,
);

panel(
	"nav",
	["Overview", "Traffic", "Errors", "Latency", "Hosts", "Settings"]
		.map((item, index) =>
			index === 0 ? `<div><b>▸ ${item}</b></div>` : `<div>  ${item}</div>`,
		)
		.join(""),
);

const bars = [3, 6, 2, 7, 4, 5, 1, 6, 3, 7, 2, 4, 6, 5, 3, 7, 4, 2, 6, 5];
panel(
	"chart",
	bars.map((height) => `<span>${"█".repeat(height)}</span>`).join(""),
);

panel(
	"stats",
	[
		["requests", "1,284"],
		["p50", "12ms"],
		["p99", "231ms"],
		["errors", "3"],
		["uptime", "99.98%"],
		["region", "iad"],
	]
		.map(
			([name, value]) =>
				`<span>${name}</span><span class="value">${value}</span>`,
		)
		.join(""),
);

const LEVELS = ["INFO", "WARN", "INFO", "INFO", "ERROR", "INFO"];
const MESSAGES = [
	"cache warmed",
	"retry budget low",
	"deploy 4f21a live",
	"scaled to 6 workers",
	"upstream timeout",
	"checkpoint written",
];
panel(
	"log",
	LEVELS.map(
		(level, index) =>
			`<div class="row"><span>0${index}:1${index}:0${index}</span>` +
			`<span class="level">${level}</span>` +
			`<span>${MESSAGES[index]}</span></div>`,
	).join(""),
);

panel(
	"status",
	`<span>connected</span><span class="center">6 workers</span>` +
		`<span class="right">q to quit</span>`,
);

const clock = dashboard.querySelector(".clock")!;
function tick(): void {
	const now = new Date();
	clock.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
}
tick();
const timer = setInterval(tick, 1000);

document.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "q") {
		clearInterval(timer);
		term.detach();
		process.exit(0);
	}
});
