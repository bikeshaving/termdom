import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";
import {Marked} from "@b9g/crankdown";
import {NotFound} from "@b9g/http-errors";

import {Root} from "../components/root.js";
import {Sidebar, Main} from "../components/sidebar.js";
import {components} from "../components/marked-components.js";
import {collectDocuments} from "../models/document.js";

export default async function Guide({url}: {url: string}) {
	const docsDir = await self.directories.open("docs");
	const guidesDir = await docsDir.getDirectoryHandle("guides");
	const docs = await collectDocuments(guidesDir, "guides");

	const doc = docs.find(
		(d) => d.url.replace(/\/$/, "") === url.replace(/\/$/, ""),
	);
	if (!doc) {
		throw new NotFound(`Guide not found: ${url}`);
	}

	const {
		attributes: {title, description},
		body,
		filename,
	} = doc;

	return jsx`
		<${Root} title="TermDOM | ${title}" url=${url} description=${description}>
			<${Sidebar} docs=${docs} url=${url} title="Guides" />
			<${Main}>
				<h1>${title}</h1>
				<${Marked} markdown=${body} components=${components} basePath="guides" />
				<div class=${css`
					margin-top: 3rem;
					padding-top: 1.5rem;
					border-top: 1px solid var(--border-color);
					font-size: 0.85rem;
				`}>
					<a href=${`https://github.com/bikeshaving/termdom/edit/main/docs/${filename}`}>
						Edit this page on GitHub
					</a>
				</div>
			<//Main>
		<//Root>
	`;
}
