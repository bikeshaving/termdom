/**
 * The modal dialog: the top layer as an author reaches it. Showing one
 * modally lifts it out of the flow it was written in and over everything the
 * document paints, dims the page behind it into its ::backdrop, takes the
 * clicks and the keys the page would have had, and gives all of it back on
 * close.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

async function open(html: string, cols = 30, rows = 8): Promise<
	{terminal: MockProcess; dom: TermDOM; dialog: HTMLDialogElement}
> {
	const terminal = new MockProcess({rows, cols});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const dialog = dom.document.querySelector("dialog") as HTMLDialogElement;
	return {terminal, dom, dialog};
}

function press(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	// Input rides the transport's readable: delivery is a microtask away.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------- rendering */

test("a modal dialog paints over the page, centered in the viewport", async () => {
	const {terminal, dom, dialog} = await open(
		"<p>page one</p><p>page two</p><p>page three</p>" +
		"<dialog><p>Save?</p></dialog>",
	);
	dialog.showModal();
	await nextFrame(dom);

	const output = terminal.getPlainText();
	// The dialog's box is the only thing on screen, and it sits in the middle
	// of the viewport rather than where it was written.
	expect(output).not.toContain("page one");
	expect(output).toContain("Save?");
	// Centered to the cell: the gaps on either side differ by at most the one
	// cell an odd remainder cannot split.
	const rect = dialog.getBoundingClientRect();
	expect(Math.abs(rect.left - (30 - rect.right))).toBeLessThanOrEqual(1);
	expect(Math.abs(rect.top - (8 - rect.bottom))).toBeLessThanOrEqual(1);
	dom.dispose();
});

test("the backdrop covers the viewport, and an author's rules restyle it", async () => {
	const {terminal, dom, dialog} = await open(
		"<style>dialog::backdrop { background-color: transparent; }</style>" +
		"<p>page one</p><p>page two</p><dialog><p>Save?</p></dialog>",
	);
	dialog.showModal();
	await nextFrame(dom);

	// A transparent backdrop paints nothing, so the page it would have
	// cleared is still there under the dialog.
	const output = terminal.getPlainText();
	expect(output).toContain("page one");
	expect(output).toContain("Save?");
	dom.dispose();
});

test("show() leaves the dialog in the flow, with no backdrop", async () => {
	const {terminal, dom, dialog} = await open(
		"<p>page one</p><dialog><p>Save?</p></dialog>",
	);
	dialog.show();
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("page one");
	expect(output).toContain("Save?");
	expect(dialog.matches(":modal")).toBe(false);
	// In flow means below the paragraph it follows, not centered over it.
	expect(dialog.getBoundingClientRect().top).toBeGreaterThan(0);
	dom.dispose();
});

test("closing gives the page back", async () => {
	const {terminal, dom, dialog} = await open(
		"<p>page one</p><dialog><p>Save?</p></dialog>",
	);
	dialog.showModal();
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("page one");

	dialog.close("ok");
	await nextFrame(dom);
	const output = terminal.getPlainText();
	expect(output).toContain("page one");
	expect(output).not.toContain("Save?");
	expect(dialog.returnValue).toBe("ok");
	expect(dialog.open).toBe(false);
	dom.dispose();
});

/* ----------------------------------------------------------------- state */

test(":modal matches a dialog shown modally, and only while it is showing", async () => {
	const {dom, dialog} = await open("<dialog><p>Save?</p></dialog>");
	expect(dialog.matches(":modal")).toBe(false);

	dialog.showModal();
	expect(dialog.matches(":modal")).toBe(true);
	expect(dom.document.querySelectorAll("dialog:modal").length).toBe(1);

	dialog.close();
	expect(dialog.matches(":modal")).toBe(false);
	expect(dom.document.querySelectorAll(":modal").length).toBe(0);
	dom.dispose();
});

test("showModal refuses a dialog that is already showing, or is not connected", async () => {
	const {dom, dialog} = await open("<dialog><p>Save?</p></dialog>");
	dialog.show();
	expect(() => dialog.showModal()).toThrow(/already showing/);
	dialog.close();

	dialog.showModal();
	expect(() => dialog.showModal()).toThrow(/already showing/);
	// And a modal one refuses to be shown non-modally on top of itself.
	expect(() => dialog.show()).toThrow(/already showing modally/);
	dialog.close();

	const detached = dom.document.createElement("dialog") as HTMLDialogElement;
	expect(() => detached.showModal()).toThrow(/connected/);
	expect(detached.open).toBe(false);
	dom.dispose();
});

test("taking a modal dialog out of the document takes it out of the top layer", async () => {
	const {dom, dialog} = await open("<dialog><p>Save?</p></dialog>");
	dialog.showModal();
	dialog.remove();
	expect(dialog.matches(":modal")).toBe(false);
	dom.dispose();
});

/* ------------------------------------------------------------ modality */

test("a click outside a modal dialog lands on the dialog, not the page", async () => {
	const {dom, dialog} = await open(
		"<p id=\"page\">page one</p><dialog><p id=\"inside\">Save?</p></dialog>",
	);
	const {document} = dom;
	expect(document.elementFromPoint(0, 0)?.id).toBe("page");

	dialog.showModal();
	await nextFrame(dom);
	// The corner of the screen is the backdrop, whose hits are the dialog's.
	expect(document.elementFromPoint(0, 0)).toBe(dialog);
	// Inside it, the ordinary hit-test answers.
	const rect = dialog.getBoundingClientRect();
	expect(
		document.elementFromPoint(
			Math.round(rect.left + rect.width / 2),
			Math.round(rect.top + 1),
		)?.id,
	).toBe("inside");
	dom.dispose();
});

test("focus enters the dialog and Tab cannot leave it", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<button id=\"page\">page</button>" +
		"<dialog><button id=\"ok\">OK</button><button id=\"cancel\">Cancel</button></dialog>";
	dom.attach();
	await nextFrame(dom);
	const {document} = dom;
	const dialog = document.querySelector("dialog") as HTMLDialogElement;
	(document.getElementById("page") as HTMLElement).focus();

	dialog.showModal();
	await nextFrame(dom);
	// The dialog focusing steps put focus on the first control inside it.
	expect(document.activeElement?.id).toBe("ok");

	await press(terminal, "\t");
	expect(document.activeElement?.id).toBe("cancel");
	// Tab past the dialog's last control rests on nothing -- the blurred
	// stop -- and re-enters at its first control, never the page behind it.
	await press(terminal, "\t");
	expect(document.activeElement).toBe(document.body);
	await press(terminal, "\t");
	expect(document.activeElement?.id).toBe("ok");

	dialog.close();
	// Closing hands focus back to whatever had it when the dialog took it.
	expect(document.activeElement?.id).toBe("page");
	dom.dispose();
});

test("autofocus wins the dialog focusing steps", async () => {
	const {dom, dialog} = await open(
		"<dialog><button id=\"ok\">OK</button><button id=\"cancel\" autofocus>Cancel</button></dialog>",
	);
	dialog.showModal();
	expect(dom.document.activeElement?.id).toBe("cancel");
	dom.dispose();
});

test("a dialog with nothing focusable takes focus itself", async () => {
	const {dom, dialog} = await open("<dialog><p>Saving...</p></dialog>");
	dialog.showModal();
	expect(dom.document.activeElement).toBe(dialog);
	dom.dispose();
});

/* ----------------------------------------------------------------- keys */

test("Escape fires cancel and closes the topmost modal dialog", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<p>page</p><dialog><p>Save?</p></dialog>";
	dom.attach();
	await nextFrame(dom);
	const dialog = dom.document.querySelector("dialog") as HTMLDialogElement;
	const seen: string[] = [];
	dialog.addEventListener("cancel", () => seen.push("cancel"));
	dialog.addEventListener("close", () => seen.push("close"));

	dialog.showModal();
	await nextFrame(dom);
	await press(terminal, "\x1b");

	expect(seen).toEqual(["cancel", "close"]);
	expect(dialog.open).toBe(false);
	dom.dispose();
});

test("a canceled cancel event keeps the dialog open", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<p>page</p><dialog><p>Save?</p></dialog>";
	dom.attach();
	await nextFrame(dom);
	const dialog = dom.document.querySelector("dialog") as HTMLDialogElement;
	dialog.addEventListener("cancel", (event: Event) => event.preventDefault());

	dialog.showModal();
	await nextFrame(dom);
	await press(terminal, "\x1b");

	expect(dialog.open).toBe(true);
	expect(dialog.matches(":modal")).toBe(true);
	dom.dispose();
});

test("Escape reaches no dialog while nothing is showing modally", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<p>page</p><dialog open><p>Save?</p></dialog>";
	dom.attach();
	await nextFrame(dom);
	const dialog = dom.document.querySelector("dialog") as HTMLDialogElement;

	await press(terminal, "\x1b");
	// A non-modal dialog is not a close request's target: it stays open.
	expect(dialog.open).toBe(true);
	dom.dispose();
});
