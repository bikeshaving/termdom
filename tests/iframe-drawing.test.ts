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

withRealms(
	"the cursor is on the caret of the field focused in a focused frame",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<p>above</p><iframe srcdoc=\"<p>x</p><input id=field>\" style=\"display: block; border: 1px solid; width: 30ch; height: 5px\"></iframe>";
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		(frame.contentDocument!.getElementById(
			"field",
		) as HTMLInputElement).focus();
		await settle(dom);
		const buffer = (terminal as any).terminal.buffer.active;
		// Inside the border, on the field's row: the frame's second row.
		expect([buffer.cursorX, buffer.cursorY]).toEqual([1, 3]);
		dom.dispose();
	},
);

withRealms(
	"the wheel scrolls a frame, and the document it is in past the frame's end",
	async () => {
		const terminal = new MockProcess({cols: 30, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		const lines = Array.from({length: 10}, (_, i) => `<div>line ${i}</div>`)
			.join("");
		dom.document.body.innerHTML =
			`<iframe srcdoc="${lines}" style="display: block; border: 0; width: 20ch; height: 3px"></iframe>` +
			Array.from({length: 12}, (_, i) => `<div>page ${i}</div>`).join("");
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!.contentWindow as any;
		const wheel = async () => {
			terminal.stdin.simulateResponse("\x1b[<65;2;2M");
			await new Promise((resolve) => setTimeout(resolve, 20));
			await settle(dom);
		};
		await wheel();
		expect([frame.scrollY, dom.window.scrollY]).toEqual([3, 0]);
		expect(rows(terminal, 1)).toEqual(["line 3"]);
		for (let i = 0; i < 3; i++) {
			await wheel();
		}
		expect(frame.scrollY).toBe(7);
		expect(dom.window.scrollY).toBeGreaterThan(0);
		frame.scrollTo(0, 2);
		dom.window.scrollTo(0, 0);
		await settle(dom);
		expect(rows(terminal, 1)).toEqual(["line 2"]);
		dom.dispose();
	},
);

withRealms(
	"hover reaches into a frame, for :hover and the mouse events",
	async () => {
		const terminal = new MockProcess({cols: 30, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<p id=outside>outside</p><iframe srcdoc=\"<style>a:hover::after { content: ' on' }</style><a id=link href=#>link</a>\" style=\"display: block; border: 0; width: 20ch; height: 3px\"></iframe>";
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		const link = frame.contentDocument!.getElementById("link")!;
		const seen: string[] = [];
		link.addEventListener("mouseover", (event) => {
			seen.push(`over ${event.clientX},${event.clientY}`);
		});
		link.addEventListener("mouseleave", () => {
			seen.push("leave");
		});
		const move = async (col: number, row: number) => {
			terminal.stdin.simulateResponse(`\x1b[<35;${col};${row}M`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await settle(dom);
		};
		await move(2, 2);
		expect([link.matches(":hover"), frame.matches(":hover")]).toEqual([
			true,
			true,
		]);
		expect(rows(terminal, 2)[1]).toBe("link on");
		await move(2, 1);
		expect([link.matches(":hover"), frame.matches(":hover")]).toEqual([
			false,
			false,
		]);
		expect(rows(terminal, 2)[1]).toBe("link");
		expect(seen).toEqual(["over 1,0", "leave"]);
		dom.dispose();
	},
);

withRealms(
	"Tab goes through a frame's stops in place of the iframe",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 10});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<input id=a><iframe srcdoc=\"<input id=b><input id=c>\" style=\"display: block; width: 30ch; height: 3px\"></iframe><input id=d>";
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		const where = (): string =>
			dom.document.activeElement === frame
				? (frame.contentDocument!.activeElement as HTMLElement).id
				: (dom.document.activeElement as HTMLElement).id;
		const key = async (sequence: string) => {
			terminal.stdin.simulateResponse(sequence);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await nextFrame(dom);
		};
		(dom.document.getElementById("a") as HTMLInputElement).focus();
		const forward = [where()];
		for (let i = 0; i < 3; i++) {
			await key("\t");
			forward.push(where());
		}
		const backward = [where()];
		for (let i = 0; i < 3; i++) {
			await key("\x1b[Z");
			backward.push(where());
		}
		expect(forward).toEqual(["a", "b", "c", "d"]);
		expect(backward).toEqual(["d", "c", "b", "a"]);
		dom.dispose();
	},
);

withRealms(
	"a drag selects in the frame, and a press places a frame field's caret",
	async () => {
		const terminal = new MockProcess({cols: 40, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<p>top text</p><iframe srcdoc=\"<p>hello world here</p><input id=field value=abcdef>\" style=\"display: block; border: 0; width: 30ch; height: 4px\"></iframe>";
		await dom.attach();
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		const send = async (sequence: string) => {
			terminal.stdin.simulateResponse(sequence);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await settle(dom);
		};
		// The frame's first row is the terminal's second.
		await send("\x1b[<0;7;2M");
		await send("\x1b[<32;12;2M");
		await send("\x1b[<0;12;2m");
		expect((frame.contentWindow as any).getSelection().toString()).toBe(
			"world",
		);
		expect(dom.window.getSelection()!.toString()).toBe("");
		await send("\x1b[<0;4;3M\x1b[<0;4;3m");
		const field =
			frame.contentDocument!.getElementById("field") as HTMLInputElement;
		expect(frame.contentDocument!.activeElement).toBe(field);
		expect(field.selectionStart).toBe(3);
		dom.dispose();
	},
);

withRealms("a static render draws frames too", () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 6}).transport,
	});
	dom.document.body.innerHTML =
		"<iframe srcdoc=\"<b>static</b>\" style=\"display: block; border: 1px solid; width: 12ch; height: 3px\"></iframe>";
	const text = dom.renderANSI().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	expect(text).toContain("│static    │");
	dom.dispose();
});

withRealms(
	"a new srcdoc navigates the frame to a new document, which fires load",
	async () => {
		const terminal = new MockProcess({cols: 30, rows: 4});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML =
			"<iframe srcdoc=\"<p>first</p>\" style=\"display: block; border: 0; width: 20ch; height: 2px\"></iframe>";
		await settle(dom);
		const frame = dom.document.querySelector("iframe")!;
		const first = frame.contentWindow;
		let loads = 0;
		frame.addEventListener("load", () => {
			loads++;
		});
		frame.srcdoc = "<p>second</p>";
		await new Promise((resolve) => setTimeout(resolve, 20));
		await settle(dom);
		expect(rows(terminal, 1)).toEqual(["second"]);
		expect(frame.contentWindow).not.toBe(first);
		expect(frame.contentDocument!.body.textContent).toBe("second");
		expect(loads).toBe(1);
		dom.dispose();
	},
);

withRealms(
	"the wheel at a frame's top keeps the mouse, though the page fits the screen",
	async () => {
		const terminal = new MockProcess({cols: 30, rows: 8});
		const dom = new TermDOM({transport: terminal.transport});
		const lines = Array.from({length: 10}, (_, i) => `<div>line ${i}</div>`)
			.join("");
		dom.document.body.innerHTML =
			`<iframe srcdoc="${lines}" style="display: block; border: 0; width: 20ch; height: 3px"></iframe>` +
			"<p>page</p>";
		await dom.attach();
		await settle(dom);
		const wheel = async (row: number) => {
			terminal.stdin.simulateResponse(`\x1b[<64;2;${row}M`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await settle(dom);
		};
		await wheel(2);
		expect(dom.document.visibilityState).toBe("visible");
		await wheel(5);
		expect(dom.document.visibilityState).toBe("hidden");
		dom.dispose();
	},
);
