import {jsx} from "@b9g/crank/standalone";

import {CodeBlock} from "./code-block.js";
import {CastPlayer} from "./cast-player.js";

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

	/** `![caption](cast:name)` embeds a recording via the casts map the
	 * view passes as a prop on Marked. */
	image({token, rootProps}: any) {
		const {href, text} = token;
		const cast = href?.startsWith("cast:") && rootProps.casts?.[href.slice(5)];
		if (cast) {
			return jsx`<${CastPlayer}
				src=${cast.src}
				rows=${cast.rows}
				cols=${cast.cols}
				caption=${text}
			/>`;
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
