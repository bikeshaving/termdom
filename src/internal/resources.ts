/**
 * Loading what a document's markup asks for: an <img>'s source now,
 * stylesheets and the rest later. Each load is a plain Request, which
 * a TermDOM hands to its "request" listeners as a RequestEvent, with
 * what asked for it. A listener answers with respondWith(), as a
 * Service Worker answers a fetch event. A request no listener answers
 * goes to the `fetch` the TermDOM was made with, and without one it
 * fails: nothing loads unless the program says so.
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
		this[kExtensions].push(Promise.resolve(promise));
	}
}

/** How a document's loads are answered, set by the TermDOM that owns it. */
export type ResourceLoader = (
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

/**
 * Dispatch the request to `target`'s listeners and settle it: their
 * answer, else `fallback`, else a network error. As in a browser, a
 * document that is not a file loads no file.
 */
export function answerRequest(
	target: EventTarget,
	documentURL: string,
	request: Request,
	context: RequestContext,
	fallback: ((request: Request) => Promise<Response>) | undefined,
): Promise<Response> {
	if (
		new URL(request.url).protocol === "file:" &&
		!/^(?:file|about):/.test(documentURL)
	) {
		return Promise.reject(
			new TypeError("A document that is not a file cannot load a file"),
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
	if (fallback !== undefined) {
		return fallback(request);
	}
	return Promise.reject(
		new TypeError("Nothing answered the request, and no fetch was given"),
	);
}
