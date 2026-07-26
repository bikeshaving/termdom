/**
 * Workaround for https://github.com/bikeshaving/libuild/issues/11: libuild
 * relocates internal declarations to dist/internal/ but its generated `files`
 * whitelist only matches flat patterns, so npm pack would exclude the very
 * .d.ts files index.d.ts re-exports from. Append the directory until the fix
 * lands upstream, then delete this script.
 */
const path = new URL("../dist/package.json", import.meta.url).pathname;
const pkg = JSON.parse(await Bun.file(path).text());
if (Array.isArray(pkg.files) && !pkg.files.includes("internal/")) {
	pkg.files.push("internal/");
	await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
	console.log("postbuild: added internal/ to dist package files");
}
