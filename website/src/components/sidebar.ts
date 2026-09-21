import {jsx} from "@b9g/crank/standalone";
import type {Element} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import type {DocInfo} from "../models/document.js";
import {Search} from "./search.js";

export function Sidebar({
	docs,
	title,
	url,
}: {
	docs: DocInfo[];
	url: string;
	title: string;
}) {
	const links: Element[] = [];
	for (const doc of docs) {
		if (doc.attributes.publish) {
			links.push(jsx`
				<div>
					<a
						href=${doc.url}
						aria-current=${doc.url === url && "page"}
						class=${css`
							text-decoration: none;
							color: var(--text-color);

							&:hover,
							&[aria-current="page"] {
								color: var(--highlight-color);
							}
						`}
					>${doc.attributes.title}</a>
				</div>
			`);
		}
	}

	return jsx`
		<div id="sidebar" class=${css`
			margin-top: var(--bar-height);
			padding: 1lh 2ch 1lh;
			color: var(--text-color);
			background: var(--rule) bottom 0.5lh center / 100% 1px no-repeat var(--bg-color);

			@media screen and (min-width: 800px) {
				position: fixed;
				top: var(--bar-height);
				bottom: 0;
				overflow-x: hidden;
				overflow-y: auto;
				width: 28ch;
				margin: 0;
				padding: 1lh 2ch 1lh 2ch;
				text-align: right;
				background: var(--rule) right 0.5ch center / 1px 100% no-repeat var(--bg-color);
			}

			@media screen and (min-width: 1100px) {
				padding: 2lh 4ch 2lh 4ch;
				width: 36ch;
			}

			> :first-child {
				margin-top: 0;
			}
		`}>
			<h2 class=${css`
				color: var(--highlight-color);
				margin: 0 0 1lh;
			`}>${title}</h2>
			<div id="search-root">
				<${Search} />
			</div>
			${links}
		</div>
	`;
}

export function Main({children}: {children: unknown}) {
	return jsx`
		<main data-pagefind-body class=${css`
			margin: 0 auto;
			padding: 1lh 2ch;
			min-height: calc(100vh - var(--bar-height));

			@media screen and (min-width: 800px) {
				margin-left: 28ch;
				padding: 1lh 2ch;
				margin-top: var(--bar-height);
			}

			@media screen and (min-width: 1100px) {
				margin-left: 36ch;
				padding: 2lh 4ch;
			}

			p,
			ul,
			ol {
				max-width: 80ch;
			}
		`}>
			${children}
		</main>
	`;
}
