/**
 * The module graph of src/, from the import headers: each module's local
 * dependencies, its dependents, and its exports by name and line. `--dot`
 * emits Graphviz instead.
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
const DECLARATION =
	/^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const NAME_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/;

interface ExportSite {
	name: string;
	line: number;
}

const imports = new Map<string, Set<string>>();
const exportSites = new Map<string, ExportSite[]>();
const escapeWriters = new Set<string>();
for (const file of walk(ROOT)) {
	const name = relative(ROOT, file).replace(/\.d\.ts$|\.ts$|\.js$/, "");
	const deps = new Set<string>();
	const sites: ExportSite[] = [];
	const source = readFileSync(file, "utf8");
	if (/\\x1b|\\u001b|\x1b/i.test(source)) {
		escapeWriters.add(name);
	}
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const imported = IMPORT.exec(line);
		if (imported) {
			const target = relative(
				ROOT,
				resolve(dirname(file), imported[2]),
			).replace(/\.js$|\.ts$/, "");
			deps.add(imported[1] ? `${target} (type)` : target);
		}
		const declared = DECLARATION.exec(line);
		if (declared) {
			sites.push({name: declared[1], line: i + 1});
			continue;
		}
		const list = NAME_LIST.exec(line);
		if (list) {
			for (const entry of list[1].split(",")) {
				const exported = entry.trim().split(/\s+as\s+/).pop()!.trim();
				if (exported) {
					sites.push({name: exported, line: i + 1});
				}
			}
		}
	}
	imports.set(name, deps);
	exportSites.set(name, sites);
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

/**
 * The doors of `internal/dom`: the function surface script and engine reach
 * through. Classes and types stay exported for the platform object and the
 * sibling modules; a new function export is a new door, and a door is a
 * decision, so adding one means editing this list in the open.
 */
const DOM_DOORS = [
	"clearPseudoElement",
	"applyMutations",
	"clampScrollOffsets",
	"closeTopmost",
	"createDocumentWindow",
	"disconnectObservers",
	"dispatchAsUserAgent",
	"dropFullscreen",
	"elementAtDocumentPoint",
	"ensurePseudoElement",
	"fieldCaretOffset",
	"fieldSelectionRange",
	"fieldValueText",
	"flatIsConnected",
	"flatParentElement",
	"flushObservers",
	"getMount",
	"getPseudoHost",
	"getPseudoName",
	"getShadowRoot",
	"getTopLayer",
	"flushLayout",
	"hoverListenerCount",
	"isModalDialog",
	"isUAShadowRoot",
	"keyboardActivation",
	"lightDismissPress",
	"lightDismissRelease",
	"lockDataTransfer",
	"mount",
	"observeTree",
	"parkFieldCaret",
	"parseHTMLDocument",
	"pseudoElement",
	"pseudoElementCount",
	"refreshMediaQueries",
	"renderedTopLayer",
	"revealFieldCaret",
	"runFrameCallbacks",
	"selectionFocusOf",
	"selectionRecordOf",
	"selectorResolver",
	"setDocumentFocusVisible",
	"setHoveredElement",
	"setUASelection",
	"styleElementCount",
	"takeScrollBand",
	"topmostModalDialog",
	"upgradeUAWidget",
];

if (process.argv.includes("--check")) {
	const failures: string[] = [];
	const domExports = exportSites.get("internal/dom") ?? [];
	const doors = domExports
		.map((site) => site.name)
		.filter((name) => /^[a-z]/.test(name));
	for (const name of doors) {
		if (!DOM_DOORS.includes(name)) {
			failures.push(`internal/dom exports an unlisted door: ${name}`);
		}
	}
	for (const name of DOM_DOORS) {
		if (!doors.includes(name)) {
			failures.push(`internal/dom lost a listed door: ${name}`);
		}
	}
	for (const dependent of dependents.get("internal/termdom") ?? []) {
		if (dependent !== "index") {
			failures.push(
				`internal/termdom is glue and only index may import it, not ${dependent}`,
			);
		}
	}
	/**
	 * The modules that spell escape sequences. exchange.ts writes them to the
	 * terminal and reads them back; screen.ts spells the frames. inspector.ts
	 * is the third because its SGR literals color a debugger's stdout through
	 * util.inspect, never the terminal transport.
	 */
	const ESCAPE_WRITERS = [
		"internal/exchange",
		"internal/screen",
		"internal/inspector",
	];
	for (const name of escapeWriters) {
		if (name.startsWith("internal/") && !ESCAPE_WRITERS.includes(name)) {
			failures.push(
				`${name} spells an escape sequence, which only ` +
				`${ESCAPE_WRITERS.join(", ")} may`,
			);
		}
	}
	const LEAVES = ["internal/text"];
	const isLeaf = (name: string): boolean =>
		name.startsWith("generated/") || LEAVES.includes(name);
	for (const [name, deps] of imports) {
		if (!isLeaf(name)) {
			continue;
		}
		for (const dep of deps) {
			if (isLeaf(dep.replace(/ \(type\)$/, ""))) {
				continue;
			}
			failures.push(`${name} is a leaf and may only import leaves, not ${dep}`);
		}
	}
	if (failures.length > 0) {
		for (const failure of failures) {
			process.stderr.write(`${failure}\n`);
		}
		process.exit(1);
	}
	process.stdout.write("module graph ok\n");
} else if (process.argv.includes("--dot")) {
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
		const sites = exportSites.get(name)!;
		const fanIn = dependents.get(name)?.size ?? 0;
		process.stdout.write(
			`${name}  [exports ${sites.length}, dependents ${fanIn}]\n`,
		);
		for (const dep of deps) {
			process.stdout.write(`\t-> ${dep}\n`);
		}
		for (const site of sites) {
			process.stdout.write(`\t${site.name} @${site.line}\n`);
		}
	}
}
