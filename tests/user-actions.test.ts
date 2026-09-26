/**
 * What a user's own actions change: an edit committed as focus leaves, the
 * validity a user interaction reveals, a form that will not submit invalid,
 * the element a held mouse button makes :active, and where Tab goes after
 * the focused element is removed.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function mounted(
	html: string,
): Promise<{dom: TermDOM; proc: MockProcess; document: Document}> {
	const proc = new MockProcess();
	const dom = new TermDOM({transport: proc.transport, html});
	dom.attach();
	await nextFrame(dom);
	return {dom, proc, document: dom.document};
}

async function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as any).emit("data", Buffer.from(data));
	await new Promise((resolve) => setTimeout(resolve, 30));
}

test("a control in the starting markup takes typing", async () => {
	const {dom, proc, document} = await mounted("<input>");
	const input = document.querySelector("input")!;
	input.focus();
	await send(proc, "typed");
	expect(input.value).toBe("typed");
	dom.dispose();
});

test("leaving an edited field fires change before blur, and only then", async () => {
	const {dom, proc, document} =
		await mounted("<input type=email><button>next</button>");
	const input = document.querySelector("input")!;
	const heard: string[] = [];
	for (const type of ["change", "blur"]) {
		input.addEventListener(type, () => heard.push(type));
	}
	input.focus();
	await send(proc, "user");
	expect(input.matches(":user-invalid")).toBe(false);
	document.querySelector("button")!.focus();
	expect(heard).toEqual(["change", "blur"]);
	expect(input.matches(":user-invalid")).toBe(true);
	// A value script sets is not the user's edit.
	input.focus();
	input.value = "a@b.c";
	input.blur();
	expect(heard.filter((type) => type === "change").length).toBe(1);
	expect(input.matches(":user-valid")).toBe(true);
	dom.dispose();
});

test("an invalid form does not submit, and its first invalid field takes focus", async () => {
	const {dom, document} =
		await mounted("<form><input id=name required><button>go</button></form>");
	const form = document.querySelector("form")!;
	let submitted = 0;
	let invalid = 0;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		submitted++;
	});
	form.addEventListener("invalid", () => invalid++, true);
	form.requestSubmit();
	expect([submitted, invalid]).toEqual([0, 1]);
	expect(document.activeElement!.id).toBe("name");
	expect(document.getElementById("name")!.matches(":user-invalid")).toBe(true);
	form.reset();
	expect(document.getElementById("name")!.matches(":user-invalid")).toBe(false);
	form.noValidate = true;
	form.requestSubmit();
	expect(submitted).toBe(1);
	dom.dispose();
});

test(":active holds from a mouse press to its release", async () => {
	const {dom, proc, document} = await mounted("<p id=target>press</p>");
	const target = document.getElementById("target")!;
	await send(proc, "\x1b[<0;2;1M");
	expect(target.matches(":active")).toBe(true);
	expect(document.body.matches(":active")).toBe(true);
	await send(proc, "\x1b[<0;2;1m");
	expect(target.matches(":active")).toBe(false);
	dom.dispose();
});

test("Tab carries on from where a removed focused element was", async () => {
	const {dom, proc, document} = await mounted(
		"<div id=a tabindex=1>a</div><div><div id=c tabindex=3>c</div></div>" +
		"<div id=d tabindex=4>d</div>",
	);
	(document.getElementById("c") as HTMLElement).focus();
	document.getElementById("c")!.remove();
	await send(proc, "\t");
	expect(document.activeElement!.id).toBe("d");
	dom.dispose();
});

test("showPicker opens a select's picker only after a user action", async () => {
	const {dom, proc, document} =
		await mounted("<select><option>a</option></select><button>b</button>");
	const select = document.querySelector("select")!;
	expect(() => select.showPicker()).toThrow(/user action/);
	document.querySelector("button")!.addEventListener("click", () => {});
	await send(proc, "\x1b[<0;1;2M\x1b[<0;1;2m");
	select.showPicker();
	expect(select.matches(":open")).toBe(true);
	dom.dispose();
});

test("removing open from a modal dialog ends its modality", async () => {
	const {dom, document} = await mounted("<dialog>d</dialog>");
	const dialog = document.querySelector("dialog")!;
	dialog.showModal();
	dialog.open = false;
	expect(dialog.matches(":modal")).toBe(false);
	dom.dispose();
});
