/**
 * Sheets that join or leave a document after its first parse: a <style>
 * appended to the document or to a shadow root, read before and after the
 * mutation observer delivers, gives the styles a parse from scratch gives.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

function created(html: string): TermDOM {
	return new TermDOM({transport: new MockProcess().transport, html});
}

function color(dom: TermDOM, selector: string): string {
	return dom.window.getComputedStyle(dom.document.querySelector(selector)!)
		.color;
}

test("a sheet appended to the document applies before the observer delivers", () => {
	const dom = created("<style>p { color: red }</style><p class=a>x</p>");
	expect(color(dom, "p")).toBe("rgb(255, 0, 0)");
	const style = dom.document.createElement("style");
	style.textContent = ".a { color: blue }";
	dom.document.head.append(style);
	expect(color(dom, "p")).toBe("rgb(0, 0, 255)");
	style.remove();
	expect(color(dom, "p")).toBe("rgb(255, 0, 0)");
	dom.dispose();
});

test("a sheet appended after a shadow tree's ranks as a parse from scratch ranks it", async () => {
	const shadowCSS = ":host { color: blue }";
	const documentCSS = ".host { color: red }";
	const build = (dom: TermDOM): void => {
		const host = dom.document.createElement("div");
		host.className = "host";
		host.attachShadow({mode: "open"}).innerHTML =
			`<style>${shadowCSS}</style>x`;
		dom.document.body.append(host);
	};
	const late = created("");
	build(late);
	await nextFrame(late);
	const style = late.document.createElement("style");
	style.textContent = documentCSS;
	late.document.head.append(style);
	await nextFrame(late);
	const early = created(`<style>${documentCSS}</style>`);
	build(early);
	await nextFrame(early);
	expect(color(late, ".host")).toBe(color(early, ".host"));
	late.dispose();
	early.dispose();
});

test("a shadow tree built before its host connects takes its sheet", async () => {
	const dom = created("<style>.big { color: red }</style><main></main>");
	await nextFrame(dom);
	const host = dom.document.createElement("div");
	host.attachShadow({mode: "open"}).innerHTML =
		"<style>span { color: green }</style><span>x</span>";
	expect(color(dom, "main")).toBe("rgb(0, 0, 0)");
	dom.document.querySelector("main")!.append(host);
	await nextFrame(dom);
	const span = host.shadowRoot!.querySelector("span")!;
	expect(dom.window.getComputedStyle(span).color).toBe("rgb(0, 128, 0)");
	dom.dispose();
});

test("an appended sheet that puts markers inside gives the items marker nodes", async () => {
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({
		transport: terminal.transport,
		html: "<ul><li>one</li></ul>",
	});
	dom.attach();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("  • one");
	const style = dom.document.createElement("style");
	style.textContent = "ul { list-style-position: inside }";
	dom.document.head.append(style);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("    • one");
	dom.dispose();
});

test("an ancestor's style attribute puts the markers inside", async () => {
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({
		transport: terminal.transport,
		html: "<div style=\"list-style-position: inside\"><ul><li>one</li></ul></div>",
	});
	dom.attach();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("    • one");
	dom.dispose();
});

test("the screen after sheets come and go is what a fresh render shows", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({
		transport: terminal.transport,
		html: "<style>.a { color: red } li { margin-left: 1px }</style><main><ul class=l><li class=a>one</li><li>two</li></ul></main>",
	});
	dom.attach();
	await nextFrame(dom);
	const {document} = dom;
	const main = document.querySelector("main")!;
	for (let i = 0; i < 8; i++) {
		const host = document.createElement("div");
		host.attachShadow({mode: "open"}).innerHTML =
			`<style>.t { margin-left: ${i}px } .t::before { content: "${i}" }</style><div class=t>in</div>`;
		main.append(host);
		if (i % 4 === 1) {
			const style = document.createElement("style");
			style.textContent = ".l { list-style-position: inside }";
			document.head.append(style);
		}
		if (i === 5) {
			document.querySelector("style")!.remove();
		}
		expect(dom.window.getComputedStyle(host).display).toBe("block");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await nextFrame(dom);
	const lines = (text: string): string[] =>
		text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line !== "");
	expect(lines(terminal.getPlainText())).toEqual(
		lines(dom.renderANSI().replace(/\x1b\[[0-9;]*m/g, "")),
	);
	dom.dispose();
});

test("the screen after a sheet puts a list's markers inside is what a fresh render shows", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({
		transport: terminal.transport,
		html: "<main><ul class=l><li>one</li><li>two</li></ul><p>p</p></main>",
	});
	dom.attach();
	await nextFrame(dom);
	const style = dom.document.createElement("style");
	style.textContent = ".l { list-style-position: inside }";
	dom.document.head.append(style);
	// Read before the observer delivers, which catches the sheet up first.
	expect(color(dom, "p")).toBe("rgb(0, 0, 0)");
	await nextFrame(dom);
	const lines = (text: string): string[] =>
		text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line !== "");
	expect(lines(terminal.getPlainText())).toEqual(
		lines(dom.renderANSI().replace(/\x1b\[[0-9;]*m/g, "")),
	);
	dom.dispose();
});
