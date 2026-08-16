/**
 * A small filesystem for programs that read one: the shape of this
 * repository, held in memory. `readdirSync` serves directory listings and
 * `join`/`resolve` do path arithmetic, which is everything the runnable
 * examples ask of node:fs and node:path.
 */

export const FS_ROOT = "/workspace/termdom";

/** A directory is an object, a file is null. */
type Tree = {[name: string]: Tree | null};

const TREE: Tree = {
	".git": {
		HEAD: null,
		config: null,
		refs: {heads: {main: null}},
	},
	".gitignore": null,
	docs: {
		guides: {
			"01-getting-started.md": null,
			"02-layout.md": null,
			"03-events-and-input.md": null,
			"04-api.md": null,
		},
	},
	examples: {
		"flexbox.ts": null,
		"form.ts": null,
		"solitaire.ts": null,
		"todomvc.ts": null,
		"tree.ts": null,
	},
	src: {
		"index.ts": null,
		internal: {
			"ansi.ts": null,
			"dom.ts": null,
			"flex.ts": null,
			"layout.ts": null,
			"styles.ts": null,
			"termdom.ts": null,
		},
	},
	tests: {
		"dom.test.ts": null,
		"flexbox.test.ts": null,
	},
	"LICENSE.md": null,
	"README.md": null,
	"package.json": null,
};

function lookup(path: string): Tree | null | undefined {
	let node: Tree | null | undefined = TREE;
	const relative = path === FS_ROOT ? "" : path.slice(FS_ROOT.length + 1);
	if (!path.startsWith(FS_ROOT)) return undefined;
	for (const part of relative.split("/")) {
		if (part === "") continue;
		if (node === null || node === undefined) return undefined;
		node = node[part];
	}
	return node;
}

export interface VirtualDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export function readdirSync(
	path: string,
	_options?: {withFileTypes: boolean},
): VirtualDirent[] {
	const node = lookup(path);
	if (node === undefined) throw new Error(`ENOENT: ${path}`);
	if (node === null) throw new Error(`ENOTDIR: ${path}`);
	return Object.entries(node).map(([name, child]) => ({
		name,
		isDirectory: () => child !== null,
		isFile: () => child === null,
		isSymbolicLink: () => false,
	}));
}

export function join(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/");
}

export function resolve(path?: string): string {
	if (!path || path === ".") return FS_ROOT;
	if (path.startsWith("/")) return path.replace(/\/+/g, "/");
	return join(FS_ROOT, path);
}

/**
 * node:url, as far as the examples reach into it: `pathToFileURL` exists to
 * ask "am I the entry point?" against `process.argv[1]`, and in the sandbox
 * the entry point is the module the workbench started -- its URL is on the
 * sandbox's globalThis, and argv[1] resolves to it.
 */
export function pathToFileURL(path: string): URL {
	const main = (globalThis as {__mainModuleURL?: string}).__mainModuleURL;
	return new URL(main ?? `file://${resolve(path)}`);
}
