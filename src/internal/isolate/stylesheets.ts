import {reportError} from "./console.ts";
import {fetch, Request, setDestination} from "./fetch.ts";

const URL_TOKEN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const IMPORT_STRING = /@import\s+(['"])([^'"]+)\1/g;

function absolutize(css: string, base: string): string {
	const resolve = (url: string): string => {
		if (/^(data:|#)/i.test(url)) {
			return url;
		}

		try {
			return new URL(url, base).href;
		} catch (error) {
			if (!(error instanceof TypeError)) {
				throw error;
			}

			return url;
		}
	};
	return css
		.replace(URL_TOKEN, (_, quote: string, url: string) =>
			`url(${quote}${resolve(url)}${quote})`)
		.replace(IMPORT_STRING, (_, quote: string, url: string) =>
			`@import ${quote}${resolve(url)}${quote}`);
}

function isStylesheetLink(element: Element): boolean {
	if (element.localName !== "link" || element.hasAttribute("disabled")) {
		return false;
	}

	const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
	return rel.includes("stylesheet") && !rel.includes("alternate");
}

export function loadStylesheets(document: Document): Promise<void> {
	const seen = new WeakSet<Element>();
	const fetchSheet =
		async (link: Element): Promise<HTMLStyleElement | null> => {
			seen.add(link);
			const href = (link as HTMLLinkElement).href;
			if (!href) {
				return null;
			}

			const request = new Request(href);
			setDestination(request, "style");
			const response = await fetch(request);
			if (!response.ok) {
				throw new Error(`${href} answered ${response.status}`);
			}

			const style = document.createElement("style");
			const media = link.getAttribute("media");
			if (media) {
				style.setAttribute("media", media);
			}

			style.textContent = absolutize(
				await response.text(),
				response.url || href,
			);
			return style;
		};
	const place = (link: Element, style: HTMLStyleElement | null): void => {
		if (style !== null && link.isConnected) {
			link.after(style);
		}
	};
	const load = (link: Element): void => {
		fetchSheet(link).then((style) => place(link, style), reportError);
	};
	const scan = (root: ParentNode): void => {
		for (const link of root.querySelectorAll("link")) {
			if (!seen.has(link) && isStylesheetLink(link)) {
				load(link);
			}
		}
	};

	const initial = [...document.querySelectorAll("link")]
		.filter(isStylesheetLink);
	const sheets = initial.map((link) =>
		fetchSheet(link).catch((error: unknown) => {
			reportError(error);
			return null;
		}),
	);
	const view = document.defaultView as unknown as {
		MutationObserver: typeof MutationObserver;
	};
	new view.MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) {
					continue;
				}

				const element = node as Element;
				if (!seen.has(element) && isStylesheetLink(element)) {
					load(element);
				} else {
					scan(element);
				}
			}
		}
	}).observe(document, {childList: true, subtree: true});
	return Promise.all(sheets).then((styles) => {
		styles.forEach((style, i) => place(initial[i], style));
	});
}
