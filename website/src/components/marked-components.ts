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
