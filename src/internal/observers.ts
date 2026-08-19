/**
 * ResizeObserver and IntersectionObserver, over the boxes layout has already
 * computed for the frame.
 */

import type {LayoutEngine} from "./layout.js";
import {computedStyleOf} from "./styles.js";

const kManager = Symbol("manager");
const kCallback = Symbol("callback");
const kRoot = Symbol("root");
const kThresholdIndex = Symbol("thresholdIndex");
const kLayoutEngine = Symbol("layoutEngine");
const kObservers = Symbol("observers");

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
interface ContentBox {
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
	const border = layoutEngine.getRect(element);
	const content = layoutEngine.contentRect(element);
	if (!border || !content) {
		return null;
	}
	// Origin relative to the border box: what precedes the content on each axis.
	return {
		width: content.width,
		height: content.height,
		top: content.y - border.y,
		left: content.x - border.x,
	};
}

/**
 * The half of an observer that is identical between the two: which elements are
 * watched, what was last reported for each, and registration with the manager.
 *
 * Subclasses supply only how to measure one target (#measure) and how to build
 * an entry from that measurement, which is the whole of what differs.
 */
abstract class LayoutObserver<TState, TEntry, TOptions = void> {
	declare [kManager]: ObserverManager;
	/**
	 * Observed targets, each mapped to how it was asked to be observed and to
	 * what was last reported for it. One entry per target, as the DOM says: a
	 * second observe() of the same target replaces the first's options.
	 */
	[kTargets]: Map<
		Element,
		{options: TOptions | undefined; last: TState | null}
	>;

	constructor(manager: ObserverManager) {
		this[kTargets] = new Map<
			Element,
			{options: TOptions | undefined; last: TState | null}
		>();
		this[kManager] = manager;
	}

	observe(target: Element, options?: TOptions): void {
		// A fresh target has no last state, so its first measurement always counts
		// as a change -- which is what fires the initial callback the DOM promises.
		this[kTargets].set(target, {
			options,
			last: this[kTargets].get(target)?.last ?? null,
		});
		this[kManager].register(this as unknown as AnyObserver);
	}

	unobserve(target: Element): void {
		this[kTargets].delete(target);
		if (this[kTargets].size === 0) {
			this[kManager].unregister(this as unknown as AnyObserver);
		}
	}

	disconnect(): void {
		this[kTargets].clear();
		this[kManager].unregister(this as unknown as AnyObserver);
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
		options: TOptions | undefined,
	): {state: TState; entry: TEntry} | null;

	abstract [kDeliver](entries: TEntry[]): void;

	[kCheck](layoutEngine: LayoutEngine, viewport: DOMRect, frame: number): void {
		const entries: TEntry[] = [];
		for (const [target, observation] of this[kTargets]) {
			const result = this[kMeasure](
				target,
				observation.last,
				layoutEngine,
				viewport,
				frame,
				observation.options,
			);
			if (!result) {
				continue;
			}
			observation.last = result.state;
			entries.push(result.entry);
		}
		if (entries.length > 0) {
			this[kDeliver](entries);
		}
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

/** The boxes an observation can watch, as the DOM enumerates them. */
const RESIZE_BOXES = new Set([
	"border-box",
	"content-box",
	"device-pixel-content-box",
]);

interface ResizeObserverOptions {
	box?: string;
}

export class ResizeObserver extends LayoutObserver<
	ResizeSize,
	ResizeObserverEntry,
	ResizeObserverOptions
> {
	declare [kCallback]: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback, manager: ObserverManager) {
		super(manager);
		this[kCallback] = callback;
	}

	/**
	 * `box` names which box's size change is worth reporting; every entry still
	 * carries all of them, as the DOM says. An unrecognized value is not a box
	 * this DOM quietly ignores -- the enumeration rejects it, as WebIDL does.
	 */
	override observe(target: Element, options?: ResizeObserverOptions): void {
		const box = options?.box;
		if (box !== undefined && !RESIZE_BOXES.has(box)) {
			throw new TypeError(
				`Failed to execute 'observe' on 'ResizeObserver': The provided value '${box}' is not a valid enum value of type ResizeObserverBoxOptions.`,
			);
		}
		super.observe(target, options);
	}

	[kMeasure](
		target: Element,
		last: ResizeSize | null,
		layoutEngine: LayoutEngine,
		_viewport: DOMRect,
		_frame: number,
		options: ResizeObserverOptions | undefined,
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

		const border = layoutEngine.getRect(target);
		// device-pixel-content-box is the content box: a cell is the device
		// pixel here, so the two can never diverge.
		const watched =
			options?.box === "border-box" ?
					{
						width: border?.width ?? content.width,
						height: border?.height ?? content.height,
					} :
					{width: content.width, height: content.height};

		if (
			last &&
			last.width === watched.width &&
			last.height === watched.height
		) {
			return null;
		}

		const box: ResizeObserverSize = {
			inlineSize: content.width,
			blockSize: content.height,
		};
		return {
			state: watched,
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
		this[kCallback](entries, this);
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
	if (parts.length === 0) {
		return rect;
	}

	const resolve = (value: string, basis: number): number => {
		const match = /^(-?[\d.]+)(px|ch|%)?$/.exec(value);
		if (!match) {
			return 0;
		}
		const n = parseFloat(match[1]);
		if (!Number.isFinite(n)) {
			return 0;
		}
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
	declare [kCallback]: IntersectionObserverCallback;
	declare [kRoot]: Element | null;

	readonly rootMargin: string;
	readonly thresholds: readonly number[];

	constructor(
		callback: IntersectionObserverCallback,
		manager: ObserverManager,
		init: IntersectionObserverInit = {},
	) {
		super(manager);
		this[kCallback] = callback;
		this[kRoot] = init.root ?? null;
		this.rootMargin = init.rootMargin ?? "0px";

		// A single number, an array, or the default of "any intersection at all".
		const t = init.threshold ?? 0;
		this.thresholds = Object.freeze(
			(Array.isArray(t) ? [...t] : [t]).sort((a, b) => a - b),
		);
	}

	get root(): Element | null {
		return this[kRoot];
	}

	/**
	 * How many thresholds the ratio has reached, which is what the spec actually
	 * watches: an observation fires when this CHANGES, so a target scrolling
	 * through `[0, 0.5, 1]` reports at each step. Tracking only the boolean
	 * "is it intersecting" collapsed all of those into one callback and made
	 * threshold arrays decorative.
	 */
	[kThresholdIndex](ratio: number): number {
		let index = 0;
		while (index < this.thresholds.length && ratio >= this.thresholds[index]) {
			// A zero threshold means "any overlap at all", so a ratio of exactly
			// zero has not reached it.
			if (this.thresholds[index] === 0 && ratio === 0) {
				break;
			}
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
		if (!box) {
			return null;
		}

		// The root: an explicit element's border box, or the viewport. Either way
		// grown by rootMargin, which is the whole point of that option -- it is
		// what lets a list start loading a row before it scrolls into view.
		const rootBox = this[kRoot] ? layoutEngine.getRect(this[kRoot]) : viewport;
		if (!rootBox) {
			return null;
		}
		const rootBounds = applyRootMargin(rootBox, this.rootMargin, layoutEngine);

		const {ratio, rect} = intersectionRatio(box, rootBounds, layoutEngine);
		const index = this[kThresholdIndex](ratio);
		if (last === index) {
			return null;
		}

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
		this[kCallback](entries, this);
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
	declare [kLayoutEngine]: LayoutEngine;
	declare [kObservers]: Set<AnyObserver>;

	constructor(layoutEngine: LayoutEngine) {
		this[kObservers] = new Set<AnyObserver>();
		this[kLayoutEngine] = layoutEngine;
	}

	register(observer: AnyObserver): void {
		this[kObservers].add(observer);
	}

	unregister(observer: AnyObserver): void {
		this[kObservers].delete(observer);
	}

	/** Run every observer against the current layout. Called after each render. */
	flush(viewport: DOMRect, frame: number): void {
		if (this[kObservers].size === 0) {
			return;
		}
		// A copy: a callback may observe or disconnect, and mutating the set
		// mid-iteration would visit the new observer against a layout it has not
		// been measured for, or skip one that is still live.
		for (const observer of [...this[kObservers]]) {
			observer[kCheck](this[kLayoutEngine], viewport, frame);
		}
	}

	dispose(): void {
		this[kObservers].clear();
	}
}
