import {measure, mount, nextFrame, silence} from "../harness.ts";

const CSS = `
:root { --fg: #222; --bg: #fff; --accent: #36c; --gap: 1ch; }
body { color: var(--fg); background: var(--bg); margin: 0; }
.app { display: flex; flex-direction: column; gap: var(--gap); }
.header, .footer { display: flex; justify-content: space-between; padding: 0 1ch; }
.nav a { color: var(--accent); text-decoration: none; }
.nav a:hover, .nav a[aria-current="page"] { text-decoration: underline; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); }
.card { border: 1px solid; padding: 0 1ch; }
.card > .title { font-weight: bold; }
.card .meta span + span::before { content: " · "; }
.card[data-state="done"] .title { text-decoration: line-through; }
.list li { display: flex; gap: 1ch; }
.list li:nth-child(2n) { background: #eee; }
.list li .badge::before { content: "●"; color: var(--accent); }
.dark { --fg: #eee; --bg: #111; --accent: #9cf; }
${Array.from({length: 300}, (_, i) => `.u${i} { margin-left: ${i % 5}px }`).join("\n")}
${Array.from({length: 100}, (_, i) => `.section-${i} .card:not(.hidden) .meta { color: rgb(${i}, 0, 0) }`).join("\n")}
`;

function card(i: number): string {
	return `<div class="card u${i % 300}" data-state="${i % 7 === 0 ? "done" : "open"}">` +
		`<div class="title">Card ${i}</div>` +
		`<div class="meta"><span>by someone</span><span>${i} min</span><span>${i % 9} replies</span></div>` +
		"</div>";
}

function page(cards: number, items: number): string {
	return `<style>${CSS}</style><div class="app">` +
		`<div class="header"><div class="nav">${Array.from({length: 8}, (_, i) => `<a href="#${i}"${i === 0 ? ' aria-current="page"' : ""}>Link ${i}</a>`).join(" ")}</div></div>` +
		`<div class="grid section-${cards % 100}">${Array.from({length: cards}, (_, i) => card(i)).join("")}</div>` +
		`<ul class="list">${Array.from({length: items}, (_, i) => `<li class="u${i % 300}"><span class="badge"></span><span>Row ${i}</span></li>`).join("")}</ul>` +
		`<div class="footer">footer</div></div>`;
}

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	await measure(
		"site: first render of a 600-card, 1000-row page",
		5,
		async () => {
			dom.document.body.innerHTML = page(600, 1000);
			await nextFrame(dom);
			dom.document.body.innerHTML = "";
			await nextFrame(dom);
		},
		2,
	);
	dom.dispose();
}

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	dom.document.body.innerHTML = page(600, 1000);
	await nextFrame(dom);
	await measure(
		"site: switch the theme class on <body>",
		10,
		async () => {
			dom.document.body.classList.toggle("dark");
			await nextFrame(dom);
		},
		3,
	);
	dom.dispose();
}

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	dom.document.body.innerHTML = page(200, 200);
	await nextFrame(dom);
	const list = dom.document.querySelector(".list");
	await measure(
		"site: append 100 rows, reading a size after each",
		5,
		async () => {
			for (let i = 0; i < 100; i++) {
				const li = dom.document.createElement("li");
				li.innerHTML = `<span class="badge"></span><span>New ${i}</span>`;
				list.append(li);
				void li.offsetHeight;
			}
			await nextFrame(dom);
			for (let i = 0; i < 100; i++) {
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
	dom.document.body.innerHTML = page(600, 1000);
	await nextFrame(dom);
	const cards = [...dom.document.querySelectorAll(".card")];
	let n = 0;
	await measure(
		"site: set an inline style on 600 cards in one frame",
		10,
		async () => {
			n++;
			for (const element of cards) {
				element.style.setProperty("margin-left", `${n % 3}px`);
			}
			await nextFrame(dom);
		},
		3,
	);
	dom.dispose();
}

{
	const {proc, dom} = await mount(120, 40);
	silence(proc);
	dom.document.body.innerHTML = page(600, 1000);
	await nextFrame(dom);
	const cards = [...dom.document.querySelectorAll(".card")];
	let n = 0;
	await measure(
		"site: flip data-state on 50 cards in one frame",
		10,
		async () => {
			n++;
			for (let i = 0; i < 50; i++) {
				cards[(n * 50 + i) % cards.length].dataset.state = n % 2
					? "done"
					: "open";
			}
			await nextFrame(dom);
		},
		3,
	);
	dom.dispose();
}
