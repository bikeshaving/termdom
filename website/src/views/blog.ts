import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";
import {Marked} from "@b9g/crankdown";
import {NotFound} from "@b9g/http-errors";

import {Root} from "../components/root.js";
import {Sidebar, Main} from "../components/sidebar.js";
import {components} from "../components/marked-components.js";
import {collectDocuments} from "../models/document.js";
import type {DocInfo} from "../models/document.js";
import {castGifs} from "../server.js";

/**
 * Posts live in `content/blog/` as `YYYY-MM-DD-slug.md`. The date prefix
 * orders the files and is stripped from the URL, so a post is `/blog/slug/`.
 * The date shown is the one in the front matter.
 */
export async function collectPosts(): Promise<DocInfo[]> {
	const contentDir = await self.directories.open("content");
	let blogDir: FileSystemDirectoryHandle;
	try {
		blogDir = await contentDir.getDirectoryHandle("blog");
	} catch {
		return [];
	}
	const docs = await collectDocuments(blogDir, "blog");
	return docs.filter((doc) => doc.attributes.publish).reverse();
}

function formatDate(date: string | Date | undefined): string {
	if (date == null) {
		return "";
	}
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) {
		return String(date);
	}
	return parsed.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

function PostDate({date}: {date: string | Date | undefined}) {
	const text = formatDate(date);
	if (!text) {
		return null;
	}
	const iso = new Date(date!).toISOString().slice(0, 10);
	return jsx`
		<time datetime=${iso} class=${css`
			color: var(--muted-color);
		`}>${text}</time>
	`;
}

export async function BlogIndexView({url}: {url: string}) {
	const posts = await collectPosts();

	return jsx`
		<${Root} title="TermDOM | Blog" url=${url} description="News and notes about TermDOM.">
			<${Sidebar} docs=${posts} url=${url} title="Blog" />
			<${Main}>
				<h1>Blog</h1>
				${posts.length === 0
					? jsx`<p>Nothing here yet.</p>`
					: posts.map(
							(post) => jsx`
								<article class=${css`
									margin: 0 0 2lh;
									max-width: 80ch;
								`}>
									<h2 class=${css`
										margin: 0;
									`}>
										<a href=${post.url}>${post.attributes.title}</a>
									</h2>
									<${PostDate} date=${post.attributes.date} />
									${post.attributes.description
										? jsx`<p class=${css`margin: 0;`}>${post.attributes.description}</p>`
										: null}
								</article>
							`,
						)}
			<//Main>
		<//Root>
	`;
}

export async function BlogPostView({url}: {url: string}) {
	const posts = await collectPosts();
	const post = posts.find(
		(d) => d.url.replace(/\/$/, "") === url.replace(/\/$/, ""),
	);
	if (!post) {
		throw new NotFound(`Post not found: ${url}`);
	}

	const {
		attributes: {title, description, date},
		body,
		filename,
	} = post;
	const casts = castGifs;

	return jsx`
		<${Root} title="TermDOM | ${title}" url=${url} description=${description}>
			<${Sidebar} docs=${posts} url=${url} title="Blog" />
			<${Main}>
				<h1 class=${css`margin-bottom: 0;`}>${title}</h1>
				<p><${PostDate} date=${date} /></p>
				<${Marked}
					markdown=${body}
					components=${components}
					basePath="blog"
					casts=${casts}
				/>
				<div class=${css`
					margin-top: 1lh;
					padding-top: 2lh;
					background: var(--rule) top 0.5lh center / 100% 1px no-repeat;
					color: var(--muted-color);
				`}>
					<a href=${`https://github.com/bikeshaving/termdom/edit/main/website/content/${filename}`}>
						Edit this page on GitHub
					</a>
				</div>
			<//Main>
		<//Root>
	`;
}
