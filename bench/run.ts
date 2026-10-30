/**
 * Runs the scenarios in bench/scenarios, each in a process of its own,
 * and prints the median CPU time of each measurement.
 *
 *   node bench/run.ts [--runs N] [--only a,b] [--against REF] [--markdown]
 *     [--allocated]
 *
 * --against checks REF out into a temporary worktree and runs the same
 * scenarios against it, alternating with this checkout, so both sides
 * share whatever the machine was doing.
 *
 * --allocated runs the scenarios under Bun with its collector off and
 * reports the KB each step allocates, where CPU time is reported
 * otherwise. Under load, collecting what a step left behind is the cost
 * that grows: a heap swapped out comes back in to be collected.
 */
import {spawnSync} from "node:child_process";
import {mkdtempSync, readdirSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const benchRoot = new URL("..", import.meta.url).pathname;
const scenarioDirectory = new URL("scenarios/", import.meta.url).pathname;

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const runs = Number(option("--runs") ?? 3);
const only = option("--only")?.split(",");
const against = option("--against");
const markdown = process.argv.includes("--markdown");
const allocated = process.argv.includes("--allocated");

const scenarios = readdirSync(scenarioDirectory)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => name.slice(0, -3))
	.filter((name) => only === undefined || only.includes(name));

function git(...args: string[]): void {
	const result = spawnSync("git", args, {cwd: benchRoot, stdio: "inherit"});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed`);
	}
}

function runScenario(name: string, root: string): Map<string, number> {
	const result = spawnSync(
		allocated ? "bun" : process.execPath,
		[
			...(allocated ? [] : process.execArgv),
			join(scenarioDirectory, `${name}.ts`),
			root,
		],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 600_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: allocated
				? {
					...process.env,
					BUN_JSC_useGC: "false",
					TERMDOM_BENCH_MEASURE: "allocated",
				}
				: process.env,
		},
	);
	const medians = new Map<string, number>();
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("{")) {
			const {label, median} = JSON.parse(line);
			medians.set(label, median);
		}
	}
	if (medians.size === 0) {
		console.error(`${name} on ${root} reported nothing:\n${result.stderr}`);
	}
	return medians;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

const roots: Array<{name: string; path: string}> = [];
let worktree: string | undefined;
if (against !== undefined) {
	worktree = mkdtempSync(join(tmpdir(), "termdom-bench-"));
	git("worktree", "add", "--detach", worktree, against);
	symlinkSync(join(benchRoot, "node_modules"), join(worktree, "node_modules"));
	roots.push({name: against, path: worktree});
}
roots.push({name: "this checkout", path: benchRoot.replace(/\/$/, "")});

const samples = new Map<string, Map<string, number[]>>();
try {
	for (let run = 0; run < runs; run++) {
		for (const scenario of scenarios) {
			for (const root of roots) {
				for (const [label, value] of runScenario(scenario, root.path)) {
					let byRoot = samples.get(label);
					if (byRoot === undefined) {
						byRoot = new Map();
						samples.set(label, byRoot);
					}
					const values = byRoot.get(root.name) ?? [];
					values.push(value);
					byRoot.set(root.name, values);
				}
			}
		}
		console.error(`run ${run + 1} of ${runs} done`);
	}
} finally {
	if (worktree !== undefined) {
		rmSync(join(worktree, "node_modules"));
		git("worktree", "remove", "--force", worktree);
	}
}

const header = [
	"Measurement",
	...roots.map((root) => `${root.name} (${allocated ? "KB" : "ms"})`),
	...(roots.length === 2 ? ["Change"] : []),
];
const rows = [...samples].map(([label, byRoot]) => {
	const values = roots.map((root) => {
		const values = byRoot.get(root.name);
		return values === undefined ? NaN : median(values);
	});
	const cells = [label, ...values.map((value) => value.toFixed(2))];
	if (values.length === 2) {
		const change = (values[1] - values[0]) / values[0] * 100;
		cells.push(`${change > 0 ? "+" : ""}${change.toFixed(0)}%`);
	}
	return cells;
});

if (markdown) {
	console.log(`| ${header.join(" | ")} |`);
	console.log(
		`|${header.map((_, i) => i === 0 ? " --- " : " ---: ").join("|")}|`,
	);
	for (const row of rows) {
		console.log(`| ${row.join(" | ")} |`);
	}
} else {
	const widths = header.map((_, i) =>
		Math.max(header[i].length, ...rows.map((row) => row[i].length)));
	const format = (cells: string[]): string =>
		cells
			.map((cell, i) =>
				i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
			)
			.join("  ");
	console.log(format(header));
	for (const row of rows) {
		console.log(format(row));
	}
}
