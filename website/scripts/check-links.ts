/**
 * Fail the build on a broken internal link.
 *
 * A static site's worst failure mode is a link that 404s in production and
 * nowhere else, so every href in the generated HTML is resolved against the
 * files actually emitted.
 */
import {readdirSync, readFileSync, statSync, existsSync} from "node:fs";
import {join, resolve, dirname} from "node:path";

const PUBLIC = resolve(import.meta.dirname, "../dist/public");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...walk(path));
		} else if (path.endsWith(".html")) {
			out.push(path);
		}
	}
	return out;
}

function resolves(href: string, fromFile: string): boolean {
	const path = href.split("#")[0].split("?")[0];
	if (path === "") {
		return true;
	}

	const target = path.startsWith("/")
		? join(PUBLIC, path)
		: resolve(dirname(fromFile), path);

	if (existsSync(target)) {
		const stat = statSync(target);
		if (stat.isFile()) {
			return true;
		}
		if (stat.isDirectory() && existsSync(join(target, "index.html"))) {
			return true;
		}
		return false;
	}

	return existsSync(`${target}.html`);
}

if (!existsSync(PUBLIC)) {
	console.error(`No build to check at ${PUBLIC}. Run: bun run static`);
	process.exit(1);
}

const files = walk(PUBLIC);
const broken: Array<{file: string; href: string}> = [];
let checked = 0;

for (const file of files) {
	const html = readFileSync(file, "utf8");
	for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
		const href = match[1];
		if (
			/^(https?:|mailto:|data:|#|\/\/)/.test(href) ||
			href.startsWith("javascript:")
		) {
			continue;
		}
		checked++;
		if (!resolves(href, file)) {
			broken.push({file: file.slice(PUBLIC.length), href});
		}
	}
}

if (broken.length > 0) {
	console.error(`${broken.length} broken link(s):\n`);
	for (const {file, href} of broken) {
		console.error(`  ${file} -> ${href}`);
	}
	process.exit(1);
}

console.log(
	`${checked} internal links across ${files.length} pages, all resolved.`,
);
