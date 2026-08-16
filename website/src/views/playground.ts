import {jsx, Raw} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";
import {assets} from "../server.js";
import {
	collectExamples,
	serializeExamples,
	EXAMPLES_SCRIPT_ID,
	SANDBOX_CONFIG_ID,
} from "../models/playground-examples.js";

/**
 * The page is a mount point and nothing else. Every other view on this site
 * renders to HTML at build time and needs no JavaScript to read; this one is
 * an editor and a terminal emulator, so it is rendered on the client or not
 * at all.
 *
 * The programs travel with the page as JSON: they are read out of the
 * repository's `examples/` directory here, at build time, so the client bundle
 * carries no copy of them.
 */
export default async function Playground({url}: {url: string}) {
	const examples = await collectExamples(
		await self.directories.open("examples"),
	);

	return jsx`
		<${Root}
			title="TermDOM | Playground"
			url=${url}
			description="Edit HTML, CSS and JavaScript and watch TermDOM render it to a terminal, live in your browser."
			stylesheets=${[assets.xtermCSS]}
			scripts=${[assets.playgroundScript]}
		>
			<script type="application/json" id=${EXAMPLES_SCRIPT_ID}>
				<${Raw} value=${serializeExamples(examples)} />
			</script>
			<script type="application/json" id=${SANDBOX_CONFIG_ID}>
				<${Raw} value=${JSON.stringify({termdom: assets.sandboxTermdomScript, nodefs: assets.virtualFSScript, nodeModule: assets.sandboxNodeModuleScript})} />
			</script>
			<div id="playground">
				<noscript class=${css`
					display: block;
					max-width: 1200px;
					margin: 0 auto;
					padding: 5rem 1.2rem 2rem;
				`}>
					The playground needs JavaScript: it runs the library, an editor and a
					terminal emulator in this page.
				</noscript>
			</div>
		<//Root>
	`;
}
