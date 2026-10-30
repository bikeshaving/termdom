import {measure, mount, nextFrame, silence} from "../harness.ts";

const HAS_RULES = [
	"body:has(.modal-mask) .result { opacity: 0.5 }",
	"body:has(.drawer-open) .header { padding-left: 2ch }",
	"html:has(.dark-toggle:checked) .result { color: white }",
	".wrapper:has(.sidebar) .main { margin-right: 2ch }",
	"li:has(.related) ~ li .snippet { color: gray }",
	"li:has(+ li.ad) { border-bottom: 1px solid }",
	".results:has(> .empty) .footer { display: none }",
	...Array.from(
		{length: 27},
		(_, i) =>
			`.wrapper:has(.flag-${i}) .result:nth-child(${i + 1}) { font-weight: bold }`,
	),
].join("\n");

const CSS = `
.result { display: block; padding: 0 1ch; }
.result .title { font-weight: bold; }
.result .snippet::before { content: "› "; }
${HAS_RULES}
`;

function result(i: number): string {
	return `<li class="result"><div class="title">Result ${i}</div><div class="snippet">Some text about result ${i}</div><a href="#${i}">link</a></li>`;
}

const PAGE =
	`<style>${CSS}</style><div class="wrapper"><div class="header">search</div>` +
	`<div class="main"><ul class="results">${Array.from({length: 150}, (_, i) => result(i)).join("")}</ul></div>` +
	`<div class="footer">footer</div></div>`;

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	dom.document.body.innerHTML = PAGE;
	await nextFrame(dom);
	const list = dom.document.querySelector(".results");
	let n = 0;
	await measure(
		"has: 20 batches that add a result and read a style, under 34 :has() rules",
		5,
		async () => {
			for (let i = 0; i < 20; i++) {
				const li = dom.document.createElement("li");
				li.className = "result";
				li.innerHTML = `<div class="title">New ${n++}</div><div class="snippet">text</div>`;
				list.append(li);
				li.style.setProperty("--index", String(i));
				void dom.window.getComputedStyle(li).color;
			}
			await nextFrame(dom);
			for (let i = 0; i < 20; i++) {
				list.lastElementChild.remove();
			}
			await nextFrame(dom);
		},
		1,
	);
	dom.dispose();
}

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	dom.document.body.innerHTML = PAGE;
	await nextFrame(dom);
	const wrapper = dom.document.querySelector(".wrapper");
	let on = false;
	await measure(
		"has: add and remove a class a :has() rule tests",
		10,
		async () => {
			on = !on;
			if (on) {
				const flag = dom.document.createElement("span");
				flag.className = "flag-3";
				wrapper.append(flag);
			} else {
				wrapper.querySelector(".flag-3").remove();
			}
			await nextFrame(dom);
		},
		2,
	);
	dom.dispose();
}
