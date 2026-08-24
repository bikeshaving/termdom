/**
 * The two lives of a dialog. show() opens it in flow: a bordered block
 * that takes its place in the document, terminal-native, nothing else
 * moves. showModal() takes over: top layer, viewport-centered, backdrop
 * clearing the screen, the rest of the page inert until it closes.
 * Tab moves, Enter activates, q quits.
 */

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body { margin: 0; padding: 0 1ch; }
	h1 { background-color: Highlight; color: HighlightText; padding-left: 1ch; }
	p { margin-top: 1px; }
`;
document.head.appendChild(style);

document.body.innerHTML = `
	<h1>dialog</h1>
	<p>transcript line one</p>
	<p>transcript line two</p>
	<p>
		<button type="button" id="flow">show()</button>
		<button type="button" id="modal">showModal()</button>
	</p>
	<dialog id="dlg">
		<p id="how"></p>
		<button type="button" id="close">close</button>
	</dialog>
	<p id="tail">this line stays put for show() and vanishes under the
	modal backdrop</p>
	<p>tab · enter · q quits</p>
`;

const dialog = document.getElementById("dlg") as HTMLDialogElement;
const how = document.getElementById("how")!;
document.getElementById("flow")!.addEventListener("click", () => {
	how.textContent = "in flow: the page grew by this box";
	dialog.show();
});
document.getElementById("modal")!.addEventListener("click", () => {
	how.textContent = "modal: centered, backdrop, page inert";
	dialog.showModal();
});
document.getElementById("close")!.addEventListener("click", () => {
	dialog.close();
});

document.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "q" && !dialog.open) {
		term.window.close();
	}
});

term.attach();
