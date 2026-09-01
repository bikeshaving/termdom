/**
 * The popover: the top layer as an attribute reaches it. A popover is hidden
 * until it is shown, paints over the document when it is, closes when the user
 * clicks past it or presses Escape -- unless it is manual, which does neither
 * -- and an auto one closes whatever open popover it is not nested inside.
 */
import {expect, test} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

async function open(
	html: string,
	cols = 40,
	rows = 10,
): Promise<{
	terminal: MockProcess;
	dom: TermDOM;
	document: Document;
	popover: HTMLElement;
}> {
	const terminal = new MockProcess({rows, cols});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	dom.attach();
	await nextFrame(dom);
	const {document} = dom;
	const popover = document.querySelector("[popover]") as HTMLElement;
	return {terminal, dom, document, popover};
}

function press(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A press and a release at a screen cell, which is a click. */
async function click(terminal: MockProcess, col: number, row: number): Promise<
	void> {
	await press(terminal, `\x1b[<0;${col};${row}M`);
	await press(terminal, `\x1b[<0;${col};${row}m`);
}

/* --------------------------------------------------------- state mapping */

test("the popover attribute's states are auto, manual, and not a popover", async () => {
	const {document, dom} = await open(
		"<div id=empty popover></div>" +
		"<div id=auto popover=auto></div>" +
		"<div id=manual popover=manual></div>" +
		"<div id=hint popover=hint></div>" +
		"<div id=bogus popover=sideways></div>" +
		"<div id=none></div>",
	);
	const state = (id: string) =>
		(document.getElementById(id) as HTMLElement).popover;
	// The empty string is the attribute's own spelling of auto.
	expect(state("empty")).toBe("auto");
	expect(state("auto")).toBe("auto");
	expect(state("manual")).toBe("manual");
	// A value the attribute does not know is manual, and hint is not
	// implemented, so it takes that route.
	expect(state("hint")).toBe("manual");
	expect(state("bogus")).toBe("manual");
	// Absent is not a popover at all, and showing one throws.
	expect(state("none")).toBe(null);
	expect(() =>
		(document.getElementById("none") as HTMLElement).showPopover(),
	).toThrow(/not a popover/);
	dom.dispose();
});

test("the popover attribute reflects both ways", async () => {
	const {document, dom} = await open("<div id=box></div>");
	const box = document.getElementById("box") as HTMLElement;
	box.popover = "auto";
	expect(box.getAttribute("popover")).toBe("auto");
	box.popover = null as unknown as string;
	expect(box.hasAttribute("popover")).toBe(false);
	dom.dispose();
});

/* ------------------------------------------------------------- rendering */

test("a popover is hidden until it is shown, and paints over the page", async () => {
	const {terminal, dom, popover} = await open(
		"<p>page one</p><p>page two</p><div popover><p>the popover</p></div>",
	);
	// Hidden until shown: the UA sheet's display: none, not a special case in
	// the painter -- the content is not on screen at all.
	expect(terminal.getPlainText()).not.toContain("the popover");
	expect(terminal.getPlainText()).toContain("page one");

	popover.showPopover();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("the popover");
	// Over the page rather than instead of it: a popover has no scrim.
	expect(terminal.getPlainText()).toContain("page one");

	popover.hidePopover();
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("the popover");
	dom.dispose();
});

test("an author's ::backdrop rule paints behind a showing popover", async () => {
	const {terminal, dom, popover} = await open(
		"<style>[popover]::backdrop { background-color: Canvas; }</style>" +
		"<p>page one</p><p>page two</p><div popover><p>hello</p></div>",
	);
	popover.showPopover();
	await nextFrame(dom);
	// The backdrop clears the viewport the way a modal dialog's does, so the
	// page it covers is gone while the popover is up.
	const output = terminal.getPlainText();
	expect(output).toContain("hello");
	expect(output).not.toContain("page one");
	dom.dispose();
});

/* ------------------------------------------------------- show, hide, toggle */

test(":popover-open matches a popover while it is showing", async () => {
	const {document, dom, popover} = await open("<div popover>hi</div>");
	expect(popover.matches(":popover-open")).toBe(false);

	popover.showPopover();
	expect(popover.matches(":popover-open")).toBe(true);
	expect(document.querySelectorAll("[popover]:popover-open").length).toBe(1);

	popover.hidePopover();
	expect(popover.matches(":popover-open")).toBe(false);
	expect(document.querySelectorAll(":popover-open").length).toBe(0);
	dom.dispose();
});

test("showing a shown popover and hiding a hidden one do nothing", async () => {
	const {dom, popover} = await open("<div popover>hi</div>");
	popover.hidePopover();
	expect(popover.matches(":popover-open")).toBe(false);

	popover.showPopover();
	popover.showPopover();
	expect(popover.matches(":popover-open")).toBe(true);
	dom.dispose();
});

test("a popover out of the document cannot be shown", async () => {
	const {document, dom} = await open("<p>page</p>");
	const detached = document.createElement("div") as HTMLElement;
	detached.setAttribute("popover", "");
	expect(() => detached.showPopover()).toThrow(/connected/);
	dom.dispose();
});

test("a dialog showing modally cannot also show as a popover", async () => {
	const {document, dom} = await open("<dialog popover>hi</dialog>");
	const dialog = document.querySelector("dialog") as HTMLDialogElement;
	dialog.showModal();
	expect(() => (dialog as HTMLElement).showPopover()).toThrow(/modally/);
	dialog.close();
	dom.dispose();
});

test("togglePopover flips the state, and force names the half to run", async () => {
	const {dom, popover} = await open("<div popover>hi</div>");
	expect(popover.togglePopover()).toBe(true);
	expect(popover.togglePopover()).toBe(false);

	expect(popover.togglePopover(true)).toBe(true);
	expect(popover.togglePopover(true)).toBe(true);
	// The dictionary form of force, which the ambient DOM types predate.
	expect((popover as any).togglePopover({force: false})).toBe(false);
	expect((popover as any).togglePopover({force: false})).toBe(false);
	dom.dispose();
});

test("removing a showing popover takes it out of the top layer", async () => {
	const {terminal, dom, popover} = await open(
		"<p>page one</p><div popover>the popover</div>",
	);
	popover.showPopover();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("the popover");

	popover.remove();
	await nextFrame(dom);
	expect(popover.matches(":popover-open")).toBe(false);
	expect(terminal.getPlainText()).not.toContain("the popover");
	dom.dispose();
});

test("changing the attribute's state closes a showing popover", async () => {
	const {dom, popover} = await open("<div popover=auto>hi</div>");
	popover.showPopover();
	popover.setAttribute("popover", "manual");
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

/* ---------------------------------------------------------------- events */

test("beforetoggle and toggle report the states either side of the move", async () => {
	const {dom, popover} = await open("<div popover>hi</div>");
	const seen: string[] = [];
	for (const type of ["beforetoggle", "toggle"]) {
		popover.addEventListener(type, (event: any) => {
			seen.push(`${type} ${event.oldState}->${event.newState}`);
		});
	}

	popover.showPopover();
	await nextFrame(dom);
	popover.hidePopover();
	await nextFrame(dom);

	expect(seen).toEqual([
		"beforetoggle closed->open",
		"toggle closed->open",
		"beforetoggle open->closed",
		"toggle open->closed",
	]);
	dom.dispose();
});

test("a canceled beforetoggle keeps the popover closed", async () => {
	const {dom, popover} = await open("<div popover>hi</div>");
	const seen: string[] = [];
	popover.addEventListener("beforetoggle", (event: Event) => {
		seen.push("beforetoggle");
		event.preventDefault();
	});
	popover.addEventListener("toggle", () => seen.push("toggle"));

	popover.showPopover();
	await nextFrame(dom);
	expect(popover.matches(":popover-open")).toBe(false);
	expect(seen).toEqual(["beforetoggle"]);

	dom.dispose();
});

test("a show and a hide in one turn report one toggle, of the state it settled on", async () => {
	const {dom, popover} = await open("<div popover>hi</div>");
	const seen: string[] = [];
	popover.addEventListener("toggle", (event: any) => {
		seen.push(`${event.oldState}->${event.newState}`);
	});

	popover.showPopover();
	popover.hidePopover();
	await nextFrame(dom);
	expect(seen).toEqual(["closed->closed"]);
	dom.dispose();
});

/* -------------------------------------------------------------- invokers */

test("a button with popovertarget toggles the popover it names", async () => {
	const {document, dom, popover} = await open(
		"<button popovertarget=pop>Open</button><div id=pop popover>hi</div>",
	);
	const button = document.querySelector("button") as HTMLButtonElement;
	expect(button.popoverTargetElement).toBe(popover);
	expect(button.popoverTargetAction).toBe("toggle");

	button.click();
	expect(popover.matches(":popover-open")).toBe(true);
	button.click();
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("popovertargetaction names which half of the toggle runs", async () => {
	const {document, dom, popover} = await open(
		"<button id=show popovertarget=pop popovertargetaction=show>Show</button>" +
		"<button id=hide popovertarget=pop popovertargetaction=hide>Hide</button>" +
		"<div id=pop popover>hi</div>",
	);
	const show = document.getElementById("show") as HTMLButtonElement;
	const hide = document.getElementById("hide") as HTMLButtonElement;

	hide.click();
	expect(popover.matches(":popover-open")).toBe(false);
	show.click();
	show.click();
	expect(popover.matches(":popover-open")).toBe(true);
	hide.click();
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("an input that is a button invokes; one that is not does nothing", async () => {
	const {document, dom, popover} = await open(
		"<input id=button type=button popovertarget=pop value=Open>" +
		"<input id=text type=text popovertarget=pop>" +
		"<div id=pop popover>hi</div>",
	);
	const text = document.getElementById("text") as HTMLInputElement;
	text.click();
	expect(popover.matches(":popover-open")).toBe(false);

	(document.getElementById("button") as HTMLInputElement).click();
	expect(popover.matches(":popover-open")).toBe(true);
	dom.dispose();
});

test("a submit button is not an invoker, and a disabled one is not either", async () => {
	const {document, dom, popover} = await open(
		"<form><button id=submit popovertarget=pop>Send</button></form>" +
		"<button id=off popovertarget=pop disabled>Open</button>" +
		"<div id=pop popover>hi</div>",
	);
	const submit = document.getElementById("submit") as HTMLButtonElement;
	// The attribute is on it, but its activation is the submission.
	expect(submit.popoverTargetElement).toBe(popover);
	submit.click();
	expect(popover.matches(":popover-open")).toBe(false);

	(document.getElementById("off") as HTMLButtonElement).click();
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("popoverTargetElement takes an element, not only an id", async () => {
	const {document, dom, popover} = await open(
		"<button>Open</button><div popover>hi</div>",
	);
	const button = document.querySelector("button") as HTMLButtonElement;
	expect(button.popoverTargetElement).toBe(null);

	button.popoverTargetElement = popover;
	expect(button.popoverTargetElement).toBe(popover);
	button.click();
	expect(popover.matches(":popover-open")).toBe(true);

	button.popoverTargetElement = null;
	expect(button.hasAttribute("popovertarget")).toBe(false);
	expect(button.popoverTargetElement).toBe(null);
	dom.dispose();
});

/* ---------------------------------------------------------- light dismiss */

test("a click outside an auto popover closes it, and one inside does not", async () => {
	const {terminal, dom, popover} = await open(
		"<p>page one</p><div popover><p>the popover</p></div>",
	);
	popover.showPopover();
	await nextFrame(dom);
	const rect = popover.getBoundingClientRect();

	// Inside the popover: it stays.
	await click(
		terminal,
		Math.round(rect.left + rect.width / 2) + 1,
		Math.round(rect.top) + 2,
	);
	expect(popover.matches(":popover-open")).toBe(true);

	// The corner of the screen is past it, and past it is dismissal.
	await click(terminal, 1, 1);
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("a click on a popover's own invoker toggles rather than reopens", async () => {
	const {terminal, dom, popover} = await open(
		"<button popovertarget=pop>Open</button><div id=pop popover>hi</div>",
	);
	// The button is the first thing on the first row.
	await click(terminal, 3, 1);
	expect(popover.matches(":popover-open")).toBe(true);

	// Light dismiss treats the invoker as part of the popover it opened, so
	// the click that follows closes it once rather than closing and reopening.
	await click(terminal, 3, 1);
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("Escape closes the topmost auto popover", async () => {
	const {terminal, dom, popover} = await open(
		"<p>page</p><div popover>the popover</div>",
	);
	popover.showPopover();
	await nextFrame(dom);

	await press(terminal, "\x1b");
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("a manual popover ignores both the click outside and Escape", async () => {
	const {terminal, dom, popover} = await open(
		"<p>page one</p><div popover=manual><p>the popover</p></div>",
	);
	popover.showPopover();
	await nextFrame(dom);

	await click(terminal, 1, 1);
	expect(popover.matches(":popover-open")).toBe(true);
	await press(terminal, "\x1b");
	expect(popover.matches(":popover-open")).toBe(true);

	popover.hidePopover();
	expect(popover.matches(":popover-open")).toBe(false);
	dom.dispose();
});

/* -------------------------------------------------------------- stacking */

test("showing an auto popover closes the open ones it is unrelated to", async () => {
	const {document, dom} = await open(
		"<div id=one popover>one</div><div id=two popover>two</div>" +
		"<div id=manual popover=manual>manual</div>",
	);
	const one = document.getElementById("one") as HTMLElement;
	const two = document.getElementById("two") as HTMLElement;
	const manual = document.getElementById("manual") as HTMLElement;

	manual.showPopover();
	one.showPopover();
	two.showPopover();
	expect(one.matches(":popover-open")).toBe(false);
	expect(two.matches(":popover-open")).toBe(true);
	// A manual popover is in nobody's stack: an auto one opening leaves it.
	expect(manual.matches(":popover-open")).toBe(true);
	dom.dispose();
});

test("a nested popover joins the stack rather than closing it", async () => {
	const {document, dom} = await open(
		"<div id=outer popover>outer<div id=inner popover>inner</div></div>" +
		"<div id=other popover>other</div>",
	);
	const outer = document.getElementById("outer") as HTMLElement;
	const inner = document.getElementById("inner") as HTMLElement;
	const other = document.getElementById("other") as HTMLElement;

	outer.showPopover();
	inner.showPopover();
	expect(outer.matches(":popover-open")).toBe(true);
	expect(inner.matches(":popover-open")).toBe(true);

	// Closing the one underneath closes what is stacked on it.
	inner.showPopover();
	outer.hidePopover();
	expect(inner.matches(":popover-open")).toBe(false);

	// And an unrelated popover closes the whole stack.
	outer.showPopover();
	inner.showPopover();
	other.showPopover();
	expect(outer.matches(":popover-open")).toBe(false);
	expect(inner.matches(":popover-open")).toBe(false);
	dom.dispose();
});

test("a popover invoked from inside another is the inner one of a stack", async () => {
	const {document, dom} = await open(
		"<div id=outer popover>" +
		"<button popovertarget=inner>More</button></div>" +
		"<div id=inner popover>inner</div>",
	);
	const outer = document.getElementById("outer") as HTMLElement;
	const inner = document.getElementById("inner") as HTMLElement;

	outer.showPopover();
	(document.querySelector("button") as HTMLButtonElement).click();
	// The invoker's popover is the parent, so the outer one survives its
	// child opening -- the node trees are siblings, the invocation is not.
	expect(outer.matches(":popover-open")).toBe(true);
	expect(inner.matches(":popover-open")).toBe(true);
	dom.dispose();
});

/* ----------------------------------------------------------------- focus */

test("focus moves into a popover only where the content asks for it", async () => {
	const {document, dom} = await open(
		"<button id=page>page</button>" +
		"<div id=plain popover><button id=first>first</button></div>" +
		"<div id=asking popover><button id=second autofocus>second</button></div>",
	);
	const plain = document.getElementById("plain") as HTMLElement;
	const asking = document.getElementById("asking") as HTMLElement;
	(document.getElementById("page") as HTMLElement).focus();

	// Unlike a dialog, a popover does not take focus off the page by opening.
	plain.showPopover();
	await nextFrame(dom);
	expect(document.activeElement?.id).toBe("page");
	plain.hidePopover();

	asking.showPopover();
	await nextFrame(dom);
	expect(document.activeElement?.id).toBe("second");

	// Closing gives focus back to what had it when the stack opened.
	asking.hidePopover();
	expect(document.activeElement?.id).toBe("page");
	dom.dispose();
});
