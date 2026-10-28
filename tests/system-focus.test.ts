/**
 * The terminal's own focus, as mode 1004 reports it: ESC [ I when the
 * terminal or the tmux pane gains focus and ESC [ O when it loses it.
 * The page sees it as a browser's page sees its tab left and returned to.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {transportFromProcess} from "../src/internal/exchange.ts";
import {canCreateRealms} from "../src/internal/realms.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

async function send(terminal: MockProcess, data: string): Promise<void> {
	terminal.stdin.simulateResponse(data);
	await new Promise((resolve) => setTimeout(resolve, 20));
}

test("attaching asks for focus reports, and disposing stops them", async () => {
	const terminal = new MockProcess();
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	expect(written()).toContain("\x1b[?1004h");
	await dom.dispose();
	expect(written()).toContain("\x1b[?1004l");
});

test("losing and regaining focus blurs and refocuses the page, as leaving a tab does", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document, window} = dom;
	document.body.innerHTML = "<input id=field>";
	await dom.attach();
	const field = document.getElementById("field")!;
	field.focus();
	const heard: string[] = [];
	for (const type of ["blur", "focus", "focusin", "focusout"]) {
		field.addEventListener(type, () => heard.push(`field ${type}`));
		window.addEventListener(type, (event) => {
			if (event.target === window) {
				heard.push(`window ${type}`);
			}
		});
	}
	expect(document.hasFocus()).toBe(true);

	await send(terminal, "\x1b[O");
	expect(heard).toEqual(["field blur", "field focusout", "window blur"]);
	expect(document.hasFocus()).toBe(false);
	expect(document.activeElement).toBe(field);

	heard.length = 0;
	await send(terminal, "\x1b[O");
	expect(heard).toEqual([]);

	await send(terminal, "\x1b[I");
	expect(heard).toEqual(["window focus", "field focus", "field focusin"]);
	expect(document.hasFocus()).toBe(true);
	await dom.dispose();
});

test(":focus matches nothing while the terminal is away, and returns with it", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document, window} = dom;
	document.head.innerHTML = "<style>input:focus { color: red }</style>";
	document.body.innerHTML = "<form><input id=field></form>";
	await dom.attach();
	const field = document.getElementById("field")!;
	const form = document.querySelector("form")!;
	field.focus();
	await nextFrame(dom);
	expect(field.matches(":focus")).toBe(true);
	expect(window.getComputedStyle(field).color).toBe("rgb(255, 0, 0)");

	await send(terminal, "\x1b[O");
	expect(field.matches(":focus")).toBe(false);
	expect(form.matches(":focus-within")).toBe(false);
	expect(window.getComputedStyle(field).color).not.toBe("rgb(255, 0, 0)");

	await send(terminal, "\x1b[I");
	expect(field.matches(":focus")).toBe(true);
	expect(form.matches(":focus-within")).toBe(true);
	expect(window.getComputedStyle(field).color).toBe("rgb(255, 0, 0)");
	await dom.dispose();
});

test("regaining focus takes the mouse back from the terminal's scrollback", async () => {
	const terminal = new MockProcess();
	captureRawOutput(terminal);
	for (let i = 0; i < 4; i++) {
		terminal.stdout.write(`prior ${i}\r\n`);
	}
	const dom = new TermDOM({
		transport: transportFromProcess(terminal as any, {sharesScreen: true}),
	});
	dom.document.body.innerHTML = "<p>page</p>";
	await dom.attach();
	await nextFrame(dom);
	await send(terminal, "\x1b[<64;5;2M");
	await nextFrame(dom);
	expect(dom.document.visibilityState).toBe("hidden");
	await send(terminal, "\x1b[O\x1b[I");
	await nextFrame(dom);
	expect(dom.document.visibilityState).toBe("visible");
	await dom.dispose();
});

test("the scrollback taking the mouse blurs the page, and a keystroke focuses it first", async () => {
	const terminal = new MockProcess();
	captureRawOutput(terminal);
	for (let i = 0; i < 4; i++) {
		terminal.stdout.write(`prior ${i}\r\n`);
	}
	const dom = new TermDOM({
		transport: transportFromProcess(terminal as any, {sharesScreen: true}),
	});
	const {document, window} = dom;
	document.body.innerHTML = "<input id=field>";
	await dom.attach();
	const field = document.getElementById("field") as HTMLInputElement;
	field.focus();
	await nextFrame(dom);
	const heard: string[] = [];
	window.addEventListener("blur", () => heard.push("window blur"));
	window.addEventListener("focus", () => heard.push("window focus"));
	field.addEventListener("keydown", () =>
		heard.push(`keydown, focused ${field.matches(":focus")}`),
	);

	await send(terminal, "\x1b[<64;5;2M");
	expect(heard).toEqual(["window blur"]);
	expect(document.hasFocus()).toBe(false);
	expect(field.matches(":focus")).toBe(false);

	await send(terminal, "a");
	expect(heard).toEqual([
		"window blur",
		"window focus",
		"keydown, focused true",
	]);
	expect(document.hasFocus()).toBe(true);
	await dom.dispose();
});

test("a paste takes the mouse back too, though the terminal's own replies do not", async () => {
	const terminal = new MockProcess();
	captureRawOutput(terminal);
	for (let i = 0; i < 4; i++) {
		terminal.stdout.write(`prior ${i}\r\n`);
	}
	const dom = new TermDOM({
		transport: transportFromProcess(terminal as any, {sharesScreen: true}),
	});
	dom.document.body.innerHTML = "<textarea></textarea>";
	await dom.attach();
	await nextFrame(dom);
	await send(terminal, "\x1b[<64;5;2M");
	expect(dom.document.visibilityState).toBe("hidden");
	await send(terminal, "\x1b[3;7R\x1b[?1;2c");
	expect(dom.document.visibilityState).toBe("hidden");
	await send(terminal, "\x1b[200~pasted\x1b[201~");
	expect(dom.document.visibilityState).toBe("visible");
	expect(dom.document.hasFocus()).toBe(true);
	await dom.dispose();
});

test("the mouse moving over a terminal that lost focus leaves the page blurred", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<input id=field>";
	await dom.attach();
	await nextFrame(dom);
	const field = document.getElementById("field")!;
	field.focus();
	let moves = 0;
	document.addEventListener("mousemove", () => moves++);
	await send(terminal, "\x1b[O");
	await send(terminal, "\x1b[<35;3;1M\x1b[<35;4;1M");
	await nextFrame(dom);
	expect(moves).toBeGreaterThan(0);
	expect(document.hasFocus()).toBe(false);
	expect(field.matches(":focus")).toBe(false);
	await dom.dispose();
});

const withRealms = canCreateRealms() ? test : test.skip;

withRealms(
	"the terminal's focus reaches a field focused inside a frame",
	async () => {
		const terminal = new MockProcess();
		const dom = new TermDOM({transport: terminal.transport});
		const {document, window} = dom;
		document.body.innerHTML =
			"<iframe srcdoc=\"<input id=field>\" style=\"display: block; width: 20ch; height: 3px\"></iframe>";
		await dom.attach();
		await nextFrame(dom);
		await nextFrame(dom);
		const frame = document.querySelector("iframe")!;
		const inner = frame.contentDocument!;
		const field = inner.getElementById("field") as HTMLInputElement;
		field.focus();
		const heard: string[] = [];
		for (const type of ["blur", "focus"]) {
			field.addEventListener(type, () => heard.push(`field ${type}`));
			frame.addEventListener(type, () => heard.push(`iframe ${type}`));
			frame.contentWindow!.addEventListener(type, (event) => {
				if (event.target === frame.contentWindow) {
					heard.push(`frame window ${type}`);
				}
			});
			window.addEventListener(type, (event) => {
				if (event.target === window) {
					heard.push(`window ${type}`);
				}
			});
		}
		expect(field.matches(":focus")).toBe(true);

		await send(terminal, "\x1b[O");
		expect(heard).toEqual([
			"field blur",
			"frame window blur",
			"iframe blur",
			"window blur",
		]);
		expect(inner.hasFocus()).toBe(false);
		expect(field.matches(":focus")).toBe(false);

		heard.length = 0;
		await send(terminal, "\x1b[I");
		expect(heard).toEqual([
			"window focus",
			"iframe focus",
			"frame window focus",
			"field focus",
		]);
		expect(inner.hasFocus()).toBe(true);
		expect(field.matches(":focus")).toBe(true);
		await dom.dispose();
	},
);

withRealms(
	"a frame repaints its :focus styles and fires its own FocusEvents when the terminal leaves",
	async () => {
		const terminal = new MockProcess({cols: 30, rows: 6});
		const dom = new TermDOM({transport: terminal.transport});
		const {document} = dom;
		document.body.innerHTML =
			"<iframe srcdoc=\"<style>body:focus-within p::after { content: ' focused' }</style><input id=field><p>field</p>\" style=\"display: block; width: 25ch; height: 4px\"></iframe>";
		await dom.attach();
		await nextFrame(dom);
		await nextFrame(dom);
		const frame = document.querySelector("iframe")!;
		const field = frame.contentDocument!.getElementById("field")!;
		field.focus();
		await nextFrame(dom);
		await nextFrame(dom);
		const screen = () => {
			const buffer = (terminal as any).terminal.buffer.active;
			return Array.from(
				{length: 6},
				(_, row) => buffer.getLine(row).translateToString(true).trimEnd(),
			).join("\n");
		};
		expect(screen()).toContain("field focused");
		const events: Event[] = [];
		field.addEventListener("blur", (event) => events.push(event));

		await send(terminal, "\x1b[O");
		await nextFrame(dom);
		await nextFrame(dom);
		expect(screen()).not.toContain("field focused");
		expect(screen()).toContain("field");
		expect(events.length).toBe(1);
		expect(events[0] instanceof (frame.contentWindow as any).FocusEvent).toBe(
			true,
		);

		await send(terminal, "\x1b[I");
		await nextFrame(dom);
		await nextFrame(dom);
		expect(screen()).toContain("field focused");
		await dom.dispose();
	},
);

test("a focused field shows no cursor while the terminal is away", async () => {
	const terminal = new MockProcess();
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<input id=field>";
	await dom.attach();
	document.getElementById("field")!.focus();
	await nextFrame(dom);
	const showing = () => {
		const output = written();
		return output.lastIndexOf("\x1b[?25h") > output.lastIndexOf("\x1b[?25l");
	};
	expect(showing()).toBe(true);

	await send(terminal, "\x1b[O");
	await nextFrame(dom);
	expect(showing()).toBe(false);

	await send(terminal, "\x1b[I");
	await nextFrame(dom);
	expect(showing()).toBe(true);
	await dom.dispose();
});
