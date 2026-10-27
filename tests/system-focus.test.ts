/**
 * The terminal's own focus, as mode 1004 reports it: ESC [ I when the
 * terminal or the tmux pane gains focus and ESC [ O when it loses it.
 * The page sees it as a browser's page sees its tab left and returned to.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {transportFromProcess} from "../src/internal/exchange.ts";
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
