/**
 * Render a demo to an SVG "screenshot" -- the engine's own cells, no screen
 * capture. Drives examples/todomvc.ts through the mock terminal, then walks
 * the xterm buffer emitting background rects and colored text runs.
 *
 *   bun scripts/screenshot.ts > docs/todomvc.svg
 */
import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "../tests/test-utils.ts";

const COLS = 64;
const ROWS = 16;
const CELL_W = 9.6;
const CELL_H = 21;
const PAD = 16;
const FONT_SIZE = 16;
const DEFAULT_FG = "#e6edf3";
const BG = "#0d1117";

function css(color: number): string {
	return `#${color.toString(16).padStart(6, "0")}`;
}

const terminal = new MockProcess({cols: COLS, rows: ROWS});
const term = new TermDOM({transport: terminal.transport});
const {document} = term;

// The TodoMVC styles and components, inline: importing the example would
// grab the real process. This is the same markup the example produces.
document.head.innerHTML = `<style>
	.todoapp { padding: 0 1ch; }
	h1 { color: cyan; font-weight: bold; }
	.new-todo { width: 100%; }
	.main { padding-top: 1px; }
	.todo-list { padding-left: 0; list-style: none; }
	.todo-list li .view { display: flex; flex-direction: row; gap: 1ch; }
	.todo-list li.completed label { text-decoration: underline; color: #666; }
	.destroy { color: red; }
	.destroy::before { content: none; }
	.destroy::after { content: "(x)"; }
	.footer { padding-top: 1px; color: yellow; }
	.filters { display: flex; flex-direction: row; gap: 1ch; padding-left: 0; list-style: none; }
	.filters a.selected { color: cyan; font-weight: bold; }
	.filters a { color: #888; }
</style>`;
document.body.innerHTML = `<section class="todoapp">
	<h1>todos</h1>
	<input class="new-todo" placeholder="What needs to be done?" />
	<section class="main">
		<ul class="todo-list">
			<li class="completed"><div class="view"><input type="checkbox" checked /><label>Render HTML to the terminal</label><button class="destroy"></button></div></li>
			<li><div class="view"><input type="checkbox" /><label>Style it with real CSS</label><button class="destroy"></button></div></li>
			<li><div class="view"><input type="checkbox" /><label>Ship it</label><button class="destroy"></button></div></li>
		</ul>
		<footer class="footer">
			<span class="todo-count"><strong>2</strong> items left</span>
			<ul class="filters"><li><a class="selected">All</a></li><li><a>Active</a></li><li><a>Completed</a></li></ul>
		</footer>
	</section>
</section>`;
document
	.querySelector("input.new-todo")
	?.dispatchEvent(new term.window.Event("noop"));
await nextFrame(term);
(document.querySelector(".new-todo") as HTMLElement)?.focus();
await nextFrame(term);

const buffer = (terminal as any).terminal.buffer.active;
const rows: string[] = [];
let bgRects = "";
for (let y = 0; y < ROWS; y++) {
	const line = buffer.getLine(y);
	if (!line) {
		continue;
	}
	let spans = "";
	let run = "";
	let runFg = DEFAULT_FG;
	let runBold = false;
	let runUnderline = false;
	let runStart = 0;
	const flush = (endCol: number) => {
		if (run.trim().length > 0) {
			const esc = run
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			spans += `<text x="${(PAD + runStart * CELL_W).toFixed(1)}" y="${(
				PAD +
				y * CELL_H +
				FONT_SIZE
			).toFixed(1)}" fill="${runFg}"${runBold ? ' font-weight="bold"' : ""}${
				runUnderline ? ' text-decoration="underline"' : ""
			} xml:space="preserve">${esc}</text>`;
		}
		run = "";
		runStart = endCol;
	};
	for (let x = 0; x < COLS; x++) {
		const cell = line.getCell(x);
		const chars = cell?.getChars() || " ";
		const fg =
			cell && !cell.isFgDefault() ? css(cell.getFgColor()) : DEFAULT_FG;
		const bold = !!cell?.isBold();
		const underline = !!cell?.isUnderline();
		if (cell && !cell.isBgDefault()) {
			bgRects += `<rect x="${(PAD + x * CELL_W).toFixed(1)}" y="${(
				PAD +
				y * CELL_H
			).toFixed(1)}" width="${CELL_W}" height="${CELL_H}" fill="${css(
				cell.getBgColor(),
			)}"/>`;
		}
		if (fg !== runFg || bold !== runBold || underline !== runUnderline) {
			flush(x);
			runFg = fg;
			runBold = bold;
			runUnderline = underline;
		}
		run += chars;
		if (cell && cell.getWidth() === 2) {
			x++;
		}
	}
	flush(COLS);
	rows.push(spans);
}

const width = PAD * 2 + COLS * CELL_W;
const height = PAD * 2 + ROWS * CELL_H;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FONT_SIZE}">
<rect width="${width}" height="${height}" rx="8" fill="${BG}"/>
${bgRects}
${rows.join("\n")}
</svg>`;
console.log(svg);
term.dispose();
process.exit(0);
