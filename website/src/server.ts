import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/html";
import {Router} from "@b9g/router";
import {trailingSlash} from "@b9g/router/middleware";
import {assets as assetsMiddleware} from "@b9g/assets/middleware";

import {collectDocuments} from "./models/document.js";

import HomeView from "./views/home.js";
import GuideView from "./views/guide.js";
import SupportView from "./views/support.js";
import PlaygroundView from "./views/playground.js";
import NotFoundView from "./views/not-found.js";

// Asset imports. Shovel bundles each one and hands back a content-hashed URL,
// so nothing here is a hardcoded path.
import clientCSS from "./styles/client.css" with {assetBase: "/static/"};
// The player's stylesheet ships as a real <link>: a dynamic import() of a
// .css file bundles to a no-op module, which left the player unstyled --
// giant raw SVG controls and a collapsed terminal box.
import navbarScript from "./clients/navbar.ts" with {assetBase: "/static/"};
import searchScript from "./clients/search.ts" with {assetBase: "/static/"};
import playgroundScript from "./clients/playground.ts" with {assetBase: "/static/"};
// What the sandbox iframe's import map resolves bare specifiers to:
// "@b9g/termdom" is the engine, "node:fs" and "node:path" are the in-memory
// filesystem. Programs in the playground import them as written.
import sandboxTermdomScript from "./clients/sandbox-termdom.ts" with {assetBase: "/static/"};
import virtualFSScript from "./models/virtual-fs.ts" with {assetBase: "/static/"};
import sandboxNodeModuleScript from "./clients/sandbox-node-module.ts" with {assetBase: "/static/"};
// The terminal emulator's own stylesheet, linked from the playground alone.
import xtermCSS from "@xterm/xterm/css/xterm.css" with {assetBase: "/static/"};
import favicon from "../static/favicon.ico" with {assetBase: "/", assetName: "favicon.ico"};
import logo from "../static/logo.svg" with {assetBase: "/static/", assetName: "[name].[ext]"};

// A recorded terminal session, rendered to GIF so it plays in any browser
// with no client JavaScript. Solitaire is the one program the site shows
// this way: every other figure is the program itself, running in the page.
import solitaireGif from "../static/casts/solitaire.gif" with {assetBase: "/static/", assetName: "[name].[ext]"};

export const assets = {
	clientCSS,
	navbarScript,
	searchScript,
	playgroundScript,
	sandboxTermdomScript,
	virtualFSScript,
	sandboxNodeModuleScript,
	xtermCSS,
	favicon,
	logo,
};

export const castGifs: Record<string, string> = {
	solitaire: solitaireGif,
};

const SITE = "https://termdom.org";

const router = new Router();

router.use(trailingSlash("append"));
router.use(assetsMiddleware());

/**
 * Render a view to a response. Every URL carries its trailing slash, because
 * GitHub Pages serves `path/index.html` for `path/` and a link written
 * without the slash costs a redirect.
 */
async function renderView(
	View: any,
	url: string,
	params: Record<string, string> = {},
): Promise<Response> {
	if (!url.endsWith("/")) {
		url = url + "/";
	}

	const html = await renderer.render(jsx`
		<${View} url=${url} params=${params} />
	`);

	return new Response(html, {headers: {"Content-Type": "text/html"}});
}

router
	.route("/")
	.get(async (request) => renderView(HomeView, new URL(request.url).pathname));

router
	.route("/guides/:slug/")
	.get(async (request, context) =>
		renderView(GuideView, new URL(request.url).pathname, context.params),
	);

router
	.route("/playground/")
	.get(async (request) =>
		renderView(PlaygroundView, new URL(request.url).pathname),
	);

router
	.route("/compatibility/")
	.get(async (request) =>
		renderView(SupportView, new URL(request.url).pathname),
	);

router.route("/pagefind/:path*").get(async (request) => {
	const url = new URL(request.url);
	const path = url.pathname.replace("/pagefind/", "");
	try {
		const pagefindDir = await self.directories.open("pagefind");
		const parts = path.split("/");
		let dir = pagefindDir;
		for (let i = 0; i < parts.length - 1; i++) {
			dir = await dir.getDirectoryHandle(parts[i]);
		}
		const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
		const file = await fileHandle.getFile();
		return new Response(await file.arrayBuffer(), {
			headers: {"Content-Type": contentTypeFor(path)},
		});
	} catch {
		return new Response("Not found", {status: 404});
	}
});

const robotsTxt = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

router.route("/robots.txt").get(async () => {
	return new Response(robotsTxt, {headers: {"Content-Type": "text/plain"}});
});

router.route("/sitemap.xml").get(async () => {
	return new Response(await generateSitemap(), {
		headers: {"Content-Type": "application/xml"},
	});
});

// The catch-all has to be registered last, or it swallows everything above it.
router.route("*").all(async (request) => {
	const response = await renderView(
		NotFoundView,
		new URL(request.url).pathname,
	);
	return new Response(await response.text(), {
		status: 404,
		headers: {"Content-Type": "text/html"},
	});
});

self.addEventListener("fetch", (event: any) => {
	event.respondWith(router.handle(event.request));
});

self.addEventListener("install", (event: any) => {
	event.waitUntil(generateStaticSite());
});

function contentTypeFor(path: string): string {
	if (path.endsWith(".js")) return "text/javascript";
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".css")) return "text/css";
	if (path.endsWith(".wasm")) return "application/wasm";
	return "application/octet-stream";
}

async function guideURLs(): Promise<string[]> {
	const docsDir = await self.directories.open("docs");
	const guidesDir = await docsDir.getDirectoryHandle("guides");
	const docs = await collectDocuments(guidesDir, "guides");
	return docs.filter((doc) => doc.attributes.publish).map((doc) => doc.url);
}

async function allRoutes(): Promise<string[]> {
	return ["/", "/playground/", "/compatibility/", ...(await guideURLs())];
}

async function generateSitemap(): Promise<string> {
	const routes = await allRoutes();
	const urls = routes
		.map((route) => `\t<url>\n\t\t<loc>${SITE}${route}</loc>\n\t</url>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * Static generation: the worker fetches its own routes and writes the
 * responses out as files. One code path serves development and produces the
 * build, so the deployed site is the site you were just looking at.
 */
async function generateStaticSite(): Promise<void> {
	if (import.meta.env.MODE !== "production") {
		return;
	}

	const publicDir = await self.directories.open("public");

	const write = async (filePath: string, content: string): Promise<void> => {
		const parts = filePath.split("/");
		let dir = publicDir;
		for (let i = 0; i < parts.length - 1; i++) {
			dir = await dir.getDirectoryHandle(parts[i], {create: true});
		}
		const fileHandle = await dir.getFileHandle(parts[parts.length - 1], {
			create: true,
		});
		const writable = await fileHandle.createWritable();
		await writable.write(content);
		await writable.close();
	};

	for (const route of await allRoutes()) {
		const response = await fetch(route);
		if (!response.ok) {
			continue;
		}
		const filePath =
			route === "/" ? "index.html" : `${route.slice(1)}index.html`;
		await write(filePath, await response.text());
	}

	// GitHub Pages serves 404.html for anything it cannot find.
	const notFound = await fetch("/this-path-does-not-exist/");
	await write("404.html", await notFound.text());

	await write("robots.txt", robotsTxt);
	await write("sitemap.xml", await generateSitemap());
}
