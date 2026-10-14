import {
	installGlobals,
	measure,
	mount,
	nextFrame,
	silence,
} from "../harness.ts";

const {proc, dom} = await mount();
installGlobals(dom);
const {EditorState} = await import("@codemirror/state");
const {EditorView, keymap, lineNumbers} = await import("@codemirror/view");
const {defaultKeymap, history, historyKeymap} = await import(
	"@codemirror/commands",
);
const {javascript} = await import("@codemirror/lang-javascript");
const {defaultHighlightStyle, syntaxHighlighting} = await import(
	"@codemirror/language",
);

const {document} = dom;
document.body.innerHTML = "<h1>Editor</h1><div id=editor></div>";
const doc = Array.from(
	{length: 100},
	(_, i) =>
		[
			`function step${i}(value: number, rect: {x: number; y: number}): number {`,
			`\tconst scaled = value * ${i + 1} + rect.x; // step ${i}`,
			"\treturn Math.max(scaled, rect.y);",
			"}",
		].join("\n"),
).join("\n");
const view = new EditorView({
	state: EditorState.create({
		doc,
		extensions: [
			lineNumbers(),
			history(),
			javascript({typescript: true}),
			syntaxHighlighting(defaultHighlightStyle),
			keymap.of([...defaultKeymap, ...historyKeymap]),
			EditorView.theme({
				".cm-scroller": {lineHeight: "1"},
				".cm-content": {padding: "0"},
			}),
		],
	}),
	parent: document.getElementById("editor"),
});
view.focus();
view.dispatch({selection: {anchor: doc.indexOf("\n", 200)}});
await nextFrame(dom);
silence(proc);

async function press(data: string): Promise<void> {
	const before = view.state.doc.length;
	proc.stdin.simulateResponse(data);
	for (let i = 0; i < 200 && view.state.doc.length === before; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	await nextFrame(dom);
}

const text = "const value = compute(element, rect);";
let typed = 0;
await measure("codemirror: type a character", 120, async () => {
	await press(text[typed % text.length]);
	typed++;
	if (typed % text.length === 0) {
		await press("\r");
	}
});
dom.dispose();
