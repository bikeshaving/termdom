/**
 * ResizeObserver and IntersectionObserver, over the boxes layout has already
 * computed for the frame.
 */

import {type LayoutEngine} from "./layout.js";
import {computedStyleOf, getBoxModel} from "./styles.js";

/**
 * An element's content box: its size, plus the offset of its top-left corner
 * INSIDE the border box -- the padding and border that precede it.
 *
 * Deliberately not a rect. `top`/`left` are a distance from the border edge,
 * not a position in the document, and calling it a DOMRect would invite
 * exactly the arithmetic (comparing it against a border box, intersecting it
 * with the viewport) that its coordinates cannot support. ResizeObserver
 * reports these four numbers as contentRect, which is where the confusion
 * comes from in the first place.
 */
export interface ContentBox {
	width: number;
	height: number;
	top: number;
	left: number;
}

/**
 * The manager's way in. Not #private, because the manager has to call it; not a
 * named method, because author code must never see it.
 */
const kCheck = Symbol("check");
/** Subclass hooks and shared state, symbol-keyed for the same reason. */
const kTargets = Symbol("targets");
const kMeasure = Symbol("measure");
const kDeliver = Symbol("deliver");

/**
 * What the manager needs from its host (TermDOM) to measure the world, kept as a
 * tiny interface so the observers do not reach into TermDOM internals.
 */

/**
 * The half of an observer that is identical between the two: which elements are
 * watched, what was last reported for each, and registration with the manager.
 *
 * Subclasses supply only how to measure one target (#measure) and how to build
 * an entry from that measurement, which is the whole of what differs.
 */
/**
 * ResizeObserver's contentRect: an element's content box, or null when it
 * generates no box at all (display:none or detached) -- reported as "nothing",
 * which the observer turns into an all-zero rect.
 */
function contentBoxOf(
	element: Element,
	layoutEngine: LayoutEngine,
): ContentBox | null {
	if (computedStyleOf(element).computedValueOf("display") === "none") {
		return null;
	}
	const rect = layoutEngine.getRect(element);
	if (!rect) return null;
	const box = getBoxModel(element);
	const width = Math.max(
		0,
		rect.width -
			(box.paddingLeft || 0) -
			(box.paddingRight || 0) -
			(box.borderLeftWidth || 0) -
			(box.borderRightWidth || 0),
	);
	const height = Math.max(
		0,
		rect.height -
			(box.paddingTop || 0) -
			(box.paddingBottom || 0) -
			(box.borderTopWidth || 0) -
			(box.borderBottomWidth || 0),
	);
	// Origin relative to the border box: what precedes the content on each axis.
	return {
		width,
		height,
		top: (box.borderTopWidth || 0) + (box.paddingTop || 0),
		left: (box.borderLeftWidth || 0) + (box.paddingLeft || 0),
	};
}

abstract class LayoutObserver<TState, TEntry> {
	#manager: ObserverManager;
	/** Observed targets, each mapped to what was last reported for it. */
	[kTargets] = new Map<Element, TState | null>();

	constructor(manager: ObserverManager) {
		this.#manager = manager;
	}

	observe(target: Element): void {
		// A fresh target has no last state, so its first measurement always counts
		// as a change -- which is what fires the initial callback the DOM promises.
		if (!this[kTargets].has(target)) {
			this[kTargets].set(target, null);
		}
		this.#manager.register(this as unknown as AnyObserver);
	}

	unobserve(target: Element): void {
		this[kTargets].delete(target);
		if (this[kTargets].size === 0) {
			this.#manager.unregister(this as unknown as AnyObserver);
		}
	}

	disconnect(): void {
		this[kTargets].clear();
		this.#manager.unregister(this as unknown as AnyObserver);
	}

	/**
	 * Records are computed and delivered in the same pass (see the manager's
	 * flush), so nothing is ever queued undelivered and this is always empty.
	 * Present because the DOM has it and code checks for it.
	 */
	takeRecords(): TEntry[] {
		return [];
	}

	/** Measure one target: its new state, and the entry to report, or null. */
	abstract [kMeasure](
		target: Element,
		last: TState | null,
		layoutEngine: LayoutEngine,
		viewport: DOMRect,
		frame: number,
	): {state: TState; entry: TEntry} | null;

	abstract [kDeliver](entries: TEntry[]): void;

	[kCheck](layoutEngine: LayoutEngine, viewport: DOMRect, frame: number): void {
		const entries: TEntry[] = [];
		for (const [target, last] of this[kTargets]) {
			const result = this[kMeasure](
				target,
				last,
				layoutEngine,
				viewport,
				frame,
			);
			if (!result) continue;
			this[kTargets].set(target, result.state);
			entries.push(result.entry);
		}
		if (entries.length > 0) this[kDeliver](entries);
	}
}

type AnyObserver = {
	[kCheck](layoutEngine: LayoutEngine, viewport: DOMRect, frame: number): void;
};

// ---------------------------------------------------------------------------
// ResizeObserver
// ---------------------------------------------------------------------------

interface ResizeObserverSize {
	inlineSize: number;
	blockSize: number;
}

interface ResizeObserverEntry {
	target: Element;
	contentRect: DOMRect;
	borderBoxSize: readonly ResizeObserverSize[];
	contentBoxSize: readonly ResizeObserverSize[];
	devicePixelContentBoxSize: readonly ResizeObserverSize[];
}

type ResizeObserverCallback = (
	entries: ResizeObserverEntry[],
	observer: ResizeObserver,
) => void;

interface ResizeSize {
	width: number;
	height: number;
}

export class ResizeObserver extends LayoutObserver<
	ResizeSize,
	ResizeObserverEntry
> {
	#callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback, manager: ObserverManager) {
		super(manager);
		this.#callback = callback;
	}

	[kMeasure](
		target: Element,
		last: ResizeSize | null,
		layoutEngine: LayoutEngine,
	): {state: ResizeSize; entry: ResizeObserverEntry} | null {
		// An element with no box -- display:none, or detached -- has a size, and
		// that size is zero. Reporting it is how the DOM lets a component notice
		// it has been hidden; skipping it stranded the last size it ever had.
		const content = contentBoxOf(target, layoutEngine) ?? {
			width: 0,
			height: 0,
			top: 0,
			left: 0,
		};

		if (
			last &&
			last.width === content.width &&
			last.height === content.height
		) {
			return null;
		}

		const box: ResizeObserverSize = {
			inlineSize: content.width,
			blockSize: content.height,
		};
		const border = layoutEngine.getRect(target);
		return {
			state: {width: content.width, height: content.height},
			entry: {
				target,
				// Origin is the content box's offset inside the border box -- the
				// padding and border that precede it -- not zero.
				contentRect: layoutEngine.createDOMRect(
					content.left,
					content.top,
					content.width,
					content.height,
				),
				contentBoxSize: [box],
				borderBoxSize: [
					{
						inlineSize: border?.width ?? content.width,
						blockSize: border?.height ?? content.height,
					},
				],
				// A cell is the device pixel here, so these coincide.
				devicePixelContentBoxSize: [box],
			},
		};
	}

	[kDeliver](entries: ResizeObserverEntry[]): void {
		this.#callback(entries, this);
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
	boundingClientRect: DOMRect;
	intersectionRect: DOMRect;
	rootBounds: DOMRect | null;
	time: number;
}

type IntersectionObserverCallback = (
	entries: IntersectionObserverEntry[],
	observer: IntersectionObserver,
) => void;

/** Fraction of `box` that lies within `clip`, from 0 (disjoint) to 1 (contained). */
function intersectionRatio(
	box: DOMRect,
	clip: DOMRect,
	layoutEngine: LayoutEngine,
): {ratio: number; rect: DOMRect} {
	const left = Math.max(box.left, clip.left);
	const top = Math.max(box.top, clip.top);
	const right = Math.min(box.left + box.width, clip.left + clip.width);
	const bottom = Math.min(box.top + box.height, clip.top + clip.height);

	const width = Math.max(0, right - left);
	const height = Math.max(0, bottom - top);
	const area = box.width * box.height;

	return {
		ratio: area > 0 ? (width * height) / area : width > 0 && height > 0 ? 1 : 0,
		rect: layoutEngine.createDOMRect(left, top, width, height),
	};
}

/**
 * Grow (or shrink) a rect by a CSS margin shorthand, per the root-margin rules:
 * one to four lengths, in the order top, right, bottom, left.
 *
 * Lengths are cells, whichever unit is written: a row vertically, a column
 * horizontally. `px` and `ch` therefore mean the same thing here, which is the
 * same equivalence the rest of termdom's box model makes. Percentages are
 * resolved against the root's own size, as the spec requires.
 */
function applyRootMargin(
	rect: DOMRect,
	margin: string,
	layoutEngine: LayoutEngine,
): DOMRect {
	const parts = margin.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return rect;

	const resolve = (value: string, basis: number): number => {
		const match = /^(-?[\d.]+)(px|ch|%)?$/.exec(value);
		if (!match) return 0;
		const n = parseFloat(match[1]);
		if (!Number.isFinite(n)) return 0;
		return match[2] === "%" ? (n / 100) * basis : n;
	};

	const [t, r = t, b = t, l = r] = parts;
	const top = resolve(t, rect.height);
	const right = resolve(r, rect.width);
	const bottom = resolve(b, rect.height);
	const left = resolve(l, rect.width);

	return layoutEngine.createDOMRect(
		rect.left - left,
		rect.top - top,
		Math.max(0, rect.width + left + right),
		Math.max(0, rect.height + top + bottom),
	);
}

export class IntersectionObserver extends LayoutObserver<
	number,
	IntersectionObserverEntry
> {
	#callback: IntersectionObserverCallback;
	#root: Element | null;

	readonly rootMargin: string;
	readonly thresholds: readonly number[];

	constructor(
		callback: IntersectionObserverCallback,
		manager: ObserverManager,
		init: IntersectionObserverInit = {},
	) {
		super(manager);
		this.#callback = callback;
		this.#root = init.root ?? null;
		this.rootMargin = init.rootMargin ?? "0px";

		// A single number, an array, or the default of "any intersection at all".
		const t = init.threshold ?? 0;
		this.thresholds = Object.freeze(
			(Array.isArray(t) ? [...t] : [t]).sort((a, b) => a - b),
		);
	}

	get root(): Element | null {
		return this.#root;
	}

	/**
	 * How many thresholds the ratio has reached, which is what the spec actually
	 * watches: an observation fires when this CHANGES, so a target scrolling
	 * through `[0, 0.5, 1]` reports at each step. Tracking only the boolean
	 * "is it intersecting" collapsed all of those into one callback and made
	 * threshold arrays decorative.
	 */
	#thresholdIndex(ratio: number): number {
		let index = 0;
		while (index < this.thresholds.length && ratio >= this.thresholds[index]) {
			// A zero threshold means "any overlap at all", so a ratio of exactly
			// zero has not reached it.
			if (this.thresholds[index] === 0 && ratio === 0) break;
			index++;
		}
		return index;
	}

	[kMeasure](
		target: Element,
		last: number | null,
		layoutEngine: LayoutEngine,
		viewport: DOMRect,
		frame: number,
	): {state: number; entry: IntersectionObserverEntry} | null {
		const box = layoutEngine.getRect(target);
		if (!box) return null;

		// The root: an explicit element's border box, or the viewport. Either way
		// grown by rootMargin, which is the whole point of that option -- it is
		// what lets a list start loading a row before it scrolls into view.
		const rootBox = this.#root ? layoutEngine.getRect(this.#root) : viewport;
		if (!rootBox) return null;
		const rootBounds = applyRootMargin(rootBox, this.rootMargin, layoutEngine);

		const {ratio, rect} = intersectionRatio(box, rootBounds, layoutEngine);
		const index = this.#thresholdIndex(ratio);
		if (last === index) return null;

		return {
			state: index,
			entry: {
				target,
				isIntersecting: index > 0,
				intersectionRatio: ratio,
				boundingClientRect: box,
				intersectionRect:
					index > 0 ? rect : layoutEngine.createDOMRect(0, 0, 0, 0),
				rootBounds,
				time: frame,
			},
		};
	}

	[kDeliver](entries: IntersectionObserverEntry[]): void {
		this.#callback(entries, this);
	}
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Owns the live observers and runs them after each layout.
 *
 * One set, not one per kind: an observer is anything that can be asked to
 * measure itself, so routing by `instanceof` bought nothing except a second
 * collection to keep in step and a reason for the manager to know its
 * subclasses. Registration is reference-counted through
 * observe/unobserve/disconnect, so an observer with nothing to watch does no
 * work and holds no memory.
 */
export class ObserverManager {
	#layoutEngine: LayoutEngine;
	#observers = new Set<AnyObserver>();

	constructor(layoutEngine: LayoutEngine) {
		this.#layoutEngine = layoutEngine;
	}

	register(observer: AnyObserver): void {
		this.#observers.add(observer);
	}

	unregister(observer: AnyObserver): void {
		this.#observers.delete(observer);
	}

	/** Run every observer against the current layout. Called after each render. */
	flush(viewport: DOMRect, frame: number): void {
		if (this.#observers.size === 0) return;
		// A copy: a callback may observe or disconnect, and mutating the set
		// mid-iteration would visit the new observer against a layout it has not
		// been measured for, or skip one that is still live.
		for (const observer of [...this.#observers]) {
			observer[kCheck](this.#layoutEngine, viewport, frame);
		}
	}

	dispose(): void {
		this.#observers.clear();
	}
}
