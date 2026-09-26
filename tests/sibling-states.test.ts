/**
 * A rule like `:focus ~ span` or `:hover + span` styles siblings after the
 * element whose state changed, so a focus or hover move restyles them.
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
