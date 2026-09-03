/**
 * A small filesystem for programs that read and write one: a directory tree
 * held in memory, rooted at `/`, with this repository's shape under
 * /workspace/termdom and a home directory for state files. `readdirSync`,
 * `readFileSync`, `writeFileSync` and `mkdirSync` cover what the runnable
 * examples ask of node:fs; `join` and `resolve` cover node:path;
 * `homedir` covers node:os; `pathToFileURL` covers node:url.
 */

export const FS_ROOT = "/workspace/termdom";
export const HOME = "/home/visitor";

/** A directory is an object; a file is its contents. */
type Tree = {[name: string]: Tree | string};

const REPO: Tree = {
	".git": {
		HEAD: "",
		config: "",
		refs: {heads: {main: ""}},
	},
	".gitignore": "",
	docs: {
		guides: {},
		"dom-conformance.md": "",
		"cssom-conformance.md": "",
	},
	examples: {},
	src: {
		"index.ts": "",
		internal: {
			"cssom.ts": "",
			"dom.ts": "",
			"exchange.ts": "",
			"htmltables.ts": "",
			"input.ts": "",
			"inspector.ts": "",
			"layout.ts": "",
			"painter.ts": "",
			"screen.ts": "",
			"termdom.ts": "",
			"text.ts": "",
			"useragent.ts": "",
		},
	},
	tests: {
		"dom.test.ts": "",
		"cascade.test.ts": "",
		"flexbox.test.ts": "",
	},
	LICENSE: "",
	"README.md": "",
	"package.json": "",
};

// The page seeds the files a program can read: every example, the guides,
// and the top-level files, with their real contents. Read here, as the
// module loads inside the sandbox, so a program's first readFileSync sees
// them. A file the page did not carry keeps its empty placeholder.
const seeded = (globalThis as {__workspaceFiles?: Record<string, string>})
	.__workspaceFiles;
if (seeded !== undefined) {
	for (const [path, contents] of Object.entries(seeded)) {
		const parts = path.split("/");
		const name = parts.pop()!;
		let node: Tree = REPO;
		for (const part of parts) {
			const child = node[part];
			node = typeof child === "object" ? child : (node[part] = {});
		}
		node[name] = contents;
	}
}

const ROOT: Tree = {
	workspace: {termdom: REPO},
	home: {visitor: {}},
};

function segments(path: string): string[] {
	return path.split("/").filter((part) => part !== "" && part !== ".");
}

function lookup(path: string): Tree | string | undefined {
	let node: Tree | string = ROOT;
	for (const part of segments(path)) {
		if (typeof node === "string") return undefined;
		const child: Tree | string | undefined = node[part];
		if (child === undefined) return undefined;
		node = child;
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
	if (typeof node === "string") throw new Error(`ENOTDIR: ${path}`);
	return Object.entries(node).map(([name, child]) => ({
		name,
		isDirectory: () => typeof child !== "string",
		isFile: () => typeof child === "string",
		isSymbolicLink: () => false,
	}));
}

export function readFileSync(path: string, _encoding?: string): string {
	const node = lookup(path);
	if (node === undefined) throw new Error(`ENOENT: ${path}`);
	if (typeof node !== "string") throw new Error(`EISDIR: ${path}`);
	return node;
}

export function writeFileSync(path: string, contents: string): void {
	const parts = segments(path);
	const name = parts.pop();
	if (!name) throw new Error(`EISDIR: ${path}`);
	const dir = lookup("/" + parts.join("/"));
	if (dir === undefined) throw new Error(`ENOENT: ${path}`);
	if (typeof dir === "string") throw new Error(`ENOTDIR: ${path}`);
	dir[name] = String(contents);
}

export function mkdirSync(
	path: string,
	options?: {recursive?: boolean},
): void {
	let node: Tree = ROOT;
	for (const part of segments(path)) {
		const child: Tree | string | undefined = node[part];
		if (child === undefined) {
			if (!options?.recursive) throw new Error(`ENOENT: ${path}`);
			node = node[part] = {};
		} else if (typeof child === "string") {
			throw new Error(`ENOTDIR: ${path}`);
		} else {
			node = child;
		}
	}
}

export function join(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/");
}

// As node:path resolves: right to left until a segment is absolute, the
// working directory beneath them all, and `.` and `..` folded away.
export function resolve(...parts: string[]): string {
	let path = "";
	for (let i = parts.length - 1; i >= 0 && !path.startsWith("/"); i--) {
		if (parts[i]) {
			path = path === "" ? parts[i] : `${parts[i]}/${path}`;
		}
	}
	if (!path.startsWith("/")) {
		path = `${FS_ROOT}/${path}`;
	}
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			out.pop();
		} else {
			out.push(part);
		}
	}
	return `/${out.join("/")}`;
}

/** node:os, as far as the examples reach into it. */
export function homedir(): string {
	return HOME;
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
