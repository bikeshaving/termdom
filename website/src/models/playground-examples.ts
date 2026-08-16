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
	"password",
	"progress-bar",
	"rtl",
	"solitaire",
	"todomvc",
	"tree",
	"weather",
];

/** The element the sandbox module URLs travel in, read by the client. */
export const SANDBOX_CONFIG_ID = "playground-sandbox-config";

/** What the sandbox's import map resolves each bare specifier to. */
export interface SandboxConfig {
	termdom: string;
	nodefs: string;
	crankStandalone: string;
	crankDom: string;
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
 * Read every runnable example under `dir`, verbatim. What a visitor reads is
 * the file that ships with the library -- the import, the construction, the
 * attach, the types. The runner erases the types at run time, where nobody
 * reads the result, and the sandbox's import map resolves `@b9g/termdom`,
 * `node:fs` and `node:path` to the page's own modules.
 */
export async function collectExamples(
	dir: FileSystemDirectoryHandle,
): Promise<PlaygroundExample[]> {
	const examples: PlaygroundExample[] = [];
	for (const id of RUNNABLE) {
		const label = `${id}.ts`;
		const fileHandle = await dir.getFileHandle(label);
		const file = await fileHandle.getFile();
		examples.push({id, label, code: await file.text()});
	}

	return examples;
}
