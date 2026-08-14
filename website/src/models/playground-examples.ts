import {stripTypeScriptTypes} from "node:module";

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
];

const SHEBANG = /^#!.*\r?\n/;
const COMMENT_LINES = /^(?:[ \t]*\/\/.*\r?\n)+/;
const TERMDOM_IMPORT =
	/^import\s+\{[^}]*\}\s+from\s+["']@b9g\/termdom["'];?[ \t]*\r?\n/m;
// The construction takes any comment block written above it along with it:
// it explains the two lines that are about to disappear.
const CONSTRUCTION =
	/^(?:[ \t]*\/\/.*\r?\n)*const\s+term\s*=\s*new\s+TermDOM\([\s\S]*?\);[ \t]*\r?\n/m;
const ATTACH = /^(?:await\s+)?term\.attach\(\);[ \t]*\r?\n/m;
const URL_IMPORT =
	/^import\s+\{\s*pathToFileURL\s*\}\s+from\s+["']node:url["'];?[ \t]*\r?\n/m;

/**
 * Cut the `import.meta.url === pathToFileURL(process.argv[1])` block a
 * runnable-and-importable example ends with. The block runs the program when
 * the file is the entry point, which the playground has already decided.
 */
function dropMainGuard(code: string): string {
	const use = code.lastIndexOf("pathToFileURL(");
	if (use === -1) return code;
	const guard = code.lastIndexOf("\nif (", use);
	return guard === -1 ? code : code.slice(0, guard + 1);
}

/**
 * An example as the playground runs it.
 *
 * The runner hands a program an already-attached `term`, so the three lines
 * every example opens with -- the import, the construction and the attach --
 * are the playground's job and come off here. The file's own usage header
 * comes off too: it documents a command line the reader does not have. Node
 * strips the type annotations, which is what `node examples/*.ts` does to run
 * them in the first place. Everything else is the file verbatim.
 */
export function transformExample(source: string): string {
	let code = stripTypeScriptTypes(source, {mode: "strip"});
	code = code.replace(SHEBANG, "");
	code = code.replace(COMMENT_LINES, "");
	code = code.replace(TERMDOM_IMPORT, "");
	code = code.replace(CONSTRUCTION, "");
	code = code.replace(ATTACH, "");
	code = code.replace(URL_IMPORT, "");
	code = dropMainGuard(code);
	return code.replace(/^\s*\n/, "").replace(/[ \t]+$/gm, "").trimEnd() + "\n";
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

/** Read and transform every runnable example under `dir`. */
export async function collectExamples(
	dir: FileSystemDirectoryHandle,
): Promise<PlaygroundExample[]> {
	const examples: PlaygroundExample[] = [];
	for (const id of RUNNABLE) {
		const label = `${id}.ts`;
		const fileHandle = await dir.getFileHandle(label);
		const file = await fileHandle.getFile();
		examples.push({id, label, code: transformExample(await file.text())});
	}

	return examples;
}
