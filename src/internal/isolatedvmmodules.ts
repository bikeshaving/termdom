/**
 * Module scripts in an isolated frame: specifiers resolved through the
 * page's import maps, sources loaded through the page, and each module
 * compiled once in the frame's isolate and linked in order.
 */
import type ivm from "isolated-vm";

import type {FrameRequest, FrameResponse} from "./isolate/host.ts";

const JAVASCRIPT = /^(text|application)\/(x-)?(java|ecma)script$/;
const RELATIVE = /^(\.{0,2}\/)/;
const ISOLATE_REFERRER = "<isolated-vm>";

type SpecifierMap = Map<string, string | null>;

interface ImportMap {
	imports: SpecifierMap;
	scopes: Map<string, SpecifierMap>;
}

function parseURL(value: string, base?: string): string | null {
	try {
		return new URL(value, base).href;
	} catch (error) {
		if (!(error instanceof TypeError)) {
			throw error;
		}

		return null;
	}
}

function parseURLLike(specifier: string, base: string): string | null {
	return RELATIVE.test(specifier)
		? parseURL(specifier, base)
		: parseURL(specifier);
}

function parseSpecifierMap(value: unknown, base: string): SpecifierMap {
	const map: SpecifierMap = new Map();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return map;
	}

	for (const [key, address] of Object.entries(value)) {
		if (key === "") {
			continue;
		}

		const url = typeof address === "string"
			? parseURLLike(address, base)
			: null;
		map.set(
			parseURLLike(key, base) ?? key,
			url !== null && key.endsWith("/") && !url.endsWith("/") ? null : url,
		);
	}

	return map;
}

function matchSpecifier(
	specifier: string,
	map: SpecifierMap,
): string | null | undefined {
	if (map.has(specifier)) {
		return map.get(specifier);
	}

	let best: string | undefined;
	for (const key of map.keys()) {
		if (
			key.endsWith("/") &&
			specifier.startsWith(key) &&
			(best === undefined || key.length > best.length)
		) {
			best = key;
		}
	}

	if (best === undefined) {
		return undefined;
	}

	const address = map.get(best);
	return address == null
		? null
		: parseURL(specifier.slice(best.length), address);
}

export interface ModuleHost {
	isolate: ivm.Isolate;
	context(): ivm.Context;
	baseURL(): string;
	timeout(): number;
	fetch(request: FrameRequest): Promise<FrameResponse>;
}

export class ModuleLoader {
	readonly host: ModuleHost;
	readonly modules: Map<string, Promise<ivm.Module>>;
	readonly ready: Map<string, Promise<ivm.Module>>;
	readonly urls: WeakMap<ivm.Module, string>;
	readonly importMap: ImportMap;
	linking: Promise<void>;

	constructor(host: ModuleHost) {
		this.host = host;
		this.modules = new Map();
		this.ready = new Map();
		this.urls = new WeakMap();
		this.importMap = {imports: new Map(), scopes: new Map()};
		this.linking = Promise.resolve();
	}

	addImportMap(text: string, base: string): void {
		const value = JSON.parse(text) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeError("An import map must be a JSON object");
		}

		const {imports, scopes} = value as {imports?: unknown; scopes?: unknown};
		for (const [key, url] of parseSpecifierMap(imports, base)) {
			if (!this.importMap.imports.has(key)) {
				this.importMap.imports.set(key, url);
			}
		}

		if (typeof scopes !== "object" || scopes === null) {
			return;
		}

		for (const [prefix, map] of Object.entries(scopes)) {
			const scope = parseURL(prefix, base);
			if (scope === null) {
				continue;
			}

			const existing = this.importMap.scopes.get(scope) ?? new Map();
			for (const [key, url] of parseSpecifierMap(map, base)) {
				if (!existing.has(key)) {
					existing.set(key, url);
				}
			}

			this.importMap.scopes.set(scope, existing);
		}
	}

	resolve(specifier: string, referrer: string): string {
		const base = referrer === ISOLATE_REFERRER || referrer === ""
			? this.host.baseURL()
			: referrer;
		const url = parseURLLike(specifier, base);
		const key = url ?? specifier;
		const scopes = [...this.importMap.scopes]
			.filter(([scope]) =>
				scope === base || (scope.endsWith("/") && base.startsWith(scope)))
			.sort(([a], [b]) => b.length - a.length);
		for (const map of [
			...scopes.map(([, map]) => map),
			this.importMap.imports,
		]) {
			const match = matchSpecifier(key, map);
			if (match === null) {
				throw new TypeError(
					`Failed to resolve module specifier "${specifier}": the import map blocks it`,
				);
			}

			if (match !== undefined) {
				return match;
			}
		}

		if (url === null) {
			throw new TypeError(
				`Failed to resolve module specifier "${specifier}": a bare specifier must be in the page's import map`,
			);
		}

		return url;
	}

	fetchModule(url: string): Promise<ivm.Module> {
		let module = this.modules.get(url);
		if (module === undefined) {
			module = this.compile(url);
			this.modules.set(url, module);
		}

		return module;
	}

	async compile(url: string): Promise<ivm.Module> {
		const response = await this.host.fetch({
			url,
			method: "GET",
			headers: [["accept", "*/*"]],
			body: null,
			redirect: "follow",
			destination: "script",
			referrer: "",
		});
		if (response.status < 200 || response.status > 299) {
			throw new TypeError(`Failed to load module ${url}: ${response.status}`);
		}

		const type =
			response.headers.find(([name]) => name === "content-type")?.[1];
		const essence = (type ?? "").split(";")[0].trim().toLowerCase();
		if (!JAVASCRIPT.test(essence)) {
			throw new TypeError(
				`Failed to load module ${url}: "${essence || "no type"}" is not a JavaScript MIME type`,
			);
		}

		const final = response.url || url;
		const module = await this.host.isolate.compileModule(
			new TextDecoder().decode(response.body ?? new Uint8Array()),
			{
				filename: final,
				meta: (meta: {url?: string}) => {
					meta.url = final;
				},
			},
		);
		this.urls.set(module, response.url || url);
		return module;
	}

	import(specifier: string, referrer: string): Promise<ivm.Module> {
		const url = this.resolve(specifier, referrer);
		let module = this.ready.get(url);
		if (module === undefined) {
			module = this.link(url);
			this.ready.set(url, module);
		}

		return module;
	}

	async importSource(
		source: string,
		url: string,
		base: string,
	): Promise<ivm.Module> {
		const module = await this.host.isolate.compileModule(source, {
			filename: url,
			meta: (meta: {url?: string}) => {
				meta.url = base;
			},
		});
		this.urls.set(module, url);
		this.modules.set(url, Promise.resolve(module));
		return this.link(url);
	}

	async link(url: string): Promise<ivm.Module> {
		const module = await this.fetchModule(url);
		const previous = this.linking;
		let done!: () => void;
		this.linking = new Promise((resolve) => (done = resolve));
		try {
			await previous;
			await module.instantiate(this.host.context(), (specifier, referrer) =>
				this.fetchModule(
					this.resolve(specifier, this.urls.get(referrer) ?? ""),
				),
			);
		} finally {
			done();
		}

		await module.evaluate(
			{timeout: this.host.timeout(), promise: true} as ivm.ScriptRunOptions,
		);
		return module;
	}
}
