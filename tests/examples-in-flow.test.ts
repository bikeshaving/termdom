/**
 * The examples as a person runs them: from a shell, drawn in the flow
 * under the prompt, then driven with keys. Each runs in a Bun process of
 * its own through run-example-in-flow.ts, under a mock terminal that
 * already holds three shell rows. It fails when a frame scrolls the
 * terminal under the rows it was given, as the Prism example's did once
 * its background filled the screen, or when the shell's rows change.
 */
import {spawn} from "node:child_process";

import {expect, test} from "@b9g/libuild/test";

// All but those that need the network, a pseudo-terminal or fullscreen
// to show anything: chat, hacker-news, markdown, password, pty, ssh,
// vim-chat and weather. Solitaire deals only when run as the program.
const NAMES = [
	"animated",
	"bar-chart",
	"borders",
	"canvas",
	"codemirror",
	"commit-editor",
	"dialog",
	"flexbox",
	"focus",
	"form",
	"fuzzy-finder",
	"git-log",
	"gradients",
	"grid",
	"grid-lines",
	"hello-crank",
	"hello-react",
	"hello-svelte",
	"hello-vue",
	"hello-world",
	"highlights",
	"hover",
	"images",
	"inputs",
	"katex",
	"lists",
	"matrix-rain",
	"panels",
	"popover",
	"prism",
	"progress-bar",
	"rtl",
	"shell",
	"sticky",
	"styling",
	"table",
	"todomvc",
	"tree",
];

const runner = new URL("./run-example-in-flow.ts", import.meta.url).pathname;
const bun = (globalThis as {Bun?: unknown}).Bun === undefined
	? null
	: process.execPath;
const run = bun === null ? test.skip : test;

// Svelte's client build is behind the browser condition, which the
// example restarts itself with when it isn't set. Set, it runs here.
const CONDITIONS: Record<string, string[]> = {
	"hello-svelte": ["--conditions=browser"],
};

interface Outcome {
	status: number | null;
	stderr: string;
}

function runExample(name: string): Promise<Outcome> {
	return new Promise((resolve) => {
		const child = spawn(
			bun!,
			[...(CONDITIONS[name] ?? []), runner, name],
			{stdio: ["ignore", "ignore", "pipe"]},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			stderr += text;
		});
		const timer = setTimeout(() => child.kill(), 60000);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({status, stderr});
		});
	});
}

// Six at a time, started as the file loads, so the examples run side by
// side while each test waits for its own.
const outcomes = new Map<string, Promise<Outcome>>();
const finish = new Map<string, (outcome: Outcome) => void>();
for (const name of NAMES) {
	outcomes.set(name, new Promise((resolve) => finish.set(name, resolve)));
}
if (bun !== null) {
	const queue = [...NAMES];
	const work = async (): Promise<void> => {
		for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
			finish.get(name)!(await runExample(name));
		}
	};
	for (let i = 0; i < 6; i++) {
		void work();
	}
}

for (const name of NAMES) {
	run(
		`the ${name} example stays under the prompt it was run from`,
		async () => {
			const {status, stderr} = await outcomes.get(name)!;
			expect(stderr.trim()).toBe("");
			expect(status).toBe(0);
		},
	);
}
