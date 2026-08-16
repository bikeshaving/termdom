/**
 * The programs the playground offers, read from the repository's own
 * `examples/` directory at build time. What a visitor edits is the file that
 * ships with the library, not a copy written for the website.
 */
export interface PlaygroundExample {
	/** The filename without its extension: `hello-world`. */
	id: string;
	/** The filename: `hello-world.ts`. */
	label: string;
	code: string;
}

/**
 * The files that run in the page.
 *
 * Everything else in `examples/` reaches for something the browser does not
 * have -- `node:fs`, `node:child_process`, `process.argv`, `fetch` (bound to
 * undefined in the runner), or an npm package the site does not bundle -- or
 * carries an `import` the runner cannot resolve, since a program is compiled
 * as a function body rather than a module.
 */
const RUNNABLE = [
	"hello-world",
	"animated",
	"borders",
	"commit-editor",
	"flexbox",
	"form",
	"fullscreen",
	"lists",
	"progress-bar",
	"rtl",
	"tree",
];

/** The element the sandbox module URLs travel in, read by the client. */
export const SANDBOX_CONFIG_ID = "playground-sandbox-config";

/** What the sandbox's import map resolves each bare specifier to. */
export interface SandboxConfig {
	termdom: string;
	nodefs: string;
}

/** The element a page's programs travel in, read by the client bundle. */
export const EXAMPLES_SCRIPT_ID = "playground-examples-data";

/**
 * The programs as the JSON body of a `<script>`. `<` is escaped so no example
 * can close the element it is written into.
 */
export function serializeExamples(examples: PlaygroundExample[]): string {
	return JSON.stringify(examples).replace(/</g, "\\u003c");
}

/**
 * Read every runnable example under `dir`, as the playground shows and runs
 * it: the file, with the type annotations stripped -- the same erasure
 * `node examples/*.ts` applies -- and nothing else. The import, the
 * construction and the attach all stay: the program in the editor is the
 * program that runs, and the sandbox's import map resolves `@b9g/termdom`,
 * `node:fs` and `node:path` to the page's own modules.
 *
 * `node:module` comes in dynamically so this module's top level stays pure
 * enough for the client bundle, which imports the ids below.
 */
export async function collectExamples(
	dir: FileSystemDirectoryHandle,
): Promise<PlaygroundExample[]> {
	const {stripTypeScriptTypes} = await import("node:module");
	const examples: PlaygroundExample[] = [];
	for (const id of RUNNABLE) {
		const label = `${id}.ts`;
		const fileHandle = await dir.getFileHandle(label);
		const file = await fileHandle.getFile();
		const code = stripTypeScriptTypes(await file.text(), {mode: "strip"});
		examples.push({
			id,
			label,
			code: code.replace(/[ \t]+$/gm, "").trimEnd() + "\n",
		});
	}

	return examples;
}
