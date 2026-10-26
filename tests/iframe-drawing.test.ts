/**
 * Drawing frames.
 *
 * An iframe's document is laid out and painted in the iframe's content box,
 * as a browser draws a frame: its own styles, its own viewport for @media
 * and resize, and its cells drawn again when it changes. A click lands on
 * what is under it inside the frame, focus runs up through the frames, and
 * keys go to what is focused inside the focused frame. A frame is drawn
 * where it has a realm of its own, which node:vm gives.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {canCreateRealms} from "../src/internal/realms.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

const withRealms = canCreateRealms() ? test : test.skip;

function rows(terminal: MockProcess, count: number): string[] {
	const buffer = (terminal as any).terminal.buffer.active;
	return Array.from(
		{length: count},
		(_, row) => buffer.getLine(row).translateToString(true).trimEnd(),
	);
}

async function settle(dom: TermDOM): Promise<void> {
	await nextFrame(dom);
	await nextFrame(dom);
}

withRealms("a frame's document is drawn in the iframe's box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<p>before</p>" +
		"<iframe srcdoc=\"<p>inside</p>\" style=\"display: block; border: 1px solid; width: 20ch; height: 4px\"></iframe>" +
		"<p>after</p>";
	await settle(dom);
	expect(rows(terminal, 6)).toEqual([
		"before",
		"┌──────────────────┐",
		"│inside            │",
		"│                  │",
		"└──────────────────┘",
		"after",
	]);
	dom.dispose();
});

withRealms("a frame is 300 by 150 CSS pixels unless styled", async () => {
	const dom = new TermDOM({transport: new MockProcess({cols: 60}).transport});
	dom.document.body.innerHTML = "<iframe></iframe>";
	await settle(dom);
	// Under the 8 by 16 pixel cell an image is sized by.
	const rect = dom.document.querySelector("iframe")!.getBoundingClientRect();
	expect([rect.width, rect.height]).toEqual([38, 9]);
	dom.dispose();
});

withRealms("a change in the frame is drawn with the next frame", async () => {
	const terminal = new MockProcess({cols: 30, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<iframe srcdoc=\"<p id=t>first</p>\" style=\"display: block; border: 0; width: 20ch; height: 2px\"></iframe>";
	await settle(dom);
	expect(rows(terminal, 1)).toEqual(["first"]);
	const frame = dom.document.querySelector("iframe")!;
	frame.contentDocument!.getElementById("t")!.textContent = "second";
	await settle(dom);
	expect(rows(terminal, 1)).toEqual(["second"]);
	dom.dispose();
});

withRealms("a frame's viewport is its box, for @media and resize", async () => {
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<iframe srcdoc=\"<style>p::after { content: ' wide' } @media (max-width: 15px) { p::after { content: ' narrow' } }</style><p>is</p>\" style=\"display: block; border: 0; width: 20ch; height: 2px\"></iframe>";
	await settle(dom);
	const frame = dom.document.querySelector("iframe")!;
	expect(rows(terminal, 1)).toEqual(["is wide"]);
	const window = frame.contentWindow as any;
	expect(window.innerWidth).toBe(20);
	let resized = 0;
	window.addEventListener("resize", () => {
		resized++;
	});
	frame.style.width = "12ch";
	await settle(dom);
	expect(rows(terminal, 1)).toEqual(["is narrow"]);
	expect(resized).toBe(1);
	dom.dispose();
});

withRealms("a frame in a frame is drawn in its own box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<iframe style=\"display: block; border: 1px solid; width: 20ch; height: 5px\"></iframe>";
	await settle(dom);
	const outer = dom.document.querySelector("iframe")!;
	const inner = outer.contentDocument!.createElement("iframe");
	inner.setAttribute("srcdoc", "deep");
	inner.setAttribute(
		"style",
		"display: block; border: 1px solid; width: 8ch; height: 3px",
	);
	outer.contentDocument!.body.append(inner);
	await settle(dom);
	expect(rows(terminal, 5)).toEqual([
		"┌──────────────────┐",
		"│┌──────┐          │",
		"││deep  │          │",
		"│└──────┘          │",
		"└──────────────────┘",
	]);
	outer.remove();
	await settle(dom);
	expect(rows(terminal, 5).every((row) => row === "")).toBe(true);
	dom.dispose();
});

withRealms(
	"a click lands inside the frame, focuses through it, and keys follow",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<iframe srcdoc=\"<p>row</p><input id=field>\" style=\"display: block; border: 1px solid; width: 30ch; height: 5px\"></iframe>";
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		const window = frame.contentWindow as any;
		const field =
			frame.contentDocument!.getElementById("field") as HTMLInputElement;
		const seen: any[] = [];
		field.addEventListener("mousedown", (event) => {
			seen.push([
				event.clientX,
				event.clientY,
				event instanceof window.MouseEvent,
			]);
		});
		let parentSaw = false;
		dom.document.addEventListener("mousedown", () => {
			parentSaw = true;
		});
		// The field is the frame's second row, inside the iframe's border:
		// terminal column 2 and row 3, counted from 1.
		terminal.stdin.simulateResponse("\x1b[<0;2;3M\x1b[<0;2;3m");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await settle(dom);
		expect(seen).toEqual([[0, 1, true]]);
		expect(parentSaw).toBe(false);
		expect(dom.document.activeElement).toBe(frame);
		expect(frame.contentDocument!.activeElement).toBe(field);
		terminal.stdin.simulateResponse("hi");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await settle(dom);
		expect(field.value).toBe("hi");
		dom.dispose();
	},
);
