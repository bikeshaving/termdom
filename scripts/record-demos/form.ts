/** The form demo, scripted: type, tab, type, submit. */
import type {TermDOM} from "../../src/index.js";

export default {
	setup(termdom: TermDOM) {
		const {document} = termdom;
		const style = document.createElement("style");
		style.textContent = `
			.title { color: cyan; font-weight: bold; }
			.field { display: flex; flex-direction: row; padding: 1 0 0 0; }
			.label { color: white; width: 8ch; }
			input { background: #1d3557; color: white; width: 26ch; }
			input:focus { background: #264f78; }
			.preview { color: #888; padding: 1 0 0 0; }
			.hint { color: #666; padding: 1 0 0 0; }
		`;
		document.head.appendChild(style);
		const form = document.createElement("div");
		form.innerHTML = `
			<div class="title">New profile — real inputs, real focus, real DOM</div>
			<div class="field"><div class="label">Name</div><input id="name" type="text"></div>
			<div class="field"><div class="label">Handle</div><input id="handle" type="text"></div>
			<div class="preview" id="preview">» start typing</div>
			<div class="hint">tab switches fields · the caret is the real cursor (IME-safe)</div>
		`;
		document.body.appendChild(form);
		const fields = ["name", "handle"].map(
			(id) => document.getElementById(id) as HTMLInputElement,
		);
		const preview = document.getElementById("preview")!;
		for (const field of fields) {
			field.addEventListener("input", () => {
				preview.textContent = `» ${fields[0].value || "?"} @${fields[1].value || "?"}`;
			});
		}
		fields[0].focus();
	},
	steps: [
		1.0,
		..."김남제"
			.split("")
			.flatMap((c) => [c, 0.28] as [string, number])
			.flat(),
		0.6,
		"\t",
		0.8,
		..."johndoe"
			.split("")
			.flatMap((c) => [c, 0.14] as [string, number])
			.flat(),
		2.0,
	] as Array<number | string>,
};
