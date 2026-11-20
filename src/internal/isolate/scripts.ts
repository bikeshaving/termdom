import {host} from "./host.ts";

const CLASSIC_TYPES = new Set([
	"",
	"text/javascript",
	"application/javascript",
	"application/ecmascript",
	"text/ecmascript",
	"application/x-javascript",
	"text/jscript",
]);

export interface ScriptItem {
	id: number;
	kind: "classic" | "module" | "importmap";
	src: string | null;
	text: string | null;
	async: boolean;
}

interface WindowLike {
	Event: new (type: string, init?: EventInit) => Event;
	dispatchEvent(event: Event): boolean;
	MutationObserver: typeof MutationObserver;
}

export class ScriptRunner {
	readonly document: Document;
	readonly elements: Map<number, HTMLScriptElement>;
	readonly seen: WeakSet<Element>;
	nextId: number;
	current: HTMLScriptElement | null;
	readyState: DocumentReadyState;

	constructor(document: Document) {
		this.document = document;
		this.elements = new Map();
		this.seen = new WeakSet();
		this.nextId = 1;
		this.current = null;
		this.readyState = "loading";
		Object.defineProperty(document, "currentScript", {
			get: () => this.current,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(document, "readyState", {
			get: () => this.readyState,
			configurable: true,
			enumerable: true,
		});
	}

	collect(root: ParentNode | Element): ScriptItem[] {
		const found: HTMLScriptElement[] = [];
		if ((root as Element).localName === "script") {
			found.push(root as HTMLScriptElement);
		}

		for (const script of root.querySelectorAll("script")) {
			found.push(script);
		}

		const items: ScriptItem[] = [];
		for (const script of found) {
			if (this.seen.has(script) || !script.isConnected) {
				continue;
			}

			this.seen.add(script);
			const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
			const kind = type === "module"
				? "module"
				: type === "importmap"
					? "importmap"
					: CLASSIC_TYPES.has(type) && !script.hasAttribute("nomodule")
						? "classic"
						: null;
			if (kind === null) {
				continue;
			}

			const id = this.nextId++;
			const src = script.hasAttribute("src") && kind !== "importmap"
				? script.src
				: null;
			if (src !== null || kind === "classic") {
				this.elements.set(id, script);
			}

			items.push({
				id,
				kind,
				src,
				text: src === null ? script.text : null,
				async:
					kind !== "importmap" &&
					(src !== null || kind === "module") &&
					script.hasAttribute("async"),
			});
		}

		return items;
	}

	start(): void {
		const view = this.document.defaultView as unknown as WindowLike;
		host.scripts(true, this.collect(this.document));
		new view.MutationObserver((records) => {
			const items: ScriptItem[] = [];
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node.nodeType === 1) {
						items.push(...this.collect(node as Element));
					}
				}
			}

			if (items.length > 0) {
				host.scripts(false, items);
			}
		}).observe(this.document, {childList: true, subtree: true});
	}

	begin(id: number): void {
		this.current = this.elements.get(id) ?? null;
	}

	end(id: number): void {
		this.current = null;
		if (this.elements.get(id)?.hasAttribute("src") === false) {
			this.elements.delete(id);
		}
	}

	finished(id: number, ok: boolean): void {
		const script = this.elements.get(id);
		this.elements.delete(id);
		const view = this.document.defaultView as unknown as WindowLike;
		script?.dispatchEvent(new view.Event(ok ? "load" : "error"));
	}

	interactive(): void {
		const view = this.document.defaultView as unknown as WindowLike;
		this.readyState = "interactive";
		this.document.dispatchEvent(new view.Event("readystatechange"));
		this.document.dispatchEvent(
			new view.Event("DOMContentLoaded", {bubbles: true}),
		);
	}

	loaded(): void {
		const view = this.document.defaultView as unknown as WindowLike;
		this.readyState = "complete";
		this.document.dispatchEvent(new view.Event("readystatechange"));
		view.dispatchEvent(new view.Event("load"));
	}
}
