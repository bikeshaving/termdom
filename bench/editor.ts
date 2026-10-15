/**
 * CodeMirror as the example runs it, on a 400-line file, with the cursor
 * near the top.
 */
import {installGlobals, mount, nextFrame} from "./harness.ts";

export async function mountEditor(): Promise<{proc: any; dom: any; view: any}> {
	const {proc, dom} = await mount(100, 40, {cellSize: "auto"});
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
			],
		}),
		parent: document.getElementById("editor"),
	});
	view.focus();
	view.dispatch({selection: {anchor: doc.indexOf("\n", 200)}});
	await nextFrame(dom);
	return {proc, dom, view};
}
