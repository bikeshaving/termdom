import {Response, setFetcher, setResponseURL} from "./fetch.ts";
import {type FrameResponse, host} from "./host.ts";

interface Pending {
	resolve(response: Response): void;
	reject(error: unknown): void;
	release(): void;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const pending = new Map<number, Pending>();
let nextId = 1;

export function installNetwork(): void {
	setFetcher(async (request) => {
		const body = request.method === "GET" || request.method === "HEAD"
			? null
			: new Uint8Array(await request.arrayBuffer());
		request.signal.throwIfAborted();
		return new Promise<Response>((resolve, reject) => {
			const id = nextId++;
			const signal = request.signal;
			const onAbort = (): void => {
				if (pending.delete(id)) {
					host.post({type: "abortFetch", id});
					reject(signal.reason);
				}
			};
			pending.set(id, {
				resolve,
				reject,
				release() {
					signal.removeEventListener("abort", onAbort);
				},
			});
			signal.addEventListener("abort", onAbort, {once: true});
			host.post({
				type: "fetch",
				id,
				request: {
					url: request.url,
					method: request.method,
					headers: [...request.headers],
					body,
					redirect: request.redirect,
					destination: request.destination,
					referrer: request.referrer,
				},
			});
		});
	});
}

export function deliverResponse(id: number, response: FrameResponse): void {
	const entry = pending.get(id);
	if (entry === undefined) {
		return;
	}

	pending.delete(id);
	entry.release();
	try {
		const result = new Response(
			NULL_BODY_STATUSES.has(response.status) ? null : response.body,
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
		setResponseURL(result, response.url, response.redirected);
		entry.resolve(result);
	} catch (error) {
		entry.reject(new TypeError(`Failed to fetch: ${String(error)}`));
	}
}

export function deliverError(id: number, message: string): void {
	const entry = pending.get(id);
	if (entry === undefined) {
		return;
	}

	pending.delete(id);
	entry.release();
	entry.reject(new TypeError(`Failed to fetch: ${message}`));
}
