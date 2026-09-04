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
	"bar-chart",
	"borders",
	"chat",
	"commit-editor",
	"flexbox",
	"form",
	"fullscreen",
	"fuzzy-finder",
	"hacker-news",
	"hover",
	"lists",
	"markdown",
	"password",
	"prism",
	"progress-bar",
	"rtl",
	"shell",
	"solitaire",
	"styling",
	"todomvc",
	"tree",
	"weather",
];

/** The element the sandbox module URLs travel in, read by the client. */
export const SANDBOX_CONFIG_ID = "playground-sandbox-config";

/** The element the repository's files travel in, read by the client. */
export const FILES_SCRIPT_ID = "playground-files-data";

/**
 * The files a program in the sandbox can read, by path under the
 * repository root: every example, the guides, and the few files at the top
 * a visitor would `cat`. The sandbox seeds its filesystem from these, so
 * `ls examples` in the browser lists the same files as at a desk.
 */
export async function collectWorkspaceFiles(
	repo: FileSystemDirectoryHandle,
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const read = async (
		dir: FileSystemDirectoryHandle,
		name: string,
		path: string,
	): Promise<void> => {
		const file = await (await dir.getFileHandle(name)).getFile();
		files[path] = await file.text();
	};
	for (const name of ["README.md", "LICENSE", "package.json"]) {
		await read(repo, name, name);
	}
	const examples = await repo.getDirectoryHandle("examples");
	for await (const [name, handle] of examples.entries()) {
		if (handle.kind === "file" && name.endsWith(".ts")) {
			await read(examples, name, `examples/${name}`);
		}
	}
	const guides = await (
		await repo.getDirectoryHandle("docs")
	).getDirectoryHandle("guides");
	for await (const [name, handle] of guides.entries()) {
		if (handle.kind === "file" && name.endsWith(".md")) {
			await read(guides, name, `docs/guides/${name}`);
		}
	}
	return files;
}

/** The files as the JSON body of a `<script>`, `<` escaped like the examples. */
export function serializeFiles(files: Record<string, string>): string {
	return JSON.stringify(files).replace(/</g, "\\u003c");
}

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
