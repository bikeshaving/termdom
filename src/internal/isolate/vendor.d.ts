declare module "core-js-pure/actual/atob.js" {
	const atob: (data: string) => string;
	export default atob;
}

declare module "core-js-pure/actual/btoa.js" {
	const btoa: (data: string) => string;
	export default btoa;
}

declare module "core-js-pure/actual/structured-clone.js" {
	const structuredClone: <T>(
		value: T,
		options?: StructuredSerializeOptions,
	) => T;
	export default structuredClone;
}

declare module "core-js-pure/actual/url/index.js" {
	const URL: typeof globalThis.URL;
	export default URL;
}

declare module "core-js-pure/actual/url-search-params/index.js" {
	const URLSearchParams: typeof globalThis.URLSearchParams;
	export default URLSearchParams;
}
