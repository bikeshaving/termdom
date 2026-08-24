/**
 * The module graph of src/, from the import headers: each module's local
 * dependencies, its dependents, and its export count. `--dot` emits
 * Graphviz instead.
 */

import {readFileSync, readdirSync} from "node:fs";
import {join, relative, resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(path);
		} else if (/\.(ts|js)$/.test(entry.name)) {
			yield path;
		}
	}
}

const IMPORT =
	/(?:^(?:import|export)\s+(type\s+)?[^"']*|^\}?\s*from\s+)["'](\.[^"']+)["']/;
const EXPORT = /^export\s+(?!\{)/;

const imports = new Map<string, Set<string>>();
const exportCounts = new Map<string, number>();
for (const file of walk(ROOT)) {
	const name = relative(ROOT, file).replace(/\.d\.ts$|\.ts$|\.js$/, "");
	const deps = new Set<string>();
	let exports = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const imported = IMPORT.exec(line);
		if (imported) {
			const target = relative(
				ROOT,
				resolve(dirname(file), imported[2]),
			).replace(/\.js$|\.ts$/, "");
			deps.add(imported[1] ? `${target} (type)` : target);
		}
		if (EXPORT.test(line)) {
			exports++;
		}
	}
	imports.set(name, deps);
	exportCounts.set(name, exports);
}

const dependents = new Map<string, Set<string>>();
for (const [name, deps] of imports) {
	for (const dep of deps) {
		if (!dependents.has(dep)) {
			dependents.set(dep, new Set());
		}
		dependents.get(dep)!.add(name);
	}
}

if (process.argv.includes("--dot")) {
	process.stdout.write("digraph modules {\n\trankdir=LR;\n");
	for (const [name, deps] of imports) {
		for (const dep of deps) {
			process.stdout.write(`\t"${name}" -> "${dep}";\n`);
		}
	}
	process.stdout.write("}\n");
} else {
	const names = [...imports.keys()].sort(
		(a, b) =>
			(dependents.get(b)?.size ?? 0) - (dependents.get(a)?.size ?? 0),
	);
	for (const name of names) {
		const deps = [...imports.get(name)!].sort();
		const fanIn = dependents.get(name)?.size ?? 0;
		process.stdout.write(
			`${name}  [exports ${exportCounts.get(name)}, dependents ${fanIn}]\n`,
		);
		for (const dep of deps) {
			process.stdout.write(`\t-> ${dep}\n`);
		}
	}
}
