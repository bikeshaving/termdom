/**
 * Whether a frame can be a bounded edit of the one before it.
 *
 * A frame is a TRANSFORM when everything that changed since the last one is
 * bounded: a camera delta (the terminal scrolls the region via DECSTBM +
 * DL/IL) plus damage that names its elements. Only the exposed band, fixed
 * rows (real and shifted positions), the focused field, and damaged rows
 * repaint. Anything unbounded -- a structural event, a live selection, a
 * drag, a geometry change (cascades) -- takes the full diff. What a mouse
 * report changes names its elements: a click moves focus, which the cascade
 * damages, and a drag holds an anchor this gate already reads. Pointer motion
 * flipping `:hover` names its elements too -- handleHoverChange damages the
 * chains the pointer entered and left -- so hover keeps the transform.
 *
 * The decision needs the frame before it, so the compositor keeps that
 * memory: what the last painted frame's structure, focus and selection were,
 * and the damage recorded since.
 */
import type {FramePlan} from "./viewport.js";

/** What the compositor asks the engine's collaborators as it decides. */
export interface CompositorEngine {
	/** The layout generation a structural event advances. */
	structuralGeneration(): number;
	/** The [start, end) region rows fixed boxes occupy. */
	fixedRowBands(terminalHeight: number): Array<[number, number]>;
	/** An element's box in the last computed layout, if it has one. */
	getRect(element: Element): DOMRect | null;
	/** Whether an element's geometry is in viewport space, not document. */
	isInFixedSpace(element: Element): boolean;
	/** The style-damaged elements since the last frame, null if unbounded. */
	drainStyleDamage(): Set<Element> | null;
	/** How far a selector match on an element can reach. */
	invalidationScopeFor(element: Element): Element;
	/** Whether a scope covers the document, which is unbounded. */
	isDocumentScope(element: Element): boolean;
	activeElement(): Element | null;
	/** Whether a selection spans more than a caret right now. */
	selectionLive(): boolean;
	/** Whether an element is a control the painter draws a widget for. */
	isWidgetControl(element: Element): boolean;
}

/** What the renderer knows about the frame it is about to paint. */
export interface FrameFacts {
	/**
	 * Fullscreen owns the whole alternate screen from row zero, so nothing
	 * of the main screen's region carries over.
	 */
	fullscreen: boolean;
	/** The terminal row the painted region starts at. */
	regionTop: number;
	/** The rows the region spans. */
	regionHeight: number;
	/** The rows the terminal spans. */
	terminalHeight: number;
	/** The camera movement this frame, or null when nothing carries over. */
	plan: FramePlan | null;
	/** A drag in progress moves rows no damage record names. */
	dragging: boolean;
	/** A resize rewraps the screen underneath. */
	resizing: boolean;
}

/** The bounded edit a frame paints instead of a full diff. */
export interface FrameTransform {
	delta: number;
	bands: Array<[number, number]>;
}

/** Past this much of the region a transform stops paying. */
const BAND_BUDGET = 0.75;

/** How many damaged elements are worth recording before giving up. */
const DAMAGE_LIMIT = 24;

const kEngine = Symbol("engine");
const kDamage = Symbol("damage");
const kLastStructuralGeneration = Symbol("lastStructuralGeneration");
const kLastSelectionLive = Symbol("lastSelectionLive");
const kLastActiveElement = Symbol("lastActiveElement");
const kSelectionLive = Symbol("selectionLive");

/** The composition memory of one engine, and the decision it feeds. */
export class Compositor {
	declare [kEngine]: CompositorEngine;
	// Elements mutated since the last frame with the rect each held BEFORE
	// this frame's relayout; null once damage stopped being bounded.
	declare [kDamage]: Map<Element, DOMRect | null> | null;
	declare [kLastStructuralGeneration]: number;
	declare [kLastSelectionLive]: boolean;
	declare [kLastActiveElement]: Element | null;
	// This frame's selection answer, read before the paint and remembered
	// after it, so the memory holds what the decision saw.
	declare [kSelectionLive]: boolean;

	constructor(engine: CompositorEngine) {
		this[kEngine] = engine;
		this[kDamage] = new Map();
		this[kLastStructuralGeneration] = -1;
		this[kLastSelectionLive] = false;
		this[kLastActiveElement] = null;
		this[kSelectionLive] = false;
	}

	/** Whether focus sits where the last painted frame left it. */
	get focusUnmoved(): boolean {
		return this[kEngine].activeElement() === this[kLastActiveElement];
	}

	/** Record a mutated node's element and the rows it holds right now. */
	damage(node: Node): void {
		const damage = this[kDamage];
		if (!damage) {
			return;
		}
		const element =
			node.nodeType === node.ELEMENT_NODE ?
					(node as Element) :
					(node.parentElement ?? null);
		if (!element) {
			this[kDamage] = null;
			return;
		}
		if (damage.has(element)) {
			return;
		}
		if (damage.size >= DAMAGE_LIMIT) {
			this[kDamage] = null;
			return;
		}
		// The rect BEFORE this frame's relayout: getRect answers from the
		// last computed layout until calculateLayout runs.
		damage.set(element, this[kEngine].getRect(element));
	}

	/**
	 * The bounded edit this frame can paint, or null for a full diff. Drains
	 * the damage either way: a full-diff frame repaints what it named.
	 */
	compose(frame: FrameFacts): FrameTransform | null {
		const damage = this[kDamage];
		this[kDamage] = new Map();
		const styleDamage = this[kEngine].drainStyleDamage();
		this[kSelectionLive] = this[kEngine].selectionLive();
		if (damage === null || styleDamage === null || !carriesOver(this, frame)) {
			return null;
		}
		return bandsFor(this, frame, frame.plan!, damage, styleDamage);
	}

	/** Take this frame's facts as the next frame's memory. */
	frameRendered(): void {
		this[kLastStructuralGeneration] = this[kEngine].structuralGeneration();
		this[kLastSelectionLive] = this[kSelectionLive];
		this[kLastActiveElement] = this[kEngine].activeElement();
	}
}

/** Whether anything of the last frame survives on the screen. */
function carriesOver(compositor: Compositor, frame: FrameFacts): boolean {
	return (
		frame.plan !== null &&
		!frame.fullscreen &&
		frame.regionTop === 0 &&
		frame.regionHeight === frame.terminalHeight &&
		compositor[kEngine].structuralGeneration() ===
		compositor[kLastStructuralGeneration] &&
		!compositor[kSelectionLive] &&
		!compositor[kLastSelectionLive] &&
		!frame.dragging &&
		!frame.resizing
	);
}

/**
 * The rows to repaint over the shifted screen, or null as soon as the damage
 * stops being worth banding.
 */
function bandsFor(
	compositor: Compositor,
	frame: FrameFacts,
	plan: FramePlan,
	damage: Map<Element, DOMRect | null>,
	styleDamage: Set<Element>,
): FrameTransform | null {
	const engine = compositor[kEngine];
	const delta = plan.shift;
	if (delta === 0 && damage.size === 0 && styleDamage.size === 0) {
		return null;
	}

	const regionHeight = frame.regionHeight;
	const bands: Array<[number, number]> = [];
	// Past most of the region the transform stops paying, so the rows the
	// bands claim are counted as they are added: damage that already covers
	// the screen stops the walk instead of pricing every element that follows
	// it. Overlap counts twice, which only makes the bail come sooner.
	const bandBudget = regionHeight * BAND_BUDGET;
	let coverage = 0;
	const addBand = (start: number, end: number): void => {
		const clampedStart = Math.max(0, Math.floor(start));
		const clampedEnd = Math.min(regionHeight, Math.ceil(end));
		if (clampedEnd > clampedStart) {
			bands.push([clampedStart, clampedEnd]);
			coverage += clampedEnd - clampedStart;
		}
	};

	for (const [start, end] of plan.exposedBands) {
		addBand(start, end);
	}
	for (const band of engine.fixedRowBands(frame.terminalHeight)) {
		addBand(band[0], band[1]);
		// The scroll moved fixed content too, leaving a stale copy at the
		// shifted position; model and screen agree on it, so only a repaint
		// of that row corrects it.
		if (delta !== 0) {
			addBand(band[0] - delta, band[1] - delta);
		}
	}
	// The focused field's rows repaint: its caret cell and the real cursor
	// park come from the painter visiting it.
	const active = engine.activeElement();
	if (active && engine.isWidgetControl(active)) {
		const rect = engine.getRect(active);
		if (rect) {
			const top = plan.regionRowNow(rect.top);
			addBand(top, top + rect.height);
		}
	}

	// A focus move flips :focus/:focus-visible on both elements.
	const damaged = new Set<Element>(damage.keys());
	for (const element of styleDamage) {
		damaged.add(element);
	}
	const wasActive = compositor[kLastActiveElement];
	if (active !== wasActive) {
		if (active) {
			damaged.add(active);
		}
		if (wasActive) {
			damaged.add(wasActive);
		}
	}

	for (const element of damaged) {
		if (coverage > bandBudget) {
			return null;
		}
		// Damage reaches as far as the selector invalidation scope; the whole
		// document is unbounded.
		const scope = engine.invalidationScopeFor(element);
		if (engine.isDocumentScope(scope)) {
			return null;
		}
		const before = damage.get(element) ?? damage.get(scope);
		const after = engine.getRect(scope);
		if (!after && !before) {
			// An inline element has no box of its own, so its rows are not
			// recoverable here: unbounded. A removed element's damage is its
			// parent's, already recorded.
			if (scope.isConnected) {
				return null;
			}
			continue;
		}
		// A geometry change cascades to everything after the element.
		if (
			before &&
			after &&
			(before.top !== after.top || before.height !== after.height)
		) {
			return null;
		}
		const fixedSpace = engine.isInFixedSpace(scope);
		if (after) {
			const afterTop = fixedSpace ? after.top : plan.regionRowNow(after.top);
			addBand(afterTop, afterTop + after.height);
			// The shifted stale copy of the damaged rows, as for fixed.
			if (delta !== 0) {
				addBand(afterTop - delta, afterTop + after.height - delta);
			}
		}
		if (before) {
			const beforeTop = fixedSpace ?
				before.top :
					plan.regionRowLastFrame(before.top);
			addBand(beforeTop - delta, beforeTop + before.height - delta);
		}
	}

	if (delta === 0 && bands.length === 0) {
		return null;
	}
	if (coverage > bandBudget) {
		return null;
	}
	return {delta, bands};
}
