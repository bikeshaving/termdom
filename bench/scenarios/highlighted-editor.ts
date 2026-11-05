/**
 * A terminal code editor drawn as Dim draws one: nested flex panes, a row
 * a line with a line number and one text node, syntax colors as static
 * ranges in CSS Custom Highlights, a status line, and the caret as the
 * selection in a contenteditable root. A key types a character into one
 * row, recolors that row, and moves the caret and the ruler.
 */
import {measure, mount, nextFrame, silence} from "../harness.ts";

const STYLE = `
	html, body { margin: 0; padding: 0; }
	.dim { display: flex; flex-direction: column; height: 100vh;
		overflow: hidden; outline: none; }
	.main { flex: 1; display: flex; flex-direction: row; overflow: hidden; }
	.pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
	.rows { flex: 1; overflow: hidden; }
	.row { white-space: pre; height: 1lh; overflow: hidden; }
	.nr { color: #808080; }
	.nr.current { color: #d7af00; }
	.status { display: flex; white-space: pre; height: 1lh; overflow: hidden;
		background-color: Highlight; color: HighlightText; }
	.status .name { flex: 1; overflow: hidden; }
	.status .ruler { width: 18ch; display: flex; }
	.ruler .position { flex: 1; }
	.cmd { display: flex; white-space: pre; height: 1lh; overflow: hidden; }
	.cmd .left { flex: 1; overflow: hidden; }
	.mode { font-weight: bold; }
	::highlight(keyword) { color: #ffff5f; }
	::highlight(string) { color: #ff87af; }
	::highlight(number) { color: #ff87af; }
	::highlight(comment) { color: #5fd7ff; }
	::highlight(identifier) { color: #5fffff; }
`;

const pattern =
	/\b(const|function|return|let|if)\b|("[^"]*")|(\b\d+\b)|(\/\/.*$)|(\b[a-z]\w*(?=\())/g;
const kinds = ["keyword", "string", "number", "comment", "identifier"];

function sourceLine(i: number): string {
	return [
		`function step${i}(value, rect) {`,
		`\tconst scaled = value * ${i + 1} + rect.x; // step ${i}`,
		`\treturn "row ${i}" + Math.max(scaled, rect.y);`,
		"}",
	][i % 4].replace("\t", "    ");
}

async function typeInto(label: string, rowCount: number): Promise<void> {
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	const {document} = dom;
	const window = dom.window as any;
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);
	const element = (tag: string, className: string, ...children: any[]): any => {
		const node = document.createElement(tag);
		node.className = className;
		node.append(...children);
		return node;
	};
	const highlights = new Map<string, any>();
	for (const kind of kinds) {
		const highlight = new window.Highlight();
		highlights.set(kind, highlight);
		window.CSS.highlights.set(kind, highlight);
	}

	const rowsBox = element("div", "rows");
	const position = element("span", "position", "1,1");
	const status = element(
		"div",
		"status",
		element("span", "name", "step.ts [+]"),
		element("span", "ruler", position, element("span", "", "Top")),
	);
	const cmd = element(
		"div",
		"cmd",
		element("span", "left", element("span", "mode", "-- INSERT --")),
	);
	const root = element(
		"div",
		"dim",
		element("div", "main", element("div", "pane", rowsBox, status)),
		cmd,
	);
	root.contentEditable = "true";
	document.body.replaceChildren(root);

	const lines = Array.from({length: rowCount}, (_, i) => sourceLine(i));
	const rows = lines.map((line, i) => {
		const text = document.createTextNode(line);
		const nr = element("span", "nr", `${String(i + 1).padStart(3)} `);
		rowsBox.append(element("div", "row", nr, text));
		return {text, nr, ranges: [] as Array<[any, any]>};
	});

	function color(i: number): void {
		const row = rows[i];
		for (const [highlight, range] of row.ranges) {
			highlight.delete(range);
		}
		row.ranges = [];
		for (const match of lines[i].matchAll(pattern)) {
			const highlight = highlights.get(
				kinds[match.slice(1).findIndex((group) => group)],
			);
			const range = new window.StaticRange({
				startContainer: row.text,
				startOffset: match.index,
				endContainer: row.text,
				endOffset: match.index + match[0].length,
			});
			highlight.add(range);
			row.ranges.push([highlight, range]);
		}
	}

	for (let i = 0; i < rows.length; i++) {
		color(i);
	}
	const line = 9;
	rows[line].nr.className = "nr current";
	root.focus();
	await nextFrame(dom);

	const typed = "let total = sum(42); ";
	let at = 0;
	let col = 4;
	document.addEventListener("keydown", (event: KeyboardEvent) => {
		event.preventDefault();
		if (col > 60) {
			lines[line] = sourceLine(line);
			col = 4;
		}
		lines[line] =
			lines[line].slice(0, col) +
			typed[at % typed.length] +
			lines[line].slice(col);
		at++;
		col++;
		const text = rows[line].text;
		if (text.data !== lines[line]) {
			text.data = lines[line];
		}
		color(line);
		position.textContent = `${line + 1},${col + 1}`;
		document.getSelection().collapse(text, col);
	});

	async function press(): Promise<void> {
		proc.stdin.simulateResponse("x");
		await nextFrame(dom);
	}

	for (let i = 0; i < 100; i++) {
		await press();
	}
	await measure(label, 200, press, 20);
	dom.dispose();
}

await typeInto("highlighted editor: type a character", 38);
await typeInto("highlighted editor: type in a 400-row view", 400);
