// Svelte's stock client runtime, rendering into the terminal's document. The
// component is compiled at runtime, so no build step stands between the file
// and `node`.
//
//   node examples/hello-svelte.ts
//
//   any key  increments the counter
//   q        quit
//
// Svelte's package exports resolve the client runtime under the `browser`
// condition, and the server entry's mount() throws, so the process re-execs
// itself with --conditions=browser when it was started without it.
import {spawnSync} from "node:child_process";

if (!import.meta.resolve("svelte").endsWith("index-client.js")) {
	const {status} = spawnSync(
		process.execPath,
		["--conditions=browser", ...process.argv.slice(1)],
		{stdio: "inherit"},
	);
	process.exit(status ?? 0);
}

const {TermDOM} = await import("@b9g/termdom");
const {compile} = await import("svelte/compiler");
const {mount} = await import("svelte");

const SOURCE = `
<script>
	let {quit} = $props();
	let count = $state(0);

	$effect(() => {
		const onkeydown = (ev) => {
			if (ev.key === "q") {
				quit();
				return;
			}

			count++;
		};

		document.addEventListener("keydown", onkeydown);
		return () => document.removeEventListener("keydown", onkeydown);
	});
</script>

<div class="card">
	<div class="greeting">Hello from Svelte!</div>
	<div class="count">Keys pressed: {count}</div>
</div>
<div class="hint">any key counts · [q]uit</div>
`;

// The compiler emits bare imports of Svelte's own runtime. Resolving them to
// absolute URLs lets the component load from memory, with no file written
// beside this one.
const {js} = compile(SOURCE, {generate: "client", name: "Hello"});
const code = js.code.replace(
	/(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g,
	(match, keyword, quote, specifier) =>
		/^[./]|^\w+:/.test(specifier)
			? match
			: `${keyword}${quote}${import.meta.resolve(specifier)}${quote}`,
);
const {default: Hello} = await import(
	`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const term = new TermDOM();
term.attach();
const {document} = term;
// init_operations() takes the `firstChild` and `nextSibling` getters off
// `Node.prototype` and caches lookups on `Element.prototype` and
// `Text.prototype`; `Comment` identifies the anchor nodes the compiler emits.
globalThis.document = document as never;
globalThis.window = term.window as never;
globalThis.Node = term.window.Node;
globalThis.Element = term.window.Element as never;
globalThis.Text = term.window.Text as never;
globalThis.Comment = term.window.Comment as never;

const style = document.createElement("style");
style.textContent = `
	.card { border: 1px solid #5fafff; padding: 0 1ch; margin: 1px 2ch; }
	.greeting { color: cyan; font-weight: bold; }
	.count { color: #ffd75f; }
	.hint { color: #666666; margin-left: 2ch; }
`;
document.head.appendChild(style);

mount(Hello, {
	target: document.body as never,
	props: {quit: () => term.window.close()},
});
