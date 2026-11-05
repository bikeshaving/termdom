import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {pseudoElement} from "../src/internal/dom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

// The screen a document drawn from scratch with the mutated one's markup
// shows, which a restyle after mutations has to match.
async function freshScreen(document: Document): Promise<string> {
	const terminal = new MockProcess({cols: 60, rows: 12});
	const termdom = new TermDOM({transport: terminal.transport});
	termdom.document.head.innerHTML = document.head.innerHTML;
	termdom.document.body.innerHTML = document.body.innerHTML;
	await nextFrame(termdom);
	const screen = terminal.getScreenContents();
	termdom.dispose();
	return screen;
}

async function mount(
	css: string,
	html: string,
): Promise<{termdom: TermDOM; terminal: MockProcess; document: Document}> {
	const terminal = new MockProcess({cols: 60, rows: 12});
	const termdom = new TermDOM({transport: terminal.transport});
	const document = termdom.document as unknown as Document;
	document.head.innerHTML = `<style>${css}</style>`;
	document.body.innerHTML = html;
	await nextFrame(termdom);
	return {termdom, terminal, document};
}

function beforeText(element: Element): string | null {
	return (pseudoElement(element as never, "::before") as Element | null)
		?.textContent ?? null;
}

test("a class an ancestor gains or loses gives or takes a descendant's ::before", async () => {
	const {termdom, terminal, document} = await mount(
		".open { --v: 1; } .open .item::before { content: '>'; }",
		"<div class=app id=app><p><span class=item id=item>a</span></p></div>",
	);
	const app = document.getElementById("app")!;
	const item = document.getElementById("item")!;
	expect(beforeText(item)).toBe(null);
	app.classList.add("open");
	await nextFrame(termdom);
	expect(beforeText(item)).toBe(">");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	app.classList.remove("open");
	await nextFrame(termdom);
	expect(beforeText(item)).toBe(null);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class tested inside :not(), :is() or an attribute selector above the subject reaches a descendant's ::before", async () => {
	const {termdom, terminal, document} = await mount(
		".shut, .lit, .on { --v: 1; }" +
			" :not(.shut) > .a::before { content: '1'; }" +
			" .b:is(.lit *)::before { content: '2'; }" +
			" [class~=on] .c::after { content: '3'; }",
		"<div class=app id=app><p class=open><span class=a id=a>a</span>" +
			"<span class=b id=b>b</span><span class=c id=c>c</span></p></div>",
	);
	const app = document.getElementById("app")!;
	const p = app.firstElementChild!;
	app.classList.add("lit", "on");
	p.className = "shut";
	await nextFrame(termdom);
	expect(beforeText(document.getElementById("a")!)).toBe(null);
	expect(beforeText(document.getElementById("b")!)).toBe("2");
	expect(
		(pseudoElement(document.getElementById("c") as never, "::after") as
			Element | null)?.textContent,
	).toBe("3");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("an id an ancestor takes gives a descendant its ::before", async () => {
	const {termdom, terminal, document} = await mount(
		"#main { --v: 1; } #main .item::before { content: '#'; }",
		"<div class=app id=app><span class=item id=item>a</span></div>",
	);
	document.getElementById("app")!.id = "main";
	await nextFrame(termdom);
	expect(beforeText(document.getElementById("item")!)).toBe("#");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class change that no content rule tests leaves the descendants' ::before nodes in place", async () => {
	const {termdom, terminal, document} = await mount(
		".app.collapsed { color: red; --v: 1; } .item::before { content: '*'; }" +
			" .item::after { content: var(--tail); }",
		"<div class=app id=app>" +
			Array.from(
				{length: 20},
				(_, i) => `<p><span class=item>${i}</span><button>b</button></p>`,
			).join("") +
			"</div>",
	);
	const app = document.getElementById("app")!;
	const items = [...document.querySelectorAll(".item")];
	const nodes = items.map((item) => pseudoElement(item as never, "::before"));
	expect(nodes.every((node) => node !== null)).toBe(true);
	app.classList.add("collapsed");
	await nextFrame(termdom);
	expect(items.map((item) => pseudoElement(item as never, "::before")))
		.toEqual(nodes);
	expect(items.map(beforeText).every((text) => text === "*")).toBe(true);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	app.classList.remove("collapsed");
	await nextFrame(termdom);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class change on an ancestor and on a descendant in one batch reconsiders the descendant's ::before", async () => {
	const css =
		".app.collapsed { color: red; --v: 1; } .x::before { content: '+'; }" +
		" .y .z::before { content: '~'; }";
	const html =
		"<div class=app id=app><div id=mid>" +
		"<span id=item>a</span><span class=z id=z>z</span></div></div>";
	for (const order of ["ancestor first", "descendant first"]) {
		const {termdom, terminal, document} = await mount(css, html);
		const app = document.getElementById("app")!;
		const mid = document.getElementById("mid")!;
		const item = document.getElementById("item")!;
		if (order === "ancestor first") {
			app.classList.add("collapsed");
			item.classList.add("x");
			mid.classList.add("y");
		} else {
			mid.classList.add("y");
			item.classList.add("x");
			app.classList.add("collapsed");
		}
		await nextFrame(termdom);
		expect(beforeText(item)).toBe("+");
		expect(beforeText(document.getElementById("z")!)).toBe("~");
		expect(terminal.getScreenContents()).toBe(await freshScreen(document));
		termdom.dispose();
	}
});

test("a class that sets a custom property a descendant's ::before content reads restyles it", async () => {
	const {termdom, terminal, document} = await mount(
		".item::before { content: var(--mark); }" +
			" .theme { --mark: 'T'; } .theme.alt { --mark: 'A'; }",
		"<div class=theme id=app><p><span class=item id=item>a</span></p></div>",
	);
	const app = document.getElementById("app")!;
	const item = document.getElementById("item")!;
	expect(beforeText(item)).not.toBe(null);
	app.classList.add("alt");
	await nextFrame(termdom);
	expect(beforeText(item)).not.toBe(null);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	app.classList.remove("theme", "alt");
	await nextFrame(termdom);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class an ancestor gains that renumbers a counter redraws the ::before reading it", async () => {
	const {termdom, terminal, document} = await mount(
		"ol.c { counter-reset: n; list-style: none; }" +
			" ol.c > li { counter-increment: n; }" +
			" .double { --v: 1; } .double ol.c > li { counter-increment: n 2; }" +
			" ol.c > li::before { content: counter(n) '. '; }",
		"<div class=app id=app><ol class=c>" +
			"<li id=first>a</li><li>b</li><li id=last>c</li></ol></div>",
	);
	const app = document.getElementById("app")!;
	expect(beforeText(document.getElementById("last")!)).toBe("3. ");
	app.classList.add("double");
	await nextFrame(termdom);
	expect(beforeText(document.getElementById("first")!)).toBe("2. ");
	expect(beforeText(document.getElementById("last")!)).toBe("6. ");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	app.classList.remove("double");
	await nextFrame(termdom);
	expect(beforeText(document.getElementById("last")!)).toBe("3. ");
	termdom.dispose();
});

test("a class an ancestor gains that hides a counted item renumbers the items after it", async () => {
	const {termdom, terminal, document} = await mount(
		"ol.c { counter-reset: n; list-style: none; }" +
			" ol.c > li { counter-increment: n; }" +
			" .skip { --v: 1; } .skip li.gone { display: none; }" +
			" ol.c > li::before { content: counter(n) '. '; }",
		"<div class=app id=app><ol class=c>" +
			"<li>a</li><li class=gone>b</li><li id=last>c</li></ol></div>",
	);
	document.getElementById("app")!.classList.add("skip");
	await nextFrame(termdom);
	expect(beforeText(document.getElementById("last")!)).toBe("2. ");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class an ancestor gains that puts markers inside gives its list items ::marker nodes", async () => {
	const {termdom, terminal, document} = await mount(
		".in { list-style-position: inside; }",
		"<div class=app id=app><ul><li id=item>a</li><li>b</li></ul></div>",
	);
	const item = document.getElementById("item")!;
	expect(pseudoElement(item as never, "::marker")).toBe(null);
	document.getElementById("app")!.classList.add("in");
	await nextFrame(termdom);
	expect(pseudoElement(item as never, "::marker")).not.toBe(null);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a host's class tested by :host() in its shadow tree reaches the ::before of an element inside", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const termdom = new TermDOM({transport: terminal.transport});
	const document = termdom.document as unknown as Document;
	document.head.innerHTML = "<style>.on { --v: 1; }</style>";
	document.body.innerHTML = "<div class=host id=host></div>";
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML =
		"<style>:host(.on) .inner::before { content: '!'; }</style>" +
		"<div><span class=inner>x</span></div>";
	await nextFrame(termdom);
	const inner = root.querySelector(".inner")!;
	expect(beforeText(inner)).toBe(null);
	host.classList.add("on");
	await nextFrame(termdom);
	expect(beforeText(inner)).toBe("!");
	expect(terminal.getScreenContents()).toContain("!x");
	host.classList.remove("on");
	await nextFrame(termdom);
	expect(beforeText(inner)).toBe(null);
	termdom.dispose();
});

test("a ::before lays out and paints its text under the styles a class change gives it", async () => {
	const {termdom, terminal, document} = await mount(
		".item::before { content: 'ab'; } .up { text-transform: uppercase; }" +
			" .pad .item::before { padding-left: 3ch; }",
		"<div id=app><p><span class=item>x</span> <span class=item>y</span></p></div>",
	);
	const app = document.getElementById("app")!;
	expect(terminal.getScreenContents()).toContain("abx aby");
	app.classList.add("up");
	await nextFrame(termdom);
	expect(terminal.getScreenContents()).toContain("ABX ABY");
	app.classList.add("pad");
	await nextFrame(termdom);
	expect(terminal.getScreenContents()).toContain("   ABX    ABY");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	app.classList.remove("up", "pad");
	await nextFrame(termdom);
	expect(terminal.getScreenContents()).toContain("abx aby");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});
