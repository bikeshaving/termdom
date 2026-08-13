import {jsx} from "@b9g/crank/standalone";

import {CodeBlock} from "./code-block.js";

/**
 * Overrides for the markdown renderer.
 *
 * Only two token types need our opinion: fenced code, which gets highlighted
 * at build time, and links, so that `.md` hrefs written for someone reading
 * the files on GitHub resolve to site URLs here.
 */
export const components = {
	code({token}: any) {
		const {text, lang} = token;
		return jsx`<${CodeBlock} code=${text} lang=${lang || "ts"} />`;
	},

	/**
	 * `![caption](cast:name)` embeds a recording and `![caption](playground:id)`
	 * embeds a live one, both through maps the view passes as props on Marked.
	 *
	 * A playground embed renders as the program, highlighted here at build
	 * time. That is what a reader without JavaScript gets, and what everyone
	 * sees until the instance scrolls into view and the client puts an editor
	 * and a terminal in its place.
	 */
	image({token, rootProps}: any) {
		const {href, text} = token;
		const gif = href?.startsWith("cast:") && rootProps.casts?.[href.slice(5)];
		if (gif) {
			return jsx`<figure class="cast"><img src=${gif} alt=${text} loading="lazy" /></figure>`;
		}

		const example =
			href?.startsWith("playground:") &&
			rootProps.playgrounds?.[href.slice("playground:".length)];
		if (example) {
			return jsx`
				<figure class="playground" data-playground=${example.id} aria-label=${text}>
					<${CodeBlock} code=${example.code} lang="js" />
				</figure>
			`;
		}

		return jsx`<img src=${href} alt=${text} />`;
	},

	link({token, rootProps, children}: any) {
		const {href, title} = token;
		const resolved =
			href && href.endsWith(".md") && rootProps.basePath
				? resolveMarkdownHref(href, rootProps.basePath)
				: href;
		return jsx`<a href=${resolved} title=${title}>${children}</a>`;
	},
};

/** `../guides/02-styling.md` -> `/guides/styling/`, same rules as the loader. */
function resolveMarkdownHref(href: string, basePath: string): string {
	const segments = basePath.split("/").filter(Boolean);
	const parts = href.split("/");
	const rest: string[] = [];

	for (const part of parts) {
		if (part === "..") {
			segments.pop();
		} else if (part !== "." && part !== "") {
			rest.push(part);
		}
	}

	const filename = rest
		.join("/")
		.replace(/\.md$/, "")
		.replace(/([0-9]+-)+/, "")
		.replace(/\/index$/, "");

	return `/${[...segments, filename].filter(Boolean).join("/")}/`;
}
