/**
 * Loading what a document's markup asks for, such as an <img>'s
 * source. Each load is a plain Request, which
 * a TermDOM hands to its "request" listeners as a RequestEvent, with
 * what asked for it. A listener answers with respondWith(), as a
 * Service Worker answers a fetch event. A request no listener answers
 * goes to the `fetch` the TermDOM was made with, and without one it
 * fails: nothing loads unless the program says so. Only a document that
 * is itself a file: URL loads file: URLs.
 */

/** What a RequestEvent carries besides the request itself. */
export interface RequestContext {
	// The Fetch standard's request destination: "image" for an <img>.
	destination: RequestDestination;
	// Resource Timing's initiator type: "img" for an <img>.
	initiatorType: string;
	// The element that asked, or null.
	initiator: Element | null;
}

export interface RequestEventInit extends EventInit, Partial<RequestContext> {
	request: Request;
}

const kResponse = Symbol("response");
const kDispatching = Symbol("dispatching");
const kExtensions = Symbol("extensions");

export interface RequestEvent {
	[kResponse]: Promise<Response> | null;
	[kDispatching]: boolean;
	[kExtensions]: Array<Promise<unknown>>;
}

/**
 * A load a document's markup asks for. A listener that answers it calls
 * respondWith() before it returns, and the first answer wins.
 */
export class RequestEvent extends Event {
	readonly request: Request;
	readonly destination: RequestDestination;
	readonly initiatorType: string;
	readonly initiator: Element | null;

	constructor(type: string, init: RequestEventInit) {
		super(type, init);
		this.request = init.request;
		this.destination = init.destination ?? "";
		this.initiatorType = init.initiatorType ?? "other";
		this.initiator = init.initiator ?? null;
		this[kResponse] = null;
		this[kDispatching] = false;
		this[kExtensions] = [];
	}

	/**
	 * Answer the request, during the event. Response.error(), or a
	 * promise that rejects, fails it as a network error does.
	 */
	respondWith(response: Response | PromiseLike<Response>): void {
		if (!this[kDispatching]) {
			throw new DOMException(
				"respondWith() is only called while the event is dispatched",
				"InvalidStateError",
			);
		}
		if (this[kResponse] !== null) {
			throw new DOMException(
				"The request was already answered",
				"InvalidStateError",
			);
		}
		this[kResponse] = Promise.resolve(response);
		this.stopImmediatePropagation();
	}

	/** Work the listener goes on with after it answers. */
	waitUntil(promise: PromiseLike<unknown>): void {
		// Nothing waits on it, so a rejection must not go unhandled.
		this[kExtensions].push(Promise.resolve(promise).catch(() => {}));
	}
}

/** How a document's loads are answered, set by the TermDOM that owns it. */
type ResourceLoader = (
	request: Request,
	context: RequestContext,
) => Promise<Response>;

const loaders = new WeakMap<object, ResourceLoader>();

export function setResourceLoader(
	document: object,
	loader: ResourceLoader,
): void {
	loaders.set(document, loader);
}

/**
 * The response to a load the document's markup asks for. A document no
 * TermDOM owns, such as DOMParser's, loads nothing.
 */
export function loadResource(
	document: object,
	request: Request,
	context: RequestContext,
): Promise<Response> {
	const loader = loaders.get(document);
	if (loader === undefined) {
		return Promise.reject(new TypeError("This document loads nothing"));
	}
	return loader(request, context);
}

/** What a TermDOM decides a document's loads by. */
export interface RequestPolicy {
	// The program's policy, or the default that allows nothing. A page's
	// own meta tags are read with each request and can only narrow it.
	policies: readonly ContentSecurityPolicy[];
	// Where an allowed request no listener answers goes.
	fetch: (request: Request) => Promise<Response>;
	// Tells of a load a policy blocked.
	violate(at: EventTarget, init: SecurityPolicyViolationEventInit): void;
}

/**
 * Settle a load the document's markup asks for. The document's policies
 * decide whether it may be made at all. One allowed goes to `target`'s
 * "request" listeners, and to `policy.fetch` when none answers. As in a
 * browser, a document that is not a file loads no file, about:blank
 * included.
 */
export function answerRequest(
	target: EventTarget,
	document: Document,
	request: Request,
	context: RequestContext,
	policy: RequestPolicy,
): Promise<Response> {
	const url = new URL(request.url);
	const self = new URL(document.URL);
	if (url.protocol === "file:" && self.protocol !== "file:") {
		return Promise.reject(
			new TypeError("A document that is not a file cannot load a file"),
		);
	}
	const blocked = getBlockingDirective([
		...policy.policies,
		...getDocumentPolicies(document),
	], url, context.destination, self);
	if (blocked !== null) {
		const at = context.initiator?.isConnected ? context.initiator : document;
		policy.violate(at, {
			documentURI: document.URL,
			blockedURI: request.url,
			effectiveDirective: blocked.directive,
			originalPolicy: blocked.policy.text,
			disposition: "enforce",
			bubbles: true,
			composed: true,
		});
		return Promise.reject(
			new TypeError(
				`The Content Security Policy directive "${blocked.directive}" ` +
				`blocked ${request.url}`,
			),
		);
	}
	const event = new RequestEvent("request", {request, ...context});
	event[kDispatching] = true;
	try {
		target.dispatchEvent(event);
	} finally {
		event[kDispatching] = false;
	}
	const answer = event[kResponse];
	if (answer !== null) {
		return answer.then((response) => {
			if (response.type === "error") {
				throw new TypeError("The request was refused");
			}
			return response;
		});
	}
	return policy.fetch(request);
}

// A policy a page states for itself in its head (HTML §4.2.5.3), which a
// load must also satisfy.
function getDocumentPolicies(document: Document): ContentSecurityPolicy[] {
	const head = document.head;
	if (head === null) {
		return [];
	}
	const policies: ContentSecurityPolicy[] = [];
	for (const meta of head.children) {
		if (
			meta.localName === "meta" &&
			meta.getAttribute("http-equiv")?.toLowerCase() ===
				"content-security-policy" &&
			meta.hasAttribute("content")
		) {
			policies.push(
				...parseContentSecurityPolicies(meta.getAttribute("content")!),
			);
		}
	}
	return policies;
}

// ---------------------------------------------------------------------------
// Content Security Policy (CSP3): which loads a document may make.

/** One parsed policy: each directive's source expressions, by name. */
export interface ContentSecurityPolicy {
	text: string;
	directives: Map<string, string[]>;
}

/**
 * A serialized policy list, as a header or a meta tag carries it: policies
 * separated by commas, directives by semicolons (CSP3 §2.2.1). A directive
 * named twice keeps its first value.
 */
export function parseContentSecurityPolicies(
	serialized: string,
): ContentSecurityPolicy[] {
	const policies: ContentSecurityPolicy[] = [];
	for (const text of serialized.split(",")) {
		const directives = new Map<string, string[]>();
		for (const token of text.split(";")) {
			const [name, ...values] = token.trim().split(/[\t\n\f\r ]+/);
			if (!name || !/^[a-zA-Z0-9-]+$/.test(name)) {
				continue;
			}
			const key = name.toLowerCase();
			if (!directives.has(key)) {
				directives.set(key, values.filter(Boolean));
			}
		}
		policies.push({text: text.trim(), directives});
	}
	return policies;
}

// The directive that governs a destination, and the one it falls back to.
const FETCH_DIRECTIVES: Partial<Record<RequestDestination, string>> = {
	image: "img-src",
	style: "style-src",
	font: "font-src",
	audio: "media-src",
	video: "media-src",
	track: "media-src",
};

/** The directive a policy enforces for a load, or null when none applies. */
function getEffectiveDirective(
	policy: ContentSecurityPolicy,
	destination: RequestDestination,
): string | null {
	const directive = FETCH_DIRECTIVES[destination];
	if (directive !== undefined && policy.directives.has(directive)) {
		return directive;
	}
	return policy.directives.has("default-src") ? "default-src" : null;
}

/**
 * The first policy and directive that block a load of `url` for
 * `destination`, from a document at `self`, or null when every policy
 * allows it.
 */
export function getBlockingDirective(
	policies: readonly ContentSecurityPolicy[],
	url: URL,
	destination: RequestDestination,
	self: URL,
): {policy: ContentSecurityPolicy; directive: string} | null {
	for (const policy of policies) {
		const directive = getEffectiveDirective(policy, destination);
		if (
			directive !== null &&
			!matchesSourceList(policy.directives.get(directive)!, url, self)
		) {
			return {policy, directive};
		}
	}
	return null;
}

// CSP3 §6.7.2.6. An empty list, or one that is just 'none', matches nothing.
function matchesSourceList(sources: string[], url: URL, self: URL): boolean {
	return sources.some((source) => matchesSource(source, url, self));
}

const NETWORK_SCHEMES = new Set(["http", "https", "ws", "wss"]);

const SCHEME_SOURCE = /^([a-zA-Z][a-zA-Z0-9+.-]*):$/;
const HOST_SOURCE =
	/^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)(?::(\*|\d+))?(\/[^?#]*)?$/;

function matchesSource(source: string, url: URL, self: URL): boolean {
	const scheme = url.protocol.slice(0, -1);
	const selfScheme = self.protocol.slice(0, -1);
	const lower = source.toLowerCase();
	if (lower === "'self'") {
		return matchesSelf(url, self);
	}
	// Keywords, nonces and hashes govern scripts and styles, never a load.
	if (lower.startsWith("'")) {
		return false;
	}
	// A network scheme, or the document's own (§6.7.2.7, step 1).
	if (lower === "*") {
		return NETWORK_SCHEMES.has(scheme) || scheme === selfScheme;
	}
	const schemeSource = SCHEME_SOURCE.exec(source);
	if (schemeSource !== null) {
		return schemePartMatches(schemeSource[1].toLowerCase(), scheme);
	}
	const hostSource = HOST_SOURCE.exec(source);
	if (hostSource === null || url.host === "") {
		return false;
	}
	const [, sourceScheme, host, port, path] = hostSource;
	// Without a scheme, the document's own (§6.7.2.7, step 4). A document
	// not served over the network, as about:blank and file: are not, has no
	// network scheme to lend, so its host sources mean the network ones.
	if (sourceScheme !== undefined) {
		if (!schemePartMatches(sourceScheme.toLowerCase(), scheme)) {
			return false;
		}
	} else if (
		!schemePartMatches(selfScheme, scheme) &&
		!(!NETWORK_SCHEMES.has(selfScheme) && NETWORK_SCHEMES.has(scheme))
	) {
		return false;
	}
	if (!hostPartMatches(host.toLowerCase(), url.hostname.toLowerCase())) {
		return false;
	}
	if (!portPartMatches(port, url)) {
		return false;
	}
	return path === undefined || path === "/" || pathPartMatches(path, url);
}

// §6.7.2.8: a scheme matches itself, and its secure counterpart.
function schemePartMatches(expression: string, scheme: string): boolean {
	return (
		expression === scheme ||
		(expression === "http" && scheme === "https") ||
		(expression === "ws" && (scheme === "wss" || scheme === "https")) ||
		(expression === "wss" && scheme === "https")
	);
}

// §6.7.2.9: `*.example.com` matches a subdomain, never example.com.
function hostPartMatches(expression: string, host: string): boolean {
	if (expression === "*") {
		return true;
	}
	if (expression.startsWith("*.")) {
		return host.endsWith(expression.slice(1));
	}
	return expression === host;
}

const DEFAULT_PORTS: Record<string, string> = {
	http: "80",
	https: "443",
	ws: "80",
	wss: "443",
};

// §6.7.2.10: no port means the scheme's default, which the URL parser
// leaves empty. Port 80 also matches 443, an upgrade to https.
function portPartMatches(port: string | undefined, url: URL): boolean {
	if (port === "*") {
		return true;
	}
	if (port === undefined) {
		return url.port === "";
	}
	const scheme = url.protocol.slice(0, -1);
	const urlPort = url.port === "" ? DEFAULT_PORTS[scheme] : url.port;
	return port === urlPort || (port === "80" && urlPort === "443");
}

// §6.7.2.11: a path ending in a slash matches what is under it, and any
// other the one resource it names.
function pathPartMatches(path: string, url: URL): boolean {
	const expression = decodeURIComponent(path);
	const target = decodeURIComponent(url.pathname);
	return expression.endsWith("/")
		? target.startsWith(expression)
		: target === expression;
}

// §6.7.2.6: the document's own origin, or its upgrade to https or wss.
function matchesSelf(url: URL, self: URL): boolean {
	if (self.origin === "null" || url.origin === "null") {
		return false;
	}
	if (url.origin === self.origin) {
		return true;
	}
	return (
		url.hostname === self.hostname &&
		((self.protocol === "http:" &&
			(url.protocol === "https:" || url.protocol === "wss:")) ||
			(self.protocol === "ws:" && url.protocol === "wss:")) &&
		(url.port === self.port || url.port === "")
	);
}
