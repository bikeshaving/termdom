/**
 * The input zoo: one of each form control on its user-agent defaults.
 * The only author styles are the page frame -- the controls themselves
 * render as the UA sheet says. Tab moves, Enter/Space activates, q quits.
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
	<h1>input zoo</h1>
	<form>
		<fieldset>
			<legend>text</legend>
			<p><label>text <input placeholder="placeholder ghost"></label></p>
			<p><label>password <input type="password" value="hunter2"></label></p>
			<p><textarea rows="3" cols="28">textarea, bordered,
wraps its content</textarea></p>
		</fieldset>
		<fieldset>
			<legend>choices</legend>
			<p><label><input type="checkbox" checked> checkbox</label>
			<label><input type="radio" name="r" checked> radio</label>
			<label><input type="radio" name="r"> radio</label></p>
			<p><label>select <select>
				<optgroup label="group">
					<option>first option</option>
					<option>second, wider option</option>
				</optgroup>
				<option disabled>disabled option</option>
			</select></label></p>
		</fieldset>
		<fieldset>
			<legend>buttons and gauges</legend>
			<p><button type="button">button</button> renders in brackets</p>
			<p>progress <progress id="bar" max="100" value="30"></progress>
			<progress></progress> (indeterminate)</p>
			<p>meter <meter value="0.8" optimum="0.9">80%</meter>
			<meter value="0.5" low="0.3" high="0.7" optimum="0.9">50%</meter>
			<meter value="0.1" low="0.3" high="0.7" optimum="0.9">10%</meter></p>
		</fieldset>
	</form>
	<p>tab moves · enter/space activates · q quits</p>
`;

const bar = document.getElementById("bar") as HTMLProgressElement;
setInterval(() => {
	bar.value = (bar.value + 10) % 110;
}, 1000);

document.addEventListener("keydown", (event) => {
	const key = (event as KeyboardEvent).key;
	const target = event.target as HTMLElement;
	if (
		key === "q" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA"
	) {
		term.window.close();
	}
});

term.attach();
