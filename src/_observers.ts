/**
 * ResizeObserver and IntersectionObserver for the terminal.
 *
 * Both are driven the same way: after every layout, the manager measures each
 * observed element and fires a callback when what it watches has changed. That is
 * exactly the information the layout engine already produces each frame, so these
 * are thin -- they read boxes termdom computed anyway.
 *
 * - ResizeObserver watches an element's content-box size. Its headline use here is
 *   the terminal itself resizing: a component can react through the standard DOM
 *   API instead of listening for SIGWINCH.
 * - IntersectionObserver watches whether an element overlaps the viewport -- the
 *   visible cell grid. A terminal has a discrete, exact viewport, so "on screen"
 *   is a clean integer comparison rather than the approximation a browser makes.
 */

interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * What the manager needs from its host (TermDOM) to measure the world, kept as a
 * tiny interface so the observers do not reach into TermDOM internals.
 */
export interface ObserverHost {
	/** Border-box rect of an element in document coordinates, or null if unlaid. */
	getBorderBox(element: Element): Rect | null;
	/** Content-box size of an element (border box minus padding and border). */
	getContentBox(element: Element): {width: number; height: number} | null;
	/** The visible viewport rect, in the same document coordinates as boxes. */
	getViewportRect(): Rect;
	/** A frame counter, used only to timestamp entries. */
	now(): number;
}

// ---------------------------------------------------------------------------
// ResizeObserver
// ---------------------------------------------------------------------------

interface ResizeObserverSize {
	inlineSize: number;
	blockSize: number;
}

interface ResizeObserverEntry {
	target: Element;
	contentRect: Rect;
	borderBoxSize: readonly ResizeObserverSize[];
	contentBoxSize: readonly ResizeObserverSize[];
	devicePixelContentBoxSize: readonly ResizeObserverSize[];
}

type ResizeObserverCallback = (
	entries: ResizeObserverEntry[],
	observer: ResizeObserver,
) => void;

export class ResizeObserver {
	#callback: ResizeObserverCallback;
	#manager: ObserverManager;
	/** Observed targets and the content-box size we last reported for each. */
	#targets = new Map<Element, {width: number; height: number} | null>();

	constructor(callback: ResizeObserverCallback, manager: ObserverManager) {
		this.#callback = callback;
		this.#manager = manager;
	}

	observe(target: Element): void {
		// A fresh target has no "last size", so its first measurement always counts
		// as a change -- which is what fires the initial callback the DOM promises.
		if (!this.#targets.has(target)) {
			this.#targets.set(target, null);
		}
		this.#manager.register(this);
	}

	unobserve(target: Element): void {
		this.#targets.delete(target);
		if (this.#targets.size === 0) this.#manager.unregister(this);
	}

	disconnect(): void {
		this.#targets.clear();
		this.#manager.unregister(this);
	}

	/** Measure every target and fire once with whatever changed. Manager-only. */
	check(host: ObserverHost): void {
		const entries: ResizeObserverEntry[] = [];

		for (const [target, last] of this.#targets) {
			const content = host.getContentBox(target);
			if (!content) continue;

			if (
				last &&
				last.width === content.width &&
				last.height === content.height
			) {
				continue;
			}
			this.#targets.set(target, {width: content.width, height: content.height});

			const box: ResizeObserverSize = {
				inlineSize: content.width,
				blockSize: content.height,
			};
			const border = host.getBorderBox(target);
			const borderBox: ResizeObserverSize = {
				inlineSize: border?.width ?? content.width,
				blockSize: border?.height ?? content.height,
			};

			entries.push({
				target,
				contentRect: {
					top: 0,
					left: 0,
					width: content.width,
					height: content.height,
				},
				contentBoxSize: [box],
				borderBoxSize: [borderBox],
				devicePixelContentBoxSize: [box],
			});
		}

		if (entries.length > 0) this.#callback(entries, this);
	}
}

// ---------------------------------------------------------------------------
// IntersectionObserver
// ---------------------------------------------------------------------------

interface IntersectionObserverInit {
	root?: Element | null;
	rootMargin?: string;
	threshold?: number | number[];
}

interface IntersectionObserverEntry {
	target: Element;
	isIntersecting: boolean;
	intersectionRatio: number;
	boundingClientRect: Rect;
	intersectionRect: Rect;
	rootBounds: Rect | null;
	time: number;
}

type IntersectionObserverCallback = (
	entries: IntersectionObserverEntry[],
	observer: IntersectionObserver,
) => void;

/** Fraction of `box` that lies within `clip`, from 0 (disjoint) to 1 (contained). */
function intersectionRatio(box: Rect, clip: Rect): {ratio: number; rect: Rect} {
	const left = Math.max(box.left, clip.left);
	const top = Math.max(box.top, clip.top);
	const right = Math.min(box.left + box.width, clip.left + clip.width);
	const bottom = Math.min(box.top + box.height, clip.top + clip.height);

	const width = Math.max(0, right - left);
	const height = Math.max(0, bottom - top);
	const area = box.width * box.height;

	return {
		ratio: area > 0 ? (width * height) / area : width > 0 && height > 0 ? 1 : 0,
		rect: {top, left, width, height},
	};
}

export class IntersectionObserver {
	#callback: IntersectionObserverCallback;
	#manager: ObserverManager;
	#thresholds: number[];
	/** Observed targets and whether they last counted as intersecting. */
	#targets = new Map<Element, boolean | null>();

	constructor(
		callback: IntersectionObserverCallback,
		manager: ObserverManager,
		init: IntersectionObserverInit = {},
	) {
		this.#callback = callback;
		this.#manager = manager;

		// A single number, an array, or the default of "any intersection at all".
		const t = init.threshold ?? 0;
		this.#thresholds = (Array.isArray(t) ? [...t] : [t]).sort((a, b) => a - b);
	}

	observe(target: Element): void {
		if (!this.#targets.has(target)) this.#targets.set(target, null);
		this.#manager.register(this);
	}

	unobserve(target: Element): void {
		this.#targets.delete(target);
		if (this.#targets.size === 0) this.#manager.unregister(this);
	}

	disconnect(): void {
		this.#targets.clear();
		this.#manager.unregister(this);
	}

	/** Whether `ratio` meets any configured threshold. */
	#meets(ratio: number): boolean {
		// Ratio 0 with a 0 threshold means "not intersecting"; any positive overlap
		// against a 0 threshold does. A higher threshold needs that much coverage.
		return this.#thresholds.some((threshold) =>
			threshold === 0 ? ratio > 0 : ratio >= threshold,
		);
	}

	check(host: ObserverHost): void {
		const viewport = host.getViewportRect();
		const entries: IntersectionObserverEntry[] = [];

		for (const [target, wasIntersecting] of this.#targets) {
			const box = host.getBorderBox(target);
			if (!box) continue;

			const {ratio, rect} = intersectionRatio(box, viewport);
			const isIntersecting = this.#meets(ratio);

			// Fire only when the intersecting state flips, matching the callback the
			// DOM delivers (and the initial one, since the last state starts null).
			if (wasIntersecting === isIntersecting) continue;
			this.#targets.set(target, isIntersecting);

			entries.push({
				target,
				isIntersecting,
				intersectionRatio: ratio,
				boundingClientRect: box,
				intersectionRect: isIntersecting
					? rect
					: {top: 0, left: 0, width: 0, height: 0},
				rootBounds: viewport,
				time: host.now(),
			});
		}

		if (entries.length > 0) this.#callback(entries, this);
	}
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Owns the live observers and runs them after each layout.
 *
 * Registration is reference-counted through observe/unobserve/disconnect, so an
 * observer with nothing to watch does no work and holds no memory.
 */
export class ObserverManager {
	#host: ObserverHost;
	#resize = new Set<ResizeObserver>();
	#intersection = new Set<IntersectionObserver>();

	constructor(host: ObserverHost) {
		this.#host = host;
	}

	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
		return new ResizeObserver(callback, this);
	}

	createIntersectionObserver(
		callback: IntersectionObserverCallback,
		init?: IntersectionObserverInit,
	): IntersectionObserver {
		return new IntersectionObserver(callback, this, init);
	}

	register(observer: ResizeObserver | IntersectionObserver): void {
		if (observer instanceof ResizeObserver) this.#resize.add(observer);
		else this.#intersection.add(observer);
	}

	unregister(observer: ResizeObserver | IntersectionObserver): void {
		if (observer instanceof ResizeObserver) this.#resize.delete(observer);
		else this.#intersection.delete(observer);
	}

	/** Run every observer against the current layout. Called after each render. */
	flush(): void {
		if (this.#resize.size === 0 && this.#intersection.size === 0) return;
		for (const observer of this.#resize) observer.check(this.#host);
		for (const observer of this.#intersection) observer.check(this.#host);
	}

	dispose(): void {
		this.#resize.clear();
		this.#intersection.clear();
	}
}
