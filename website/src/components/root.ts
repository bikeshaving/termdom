import {jsx, Raw} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank/standalone";
import {extractCritical} from "@emotion/server";

import {assets} from "../server.js";
import {Navbar} from "./navbar.js";
import {Footer} from "./footer.js";
import {getColorSchemeScript} from "../utils/color-scheme.js";

const SITE = "https://termdom.org";

/**
 * The color scheme has to be settled before the first paint, or the page
 * flashes the wrong one. That means an inline, non-module script: a module
 * script is deferred by definition, which is exactly what we cannot have.
 */
function ColorSchemeScript() {
	const scriptText = `(() => { ${getColorSchemeScript()} })()`;
	return jsx`<script><${Raw} value=${scriptText} /></script>`;
}

export interface RootProps {
	title: string;
	url: string;
	description?: string;
	/** Stylesheets this page needs and no other does. */
	stylesheets?: string[];
	/** Module scripts this page needs and no other does. */
	scripts?: string[];
	children: unknown;
	/** A page that fills the window has nothing under it. */
	footer?: boolean;
}

/**
 * The HTML document.
 *
 * Renders in two passes: the first yield produces the body HTML, Emotion
 * extracts only the rules that body actually used, and the second yield emits
 * the document with those rules inlined. So a page ships its own CSS and
 * nobody's stylesheet blocks anybody's paint.
 */
export function* Root(
	this: Context,
	{
		title,
		url,
		description = "",
		stylesheets = [],
		scripts = [],
		children,
	}: RootProps,
) {
	for ({
		title,
		url,
		description = "",
		stylesheets = [],
		scripts = [],
		children,
		footer = true,
	} of this) {
		this.schedule(() => this.refresh());
		const childrenHTML: string = yield jsx`
			<div id="navbar-root">
				<${Navbar} url=${url} />
			</div>
			${children}
			${footer ? jsx`<${Footer} />` : null}
		`;

		const {html, css} = extractCritical(childrenHTML);
		yield jsx`
			<${Raw} value="<!DOCTYPE html>" />
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>${title}</title>
					<link rel="shortcut icon" href=${assets.favicon} />
					<style><${Raw} value=${css} /></style>
					<link rel="stylesheet" type="text/css" href=${assets.clientCSS} />
					${stylesheets.map(
						(href) => jsx`
							<link rel="stylesheet" type="text/css" href=${href} />
						`,
					)}
					<meta name="description" content=${description} />
					<meta property="og:type" content="website" />
					<meta property="og:title" content=${title} />
					<meta property="og:description" content=${description} />
					<meta property="og:url" content=${`${SITE}${url}`} />
					<meta property="og:image" content=${`${SITE}${assets.logo}`} />
					<meta name="twitter:card" content="summary" />
					<meta name="twitter:title" content=${title} />
					<meta name="twitter:description" content=${description} />
					<script type="application/ld+json">
						<${Raw}
							value=${JSON.stringify({
								"@context": "https://schema.org",
								"@type": "SoftwareSourceCode",
								name: "TermDOM",
								description:
									"TermDOM is a JavaScript library that displays HTML and CSS in the terminal. It draws actual DOM nodes to terminal output and redraws the screen when they mutate.",
								url: SITE,
								codeRepository: "https://github.com/bikeshaving/termdom",
								programmingLanguage: "TypeScript",
								license: "https://opensource.org/licenses/MIT",
							})}
						/>
					</script>
				</head>
				<body>
					<${ColorSchemeScript} />
					<${Raw} value=${html} />
					<script type="module" src=${assets.navbarScript}></script>
					<script type="module" src=${assets.searchScript}></script>
					${scripts.map(
						(src) => jsx`<script type="module" src=${src}></script>`,
					)}
				</body>
			</html>
		`;
	}
}
