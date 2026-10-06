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
	// split: each answer arrives in two chunks. delay: every answer but
	// DA1's arrives that many ms late, after the terminal has moved on.
	// interactive: false for a pipe.
	options: {split?: boolean; delay?: number; interactive?: boolean} = {},
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
						const send = () => {
							if (options.split) {
								const half = Math.floor(answer.length / 2);
								push(answer.slice(0, half));
								push(answer.slice(half));
							} else {
								push(answer);
							}
						};
						if (options.delay === undefined || question === DA1) {
							send();
						} else {
							setTimeout(send, options.delay);
						}
					}
					rest = rest.slice(at + question.length);
				}
			},
		}),
		resizes: new ReadableStream({start() {}}),
		sharesScreen: false,
		interactive: options.interactive ?? true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		close() {},
	};
	return {transport, output: () => output};
}

async function depthOn(
	answers: Record<string, string>,
	colorDepth?: string,
	options?: {split?: boolean; delay?: number; interactive?: boolean},
): Promise<{depth: number; output: string; ms: number}> {
	const terminal =
		fakeTerminal({[DA1]: "\x1b[?62;22c", ...answers}, colorDepth, options);
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
		"0;38:2::111:122:133",
		"0;38:2:111:122:133",
		"38:2:1:111:122:133",
		"0;38;2;111;122;133",
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
	expect(named.output).not.toContain("\x1b[38;2;111;122;133m");
	const ansi =
		await depthOn({[DECRQSS]: "\x1bP1$r0;38:2::111:122:133m\x1b\\"}, "ansi");
	expect(ansi.depth).toBe(4);
});

test("an answer split across reads still counts", async () => {
	const {depth} = await depthOn(
		{[DECRQSS]: "\x1bP1$r0;38:2::111:122:133m\x1b\\", [DA2]: "\x1b[>84;0;0c"},
		undefined,
		{split: true},
	);
	expect(depth).toBe(24);
});

test("answers that come after the terminal moved on are not typed into the page", async () => {
	const terminal = fakeTerminal(
		{
			[DA1]: "\x1b[?62;22c",
			[DECRQSS]: "\x1bP1$r0;38:2::111:122:133m\x1b\\",
			[XTGETTCAP_RGB]: "\x1bP1+r524742=382F382F38\x1b\\",
			[DA2]: "\x1b[>84;0;0c",
		},
		undefined,
		{delay: 30},
	);
	const dom = new TermDOM({transport: terminal.transport as never});
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		keys.push((event as KeyboardEvent).key);
	});
	await dom.attach();
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(keys).toEqual([]);
	// Answers that came too late do not change the colors either.
	expect(dom.window.screen.colorDepth).toBe(8);
	dom.document.body.innerHTML = "<p style=\"color: #123456\">x</p>";
	await nextFrame(dom);
	expect(terminal.output()).not.toContain("38;2;18;52;86");
	dom.dispose();
});

test("a terminal that answers nothing still gets its first frame, in 256 colors", async () => {
	const terminal = fakeTerminal({});
	const dom = new TermDOM({transport: terminal.transport as never});
	dom.document.body.innerHTML = "<p style=\"color: #123456\">x</p>";
	const start = performance.now();
	await dom.attach();
	expect(performance.now() - start).toBeLessThan(3000);
	expect(dom.window.screen.colorDepth).toBe(8);
	expect(terminal.output()).toContain("38;5;");
	dom.dispose();
});

test("a pipe is not asked, and gets 256 colors", async () => {
	const {depth, output} = await depthOn(
		{[DA2]: "\x1b[>84;0;0c"},
		undefined,
		{interactive: false},
	);
	expect(depth).toBe(8);
	expect(output).not.toContain(DECRQSS);
	expect(output).not.toContain(DA2);
});

test("renderANSI() with markup uses the screen's colors", async () => {
	const terminal = fakeTerminal({[DA1]: "\x1b[?62;22c"}, "256");
	const dom = new TermDOM({transport: terminal.transport as never});
	const html = "<p style=\"color: #123456\">x</p>";
	expect(dom.renderANSI(html)).toContain("38;5;");
	expect(dom.renderANSI(html)).not.toContain("38;2;");
	dom.dispose();
	const rgb = new TermDOM({
		transport: fakeTerminal({}, "rgb").transport as never,
	});
	expect(rgb.renderANSI(html)).toContain("38;2;18;52;86");
	rgb.dispose();
	// Before attach() the terminal has not been asked; after, its answer
	// holds for markup too.
	const tmux = new TermDOM({
		transport: fakeTerminal({
			[DA1]: "\x1b[?62;22c",
			[DA2]: "\x1b[>84;0;0c",
		}).transport as never,
	});
	expect(tmux.renderANSI(html)).toContain("38;5;");
	await tmux.attach();
	expect(tmux.renderANSI(html)).toContain("38;2;18;52;86");
	tmux.dispose();
});
