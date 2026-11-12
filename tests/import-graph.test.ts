/**
 * No module of the engine imports, at run time, a module that imports it
 * back. A cycle decides which module finishes loading first by whoever
 * the application reaches first, and a class that extends one from the
 * other side of a cycle is undefined when its module runs. Type-only
 * imports erase, so they may point anywhere.
 */
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, normalize, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {expect, test} from "@b9g/libuild/test";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// A module as the lists below name it, whatever the platform's separator.
function nameOf(path: string): string {
	return path.slice(src.length + 1).split(sep).join("/");
}

function modules(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return modules(path);
		}
		return path.endsWith(".ts") ? [path] : [];
	});
}

function runtimeImports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const found: string[] = [];
	const statements =
		/^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)";/gms;
	for (const [, typeOnly, clause, specifier] of text.matchAll(statements)) {
		if (typeOnly) {
			continue;
		}
		const named = clause.match(/\{([^}]*)\}/);
		const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
		if (named && rest === "") {
			const members = named[1].split(",").map((member) => member.trim())
				.filter(Boolean);
			if (members.every((member) => member.startsWith("type "))) {
				continue;
			}
		}
		found.push(normalize(join(dirname(file), specifier)));
	}
	return found;
}

test("no module of the engine imports one that imports it back", () => {
	const graph = new Map(
		modules(src).map((file) => [file, runtimeImports(file)]),
	);
	const cycles: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (file: string): void => {
		state.set(file, "visiting");
		stack.push(file);
		for (const next of graph.get(file) ?? []) {
			if (state.get(next) === "visiting") {
				const loop = stack.slice(stack.indexOf(next)).concat(next);
				cycles.push(loop.map(nameOf).join(" -> "));
			} else if (!state.has(next) && graph.has(next)) {
				visit(next);
			}
		}
		stack.pop();
		state.set(file, "done");
	};
	for (const file of graph.keys()) {
		if (!state.has(file)) {
			visit(file);
		}
	}
	expect(cycles).toEqual([]);
});

// Modules that could stand as packages of their own: each reaches, at run
// time, only the modules listed with it.
const STANDALONE: Record<string, string[]> = {
	"internal/arabicshaper.ts": [],
	"internal/bidi.ts": ["generated/biditables.ts"],
	"internal/flags.ts": [],
	"internal/layoutsolver.ts": ["internal/flags.ts"],
	"internal/linebreak.ts": ["generated/linebreaktables.ts"],
	"internal/text.ts": [
		"generated/biditables.ts",
		"generated/widthtables.ts",
		"internal/arabicshaper.ts",
		"internal/bidi.ts",
	],
};

test("the standalone modules reach no other module of the engine", () => {
	const reached: Record<string, string[]> = {};
	for (const module of Object.keys(STANDALONE)) {
		const seen = new Set<string>();
		const visit = (file: string): void => {
			for (const next of runtimeImports(file)) {
				if (!seen.has(next)) {
					seen.add(next);
					visit(next);
				}
			}
		};
		visit(join(src, module));
		reached[module] = [...seen].map(nameOf).sort();
	}
	expect(reached).toEqual(STANDALONE);
});
