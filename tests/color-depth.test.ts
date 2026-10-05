/**
 * A terminal shows 24-bit color when it says so over the wire, or when it
 * is tmux, which converts 24-bit color for the terminal it runs in.
 * Anything else gets 256 colors, and a transport that names its depth is
 * taken at its word.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {nextFrame} from "./test-utils.js";

const DECRQSS = "\x1bP$qm\x1b\\";
const XTGETTCAP_RGB = "\x1bP+q524742\x1b\\";
const XTGETTCAP_TC = "\x1bP+q5463\x1b\\";
const DA1 = "\x1b[c";
const DA2 = "\x1b[>c";

// A terminal that answers the questions it knows, in the order asked,
// and says nothing to the rest.
function fakeTerminal(
	answers: Record<string, string>,
	colorDepth?: string,
): {transport: unknown; output(): string} {
	let output = "";
	let push!: (text: string) => void;
	const questions = [DECRQSS, XTGETTCAP_RGB, XTGETTCAP_TC, DA2, DA1];
	const transport = {
		cols: 40,
		rows: 6,
		colorDepth,
		readable: new ReadableStream<string>({
			start(controller) {
				push = (text) => controller.enqueue(text);
			},
		}),
		writable: new WritableStream<string>({
			write(chunk) {
				output += String(chunk);
				let rest = String(chunk);
				for (;;) {
					const found = questions
						.map((question) => [rest.indexOf(question), question] as const)
						.filter(([at]) => at !== -1)
						.sort((a, b) => a[0] - b[0])[0];
					if (found === undefined) {
						break;
					}
					const [at, question] = found;
					const answer = answers[question];
					if (answer !== undefined) {
						push(answer);
					}
					rest = rest.slice(at + question.length);
				}
			},
		}),
		resizes: new ReadableStream({start() {}}),
		sharesScreen: false,
		interactive: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		close() {},
	};
	return {transport, output: () => output};
}

async function depthOn(
	answers: Record<string, string>,
	colorDepth?: string,
): Promise<{depth: number; output: string; ms: number}> {
	const terminal =
		fakeTerminal({[DA1]: "\x1b[?62;22c", ...answers}, colorDepth);
	const dom = new TermDOM({transport: terminal.transport as never});
	const start = performance.now();
	await dom.attach();
	const ms = performance.now() - start;
	dom.document.body.innerHTML = "<p style=\"color: #123456\">x</p>";
	await nextFrame(dom);
	const depth = dom.window.screen.colorDepth;
	dom.dispose();
	return {depth, output: terminal.output(), ms};
}

test("a terminal that keeps a 24-bit color in its style gets 24-bit color", async () => {
	for (const style of [
		"0;38:2::1:2:3",
		"0;38:2:1:2:3",
		"38:2:1:1:2:3",
		"0;38;2;1;2;3",
	]) {
		const {depth, output} =
			await depthOn({[DECRQSS]: `\x1bP1$r${style}m\x1b\\`});
		expect([style, depth]).toEqual([style, 24]);
		expect(output).toContain("38;2;18;52;86");
	}
});

test("a terminal that answers XTGETTCAP for RGB or Tc gets 24-bit color", async () => {
	expect(
		(await depthOn({
			[DECRQSS]: "\x1bP0$r\x1b\\",
			[XTGETTCAP_RGB]: "\x1bP1+r524742=382F382F38\x1b\\",
		})).depth,
	).toBe(24);
	expect(
		(await depthOn({
			[XTGETTCAP_RGB]: "\x1bP0+r524742\x1b\\",
			[XTGETTCAP_TC]: "\x1bP1+r5463\x1b\\",
		})).depth,
	).toBe(24);
});

test("tmux gets 24-bit color, since it converts it for the terminal it runs in", async () => {
	const {depth} = await depthOn({
		[DECRQSS]: "\x1bP0$r\x1b\\",
		[DA2]: "\x1b[>84;0;0c",
	});
	expect(depth).toBe(24);
});

test("a terminal that says nothing of 24-bit color gets 256, without waiting out a timeout", async () => {
	// Terminal.app: it answers DA1 and DA2 and nothing else.
	const silent = await depthOn({[DA2]: "\x1b[>1;95;0c"});
	expect(silent.depth).toBe(8);
	expect(silent.output).toContain("38;5;");
	expect(silent.output).not.toContain("38;2;18;52;86");
	expect(silent.ms).toBeLessThan(500);
	// xterm.js: it answers DECRQSS, but without the color.
	const dropped = await depthOn({
		[DECRQSS]: "\x1bP1$r0m\x1b\\",
		[DA2]: "\x1b[>0;276;0c",
	});
	expect(dropped.depth).toBe(8);
	// A downgraded color is no 24-bit color.
	const downgraded = await depthOn({[DECRQSS]: "\x1bP1$r0;38:5:16m\x1b\\"});
	expect(downgraded.depth).toBe(8);
});

test("a transport that names its color depth is not asked", async () => {
	const named = await depthOn({[DA2]: "\x1b[>1;95;0c"}, "rgb");
	expect(named.depth).toBe(24);
	expect(named.output).not.toContain(XTGETTCAP_RGB);
	expect(named.output).not.toContain("\x1b[38;2;1;2;3m");
	const ansi =
		await depthOn({[DECRQSS]: "\x1bP1$r0;38:2::1:2:3m\x1b\\"}, "ansi");
	expect(ansi.depth).toBe(4);
});
