import {measure, TermDOM} from "../harness.ts";

const term = new TermDOM();
const {document} = term;
document.body.innerHTML =
	"<style>.on { color: red; font-weight: bold } li:has(.on) { background: blue }</style>" +
	"<ul>" +
	Array.from(
		{length: 500},
		(_, i) => `<li><span id=s${i}>item ${i}</span></li>`,
	).join("") +
	"</ul>";
term.renderANSI();
let next = 0;
await measure(
	"toggle: a class under li:has(), 500 items",
	200,
	() => {
		document.getElementById(`s${next++ % 500}`).classList.toggle("on");
		term.renderANSI();
	},
	50,
);
term.dispose();
