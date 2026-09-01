import {describe, expect, test} from "@b9g/libuild/test";

import {transportFromProcess} from "../src/internal/exchange.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * A raw-capture terminal: the bytes TermDOM writes, verbatim, so a test can
 * name the transform sequence among them and count what follows it.
 * stdin.isTTY:false turns cursor detection off, so the region starts at the
 * terminal's home row and every band row is a screen row plus one.
 */
function rawTerminal(
	rows: number,
	cols: number,
): {process: any; taken: () => string} {
	let output = "";
	return {
		process: {
			stdout: {
				write: (chunk: any, encoding?: any, callback?: any) => {
					output += chunk;
					if (typeof encoding === "function") {
						callback = encoding;
					}
					if (callback) {
						setImmediate(() => callback());
					}
					return true;
				},
				columns: cols,
				rows,
				isTTY: true,
			},
			stdin: {
				isTTY: false,
				setRawMode: () => {},
				resume: () => {},
				pause: () => {},
				setEncoding: () => {},
				on: () => {},
				off: () => {},
			},
			exit: () => {},
			env: {},
			on: () => {},
			emit: () => false,
			removeListener: () => {},
			removeAllListeners: () => {},
		},
		taken: () => {
			const taken = output;
			output = "";
			return taken;
		},
	};
}

/** A full-width scroll box of numbered rows. */
function scrollPane(
	id: string,
	rows: number,
	count: number,
	label: string,
): string {
	const items = Array.from(
		{length: count},
		(_, i) => `<div>${label} ${i}</div>`,
	).join("");
	return (
		`<div id="${id}" style="height:${rows}em;overflow-y:scroll">` +
		`${items}</div>`
	);
}

/** Chrome above and below a nine-row pane, in a twelve-row terminal. */
const CHROME_AND_PANE =
	"<div id=\"head\">HEADER</div>" +
	scrollPane("pane", 9, 40, "row") +
	"<div id=\"foot\">FOOTER</div>";

/**
 * Run `write` from inside a frame callback, where a render is already in
 * flight, so the writes coalesce into one trailing frame instead of each
 * painting on its own.
 */
async function inOneFrame(dom: any, write: () => void): Promise<void> {
	await new Promise<void>((resolve) => {
		dom.window.requestAnimationFrame(() => {
			write();
			resolve();
		});
	});
	await nextFrame(dom);
}

describe("banded element scroll", () => {
	test("a fullscreen pane scrolls under untouched chrome", async () => {
		const terminal = rawTerminal(12, 40);
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
		});
		dom.attach();
		await nextFrame(dom);
		const stage = dom.document.createElement("div");
		stage.innerHTML = CHROME_AND_PANE;
		dom.document.body.appendChild(stage);
		await stage.requestFullscreen();
		await nextFrame(dom);
		terminal.taken();

		dom.document.getElementById("pane")!.scrollTop = 3;
		await nextFrame(dom);

		// Band rows 2..10: the header above and the footer below are outside
		// the margins, so the terminal never moves them and the frame never
		// mentions them. Only the three rows the delete exposed are painted.
		expect(terminal.taken()).toBe(
			"\x1b[?2026h\x1b[2;10r\x1b[2;1H\x1b[3M\x1b[r" +
			"\x1b[1;1H\x1b7" +
			"\r\n\r\n\r\n\r\n\r\n\r\n\r\n" +
			"\r\x1b[Krow 9                                   " +
			"\r\n\r\x1b[Krow 10                                  " +
			"\r\n\r\x1b[Krow 11                                  " +
			"\x1b[12;1H\x1b[?2026l",
		);
		dom.dispose();
	});

	test("a main-screen pane scrolls under untouched chrome", async () => {
		const terminal = rawTerminal(12, 40);
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
		});
		dom.attach();
		dom.document.body.innerHTML = CHROME_AND_PANE;
		await nextFrame(dom);
		terminal.taken();

		dom.document.getElementById("pane")!.scrollTop = 2;
		await nextFrame(dom);

		expect(terminal.taken()).toBe(
			"\x1b[?2026h\x1b[2;10r\x1b[2;1H\x1b[2M\x1b[r" +
			"\x1b[1;1H\x1b7" +
			"\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n" +
			"\r\x1b[Krow 9\r\n\r\x1b[Krow 10" +
			"\x1b[11;1H\x1b[?2026l",
		);
		dom.dispose();
	});

	test("scrolling back up inserts lines in the same band", async () => {
		const terminal = rawTerminal(12, 40);
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
		});
		dom.attach();
		dom.document.body.innerHTML = CHROME_AND_PANE;
		await nextFrame(dom);
		const pane = dom.document.getElementById("pane")!;
		pane.scrollTop = 5;
		await nextFrame(dom);
		terminal.taken();

		pane.scrollTop = 3;
		await nextFrame(dom);

		expect(terminal.taken()).toBe(
			"\x1b[?2026h\x1b[2;10r\x1b[2;1H\x1b[2L\x1b[r" +
			"\x1b[1;1H\x1b7" +
			"\r\n\r\x1b[Krow 3\r\n\r\x1b[Krow 4" +
			"\x1b[11;1H\x1b[?2026l",
		);
		dom.dispose();
	});

	test("a box overlapping the band survives the shift", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({
			transport: transportFromProcess(terminal as any),
		});
		dom.attach();
		dom.document.body.innerHTML =
			CHROME_AND_PANE +
			"<div id=\"over\" style=\"position:absolute;top:4em;left:20ch;" +
			"width:12ch;height:1em\">OVERLAY</div>";
		await nextFrame(dom);

		dom.document.getElementById("pane")!.scrollTop = 3;
		await nextFrame(dom);

		const lines = terminal
			.getPlainText()
			.split("\n")
			.map((line: string) => line.trimEnd());
		expect(lines[0]).toBe("HEADER");
		expect(lines[1]).toBe("row 3");
		// The terminal dragged the overlay's row along with the band; the
		// diff put the overlay back where it belongs.
		expect(lines[4]).toBe("row 6               OVERLAY");
		expect(lines[9]).toBe("row 11");
		expect(lines[10]).toBe("FOOTER");
		dom.dispose();
	});

	test("two boxes scrolled in one frame repaint instead", async () => {
		const terminal = rawTerminal(12, 40);
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
		});
		dom.attach();
		dom.document.body.innerHTML =
			scrollPane("a", 5, 20, "a") + scrollPane("b", 5, 20, "b");
		await nextFrame(dom);
		terminal.taken();

		await inOneFrame(dom, () => {
			dom.document.getElementById("a")!.scrollTop = 2;
			dom.document.getElementById("b")!.scrollTop = 2;
		});

		// No band names both boxes, so no DECSTBM at all -- the diff repaints
		// the digits that changed in each.
		expect(terminal.taken()).toBe(
			"\x1b[?2026h\x1b[1;1H\x1b7" +
			"\x1b[2C2\r\n\x1b[2C3\r\n\x1b[2C4\r\n\x1b[2C5\r\n\x1b[2C6\r\n" +
			"\x1b[2C2\r\n\x1b[2C3\r\n\x1b[2C4\r\n\x1b[2C5\r\n\x1b[2C6" +
			"\x1b[10;1H\x1b[?2026l",
		);
		dom.dispose();
	});

	test("a scroll alongside a mutation repaints instead", async () => {
		const terminal = rawTerminal(12, 40);
		const dom = new TermDOM({
			transport: transportFromProcess(terminal.process as any),
		});
		dom.attach();
		dom.document.body.innerHTML =
			"<div id=\"head\">HEADER</div>" + scrollPane("pane", 9, 40, "row");
		await nextFrame(dom);
		terminal.taken();

		await inOneFrame(dom, () => {
			dom.document.getElementById("pane")!.scrollTop = 3;
			dom.document.getElementById("head")!.textContent = "CHANGED";
		});

		// Layout moved under the band, so the rows the terminal would shift
		// are not the rows the last frame painted.
		expect(terminal.taken()).toBe(
			"\x1b[?2026h\x1b[1;1H\x1b7CH\x1b[1CNGED\r\n" +
			"\x1b[4C3\r\n\x1b[4C4\r\n\x1b[4C5\r\n\x1b[4C6\r\n\x1b[4C7\r\n" +
			"\x1b[4C8\r\n\x1b[4C9\r\n\x1b[4C10\r\n\x1b[4C11" +
			"\x1b[10;1H\x1b[?2026l",
		);
		dom.dispose();
	});
});
