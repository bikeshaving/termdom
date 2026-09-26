/**
 * A pseudo-class that reads state no attribute records -- focus, hover,
 * checkedness, a definition, a custom state -- restyles what its rules
 * reach when that state changes: the element, what follows it through a
 * sibling combinator, and through :has() anything at all.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a :focus ~ rule follows the focus out and back", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({
		transport: proc.transport,
		html:
			"<style>button:focus ~ span { color: rgb(255, 0, 0); }</style>" +
			"<div><button id=a>a</button><span>after a</span></div>" +
			"<div><button id=b>b</button><span>after b</span></div>",
	});
	await nextFrame(termdom);
	const {document, window} = termdom;
	const [first, second] = Array.from(document.querySelectorAll("span"));
	const color = (element: Element): string =>
		window.getComputedStyle(element).getPropertyValue("color");

	(document.getElementById("a") as HTMLButtonElement).focus();
	expect(color(first)).toBe("rgb(255, 0, 0)");
	(document.getElementById("b") as HTMLButtonElement).focus();
	expect(color(first)).toBe("rgb(0, 0, 0)");
	expect(color(second)).toBe("rgb(255, 0, 0)");
	(document.activeElement as HTMLElement).blur();
	expect(color(second)).toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("a :hover + rule follows the pointer", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({
		transport: proc.transport,
		html:
			"<style>div:hover + p { color: rgb(0, 0, 255); }</style>" +
			"<div>first</div><p>next</p><div>second</div>",
	});
	await nextFrame(termdom);
	const {document, window} = termdom;
	const next = document.querySelector("p")!;
	const color = (): string =>
		window.getComputedStyle(next).getPropertyValue("color");

	await send(proc, "\x1b[<35;2;1M");
	await nextFrame(termdom);
	expect(color()).toBe("rgb(0, 0, 255)");
	await send(proc, "\x1b[<35;2;3M");
	await nextFrame(termdom);
	expect(color()).toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

function page(html: string): {termdom: TermDOM; color: (id: string) => string} {
	const termdom = new TermDOM({transport: new MockProcess().transport, html});
	const color = (id: string): string => termdom.window
		.getComputedStyle(termdom.document.getElementById(id)!)
		.getPropertyValue("color");
	return {termdom, color};
}

test("checking a box restyles what :checked reaches", () => {
	const {termdom, color} = page(
		"<style>" +
		"input:checked ~ span { color: rgb(255, 0, 0); }" +
		"section:has(input:checked) p { color: rgb(0, 0, 255); }" +
		"</style>" +
		"<input type=checkbox id=box><span id=after>a</span>" +
		"<section><p id=deep>p</p><input type=checkbox id=inner></section>",
	);
	const {document} = termdom;
	expect(color("after")).toBe("rgb(0, 0, 0)");
	(document.getElementById("box") as HTMLInputElement).checked = true;
	expect(color("after")).toBe("rgb(255, 0, 0)");
	(document.getElementById("inner") as HTMLInputElement).checked = true;
	expect(color("deep")).toBe("rgb(0, 0, 255)");
	(document.getElementById("inner") as HTMLInputElement).checked = false;
	expect(color("deep")).toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("showing a popover restyles what :popover-open reaches", () => {
	const {termdom, color} = page(
		"<style>[popover]:popover-open + p { color: rgb(0, 0, 255); }</style>" +
		"<div popover id=pop>x</div><p id=next>p</p>",
	);
	(termdom.document.getElementById("pop") as HTMLElement).showPopover();
	expect(color("next")).toBe("rgb(0, 0, 255)");
	termdom.dispose();
});

test("defining an element restyles what :defined reaches", () => {
	const {termdom, color} = page(
		"<style>late-element:defined + p { color: rgb(0, 128, 0); }</style>" +
		"<late-element></late-element><p id=next>p</p>",
	);
	const {window} = termdom as any;
	expect(color("next")).toBe("rgb(0, 0, 0)");
	window.customElements.define(
		"late-element",
		class extends window.HTMLElement {},
	);
	expect(color("next")).toBe("rgb(0, 128, 0)");
	termdom.dispose();
});

test("a custom state restyles what :state() reaches", () => {
	const {termdom, color} = page(
		"<style>div:has(state-element:state(on)) p { color: rgb(255, 0, 0); }</style>" +
		"<div><state-element></state-element><p id=deep>p</p></div>",
	);
	const {window, document} = termdom as any;
	let internals: any;
	window.customElements.define(
		"state-element",
		class extends window.HTMLElement {
			constructor() {
				super();
				internals = this.attachInternals();
			}
		},
	);
	document.querySelector("state-element");
	internals.states.add("on");
	expect(color("deep")).toBe("rgb(255, 0, 0)");
	internals.states.delete("on");
	expect(color("deep")).toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("everything restyling leaves room for what is added after", () => {
	const {termdom, color} = page(
		"<style>#subject:has(#dialog:open) { color: rgb(0, 128, 0); }</style>" +
		"<div id=subject>text<dialog id=dialog>d</dialog></div>",
	);
	const {document} = termdom;
	(document.getElementById("dialog") as HTMLDialogElement).show();
	expect(color("subject")).toBe("rgb(0, 128, 0)");
	// A button's shadow tree reports its state as it is built, which with
	// :has(:open) restyles everything in the middle of the insertion.
	const button = document.createElement("button");
	button.textContent = "late";
	document.body.appendChild(button);
	expect(button.getBoundingClientRect().height).toBeGreaterThan(0);
	termdom.dispose();
});
