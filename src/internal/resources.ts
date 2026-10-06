/**
 * Loading what a document's markup asks for, such as an <img>'s source,
 * in the order Fetch takes a browser's loads. The document's Content
 * Security Policy decides whether a load may be made at all. One it
 * allows goes to the TermDOM's "fetch" listeners as a FetchEvent, which
 * answer it as a Service Worker does, and to the network when none does.
 * Each redirect is checked against the policy again and followed on the
 * network. Only a document that is itself a file: URL loads file: URLs.
 */

const kExtend = Symbol("extend");
const kPending = Symbol("pending");

export interface ExtendableEvent {
	// Where waitUntil()'s promises go: the TermDOM that dispatched the
	// event. Null for an event a program made, which nothing waits on.
	[kExtend]: ((promise: Promise<unknown>) => void) | null;
	[kPending]: number;
}

/** An event whose listeners can ask the TermDOM to wait for their work. */
export class ExtendableEvent extends Event {
	constructor(type: string, init?: EventInit) {
		super(type, init);
		this[kExtend] = null;
		this[kPending] = 0;
	}

	/** Keeps the TermDOM's dispose() waiting until `promise` settles. */
	waitUntil(promise: PromiseLike<unknown>): void {
		const lifetime = Promise.resolve(promise);
		addLifetimePromise(this, lifetime);
		this[kExtend]!(lifetime);
	}
}

// Service Workers §4.4.1: an event is active while it is dispatched, or
// while a promise it was given is pending.
function addLifetimePromise(
	event: ExtendableEvent,
	promise: Promise<unknown>,
): void {
	if (event[kExtend] === null) {
		throw new DOMException(
			"Only an event TermDOM dispatches can be extended",
			"InvalidStateError",
		);
	}
	if (event.eventPhase === Event.NONE && event[kPending] === 0) {
		throw new DOMException(
			"The event is no longer active",
			"InvalidStateError",
		);
	}
	event[kPending]++;
	const settled = () => {
		queueMicrotask(() => event[kPending]--);
	};
	promise.then(settled, settled);
}

export interface FetchEventInit extends EventInit {
	request: Request;
	preloadResponse?: Promise<unknown>;
	clientId?: string;
	resultingClientId?: string;
	replacesClientId?: string;
	handled?: Promise<undefined>;
}

const kResponse = Symbol("response");

export interface FetchEvent {
	[kResponse]: Promise<Response> | null;
}

/**
 * A load the document's markup asks for, dispatched at the TermDOM as a
 * Service Worker's fetch event is at its global scope. A listener answers
 * it with respondWith(), which stops the other listeners. One that calls
 * preventDefault() without answering fails the load.
 */
export class FetchEvent extends ExtendableEvent {
	readonly request: Request;
	readonly preloadResponse: Promise<unknown>;
	readonly clientId: string;
	readonly resultingClientId: string;
	readonly replacesClientId: string;
	// Settles once the load is answered: rejects with a NetworkError when
	// it fails.
	readonly handled: Promise<undefined>;

	constructor(type: string, init: FetchEventInit) {
		super(type, init);
		this.request = init.request;
		this.preloadResponse = init.preloadResponse ?? Promise.resolve(undefined);
		this.clientId = init.clientId ?? "";
		this.resultingClientId = init.resultingClientId ?? "";
		this.replacesClientId = init.replacesClientId ?? "";
		this.handled = init.handled ?? new Promise<undefined>(() => {});
		this[kResponse] = null;
	}

	/**
	 * Answer the request, during the event. Response.error(), a promise
	 * that rejects, or a value that is not a Response fails it as a
	 * network error does.
	 */
	respondWith(response: Response | PromiseLike<Response>): void {
		if (this.eventPhase === Event.NONE) {
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
		const answer = Promise.resolve(response);
		addLifetimePromise(this, answer);
		this.stopImmediatePropagation();
		this[kResponse] = answer.then((value) => {
			if (!(value instanceof Response)) {
				throw new TypeError("respondWith() takes a Response");
			}
			return value;
		});
	}
}

/**
 * Gives a request its Fetch destination, such as "image", which a
 * runtime's Request leaves empty.
 */
export function setRequestDestination(
	request: Request,
	destination: RequestDestination,
): void {
	Object.defineProperty(request, "destination", {
		value: destination,
		enumerable: true,
		configurable: true,
	});
}

/** What a load knows of what asked for it. */
export interface RequestContext {
	// The element that asked, where a policy violation is reported.
	initiator: Element | null;
}

/** How a document's loads are answered, set by the TermDOM that owns it. */
type ResourceLoader = (
	request: Request,
	context: RequestContext,
) => Promise<Response>;

const loaders = new WeakMap<
	object,
	{loader: ResourceLoader; signal: AbortSignal}
>();

/** `signal` aborts when the TermDOM that owns the document is disposed. */
export function setResourceLoader(
	document: object,
	loader: ResourceLoader,
	signal: AbortSignal,
): void {
	loaders.set(document, {loader, signal});
}

/**
 * Aborts when the document's loads end for good, or null for a document
 * no TermDOM owns.
 */
export function getLoadSignal(document: object): AbortSignal | null {
	return loaders.get(document)?.signal ?? null;
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
	const entry = loaders.get(document);
	if (entry === undefined) {
		return Promise.reject(new TypeError("This document loads nothing"));
	}
	return entry.loader(request, context);
}

/** What a TermDOM decides a document's loads by. */
export interface RequestPolicy {
	// The program's policy, or the default that allows nothing. A page's
	// own meta tags are read with each request and can only narrow it.
	policies: readonly ContentSecurityPolicy[];
	// Tells of a load a policy blocked.
	violate(at: EventTarget, init: SecurityPolicyViolationEventInit): void;
	// Takes the work a listener asked the TermDOM to wait for.
	extend(promise: Promise<unknown>): void;
	// Aborted when the TermDOM is disposed, after which nothing loads.
	signal: AbortSignal;
}

const REDIRECT_LIMIT = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Settle a load the document's markup asks for: checked against the
 * document's policies, offered to `target`'s "fetch" listeners, and sent
 * to the network when none answers. A redirect, from a listener or the
 * network, is checked again and followed on the network, as Fetch follows
 * one without its Service Worker.
 */
export async function answerRequest(
	target: EventTarget,
	document: Document,
	request: Request,
	context: RequestContext,
	policy: RequestPolicy,
): Promise<Response> {
	policy.signal.throwIfAborted();
	const destination = request.destination;
	checkRequest(document, request, new URL(request.url), 0, context, policy);
	let response = await dispatchFetchEvent(target, request, policy);
	if (response === null) {
		response = await fetch(new Request(request, {redirect: "manual"}));
	} else if (response.url !== "" && response.url !== request.url) {
		// A listener's response that came from somewhere, such as its own
		// fetch(event.request), is checked where it ended up, as Fetch checks
		// a Service Worker's response against the page's policy.
		const final = new URL(response.url);
		try {
			if (response.redirected) {
				checkRedirectScheme(request, final);
			}
			checkRequest(
				document,
				request,
				final,
				response.redirected ? 1 : 0,
				context,
				policy,
			);
		} catch (error) {
			await response.body?.cancel().catch(() => {});
			throw error;
		}
	}
	let current = new URL(response.url || request.url);
	for (let redirects = 1; isRedirect(response); redirects++) {
		await response.body?.cancel().catch(() => {});
		if (request.redirect !== "follow") {
			throw new TypeError(`${request.url} redirects`);
		}
		if (redirects > REDIRECT_LIMIT) {
			throw new TypeError(`${request.url} redirects too many times`);
		}
		current = new URL(response.headers.get("location")!, current);
		checkRedirectScheme(request, current);
		checkRequest(document, request, current, redirects, context, policy);
		const next = new Request(current, {
			headers: request.headers,
			signal: request.signal,
			redirect: "manual",
		});
		setRequestDestination(next, destination);
		response = await fetch(next);
	}
	if (response.type === "error") {
		throw new TypeError("The request was refused");
	}
	return response;
}

// Fetch's "HTTP-redirect fetch": a redirect goes only to another HTTP(S)
// URL, never to a file, data: or anything the network does not serve.
function checkRedirectScheme(request: Request, url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError(
			`${request.url} redirects to a URL that is not HTTP(S)`,
		);
	}
}

function isRedirect(response: Response): boolean {
	return REDIRECT_STATUSES.has(response.status) &&
		response.headers.has("location");
}

// Fetch's "should request be blocked", for the request's URL or a URL it
// was redirected to. As in a browser, a document that is not a file loads
// no file, about:blank included.
function checkRequest(
	document: Document,
	request: Request,
	url: URL,
	redirects: number,
	context: RequestContext,
	policy: RequestPolicy,
): void {
	const self = new URL(document.URL);
	if (url.protocol === "file:" && self.protocol !== "file:") {
		throw new TypeError("A document that is not a file cannot load a file");
	}
	const blocked = getBlockingDirective([
		...policy.policies,
		...getDocumentPolicies(document),
	], url, request.destination, self, redirects);
	if (blocked === null) {
		return;
	}
	const at = context.initiator?.isConnected ? context.initiator : document;
	// The URL the document asked for, never where it was redirected
	// (CSP3 §2.4.2), and only as much of it as a report may carry.
	policy.violate(at, {
		documentURI: stripURLForReport(new URL(document.URL)),
		blockedURI: stripURLForReport(new URL(request.url)),
		effectiveDirective: blocked.directive,
		originalPolicy: blocked.policy.text,
		disposition: "enforce",
		bubbles: true,
		composed: true,
	});
	throw new TypeError(
		`The Content Security Policy directive "${blocked.directive}" ` +
		`blocked ${stripURLForReport(new URL(request.url))}`,
	);
}

// CSP3 §5.4: a URL that is not HTTP(S) reports as its scheme alone, and
// one that is reports without its fragment and credentials.
function stripURLForReport(url: URL): string {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return url.protocol.slice(0, -1);
	}
	const stripped = new URL(url);
	stripped.hash = "";
	stripped.username = "";
	stripped.password = "";
	return stripped.href;
}

// Service Workers' Handle Fetch, as far as a page's load needs it: the
// listener's response, or null when none answered and the load goes to
// the network.
async function dispatchFetchEvent(
	target: EventTarget,
	request: Request,
	policy: RequestPolicy,
): Promise<Response | null> {
	let resolveHandled!: () => void;
	let rejectHandled!: (error: DOMException) => void;
	const handled = new Promise<undefined>((resolve, reject) => {
		resolveHandled = () => resolve(undefined);
		rejectHandled = reject;
	});
	handled.catch(() => {});
	const event = new FetchEvent("fetch", {request, handled, cancelable: true});
	event[kExtend] = (promise) => {
		policy.extend(promise);
	};
	target.dispatchEvent(event);
	const answer = event[kResponse];
	if (answer === null) {
		if (event.defaultPrevented) {
			rejectHandled(new DOMException("The load was canceled", "NetworkError"));
			throw new TypeError("A fetch listener canceled the load");
		}
		resolveHandled();
		return null;
	}
	try {
		const response = await whileNotAborted(answer, request.signal);
		resolveHandled();
		return response;
	} catch (error) {
		rejectHandled(new DOMException("The load failed", "NetworkError"));
		throw error;
	}
}

// An answer still pending when its request is aborted, by a new source or
// the TermDOM's disposal, ends the load then, as Fetch ends a fetch
// whatever its Service Worker is doing.
function whileNotAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, {once: true});
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}

// The policies a page stated for itself with <meta> in its head.
const documentPolicies = new WeakMap<object, ContentSecurityPolicy[]>();

/**
 * A `<meta http-equiv="Content-Security-Policy">` inserted as a child of
 * a head (HTML §4.2.5.3): its policy holds for the document from then on,
 * whatever later becomes of the element. A meta policy cannot report,
 * frame or sandbox, so those directives are dropped.
 */
export function addDocumentPolicy(document: object, content: string): void {
	const policy = parseContentSecurityPolicy(content);
	for (const directive of ["report-uri", "frame-ancestors", "sandbox"]) {
		policy.directives.delete(directive);
	}
	const policies = documentPolicies.get(document);
	if (policies === undefined) {
		documentPolicies.set(document, [policy]);
	} else {
		policies.push(policy);
	}
}

function getDocumentPolicies(document: object): ContentSecurityPolicy[] {
	return documentPolicies.get(document) ?? [];
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
	return serialized.split(",").map(parseContentSecurityPolicy);
}

/** One serialized policy, as a meta tag carries it (CSP3 §2.2.1). */
function parseContentSecurityPolicy(text: string): ContentSecurityPolicy {
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
	return {text: text.trim(), directives};
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
 * allows it. `redirects` counts the redirects that led to `url`.
 */
export function getBlockingDirective(
	policies: readonly ContentSecurityPolicy[],
	url: URL,
	destination: RequestDestination,
	self: URL,
	redirects = 0,
): {policy: ContentSecurityPolicy; directive: string} | null {
	for (const policy of policies) {
		const directive = getEffectiveDirective(policy, destination);
		if (
			directive !== null &&
			!matchesSourceList(
				policy.directives.get(directive)!,
				url,
				self,
				redirects,
			)
		) {
			return {policy, directive};
		}
	}
	return null;
}

// CSP3 §6.7.2.6. An empty list, or one that is just 'none', matches nothing.
function matchesSourceList(
	sources: string[],
	url: URL,
	self: URL,
	redirects: number,
): boolean {
	return sources.some((source) => matchesSource(source, url, self, redirects));
}

const NETWORK_SCHEMES = new Set(["http", "https", "ws", "wss"]);

const SCHEME_SOURCE = /^([a-zA-Z][a-zA-Z0-9+.-]*):$/;
const HOST_SOURCE =
	/^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)(?::(\*|\d+))?(\/[^?#]*)?$/;

function matchesSource(
	source: string,
	url: URL,
	self: URL,
	redirects: number,
): boolean {
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
	// A redirect's target is matched without its path, which would tell
	// the page where a cross-origin redirect went (§6.7.2.5).
	return path === undefined || redirects > 0 || pathPartMatches(path, url);
}

// §6.7.2.8: a scheme matches itself and its secure counterpart, and ws
// matches the http schemes too.
function schemePartMatches(expression: string, scheme: string): boolean {
	return (
		expression === scheme ||
		(expression === "http" && scheme === "https") ||
		(expression === "ws" &&
			(scheme === "wss" || scheme === "http" || scheme === "https")) ||
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
// other the one resource it names, compared piece by piece once each
// piece is percent-decoded.
function pathPartMatches(path: string, url: URL): boolean {
	if (path === "" || (path === "/" && url.pathname === "")) {
		return true;
	}
	const exact = !path.endsWith("/");
	const expected = path.split("/");
	const actual = url.pathname.split("/");
	if (expected.length > actual.length) {
		return false;
	}
	if (exact && expected.length !== actual.length) {
		return false;
	}
	if (!exact) {
		expected.pop();
	}
	return expected.every((piece, i) =>
		percentDecode(piece) === percentDecode(actual[i]),
	);
}

// The URL Standard's percent-decode, which leaves a malformed sequence as
// it is, comparing as bytes.
function percentDecode(text: string): string {
	const bytes = String.fromCharCode(...new TextEncoder().encode(text));
	return bytes.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
		String.fromCharCode(parseInt(hex, 16)),
	);
}

// §6.7.2.7: the document's own origin, or the same host and port, over
// https or wss, or over http or ws from an http document. The URL parser
// leaves a scheme's default port empty, so two defaults compare equal.
function matchesSelf(url: URL, self: URL): boolean {
	if (self.origin === "null" || url.origin === "null") {
		return false;
	}
	if (url.origin === self.origin) {
		return true;
	}
	const scheme = url.protocol.slice(0, -1);
	const selfScheme = self.protocol.slice(0, -1);
	return (
		url.hostname === self.hostname &&
		url.port === self.port &&
		(scheme === "https" ||
			scheme === "wss" ||
			(selfScheme === "http" && (scheme === "http" || scheme === "ws")))
	);
}
