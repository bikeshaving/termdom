import type {DOMWindow} from "jsdom";

/**
 * Manages terminal scrolling behavior with standard DOM APIs
 * Keeps window.scrollY, document.scrollTop, and window.screenTop in sync
 */
export class ScrollingManager {
	private scrollTop = 0;
	private screenTop = 0;

	constructor(
		private window: DOMWindow,
		private document: Document,
	) {
		this.initializeScrollingProperties();
	}

	/**
	 * Initialize all scrolling-related DOM properties
	 */
	private initializeScrollingProperties(): void {
		// window.screenTop (readonly, terminal viewport position)
		Object.defineProperty(this.window, "screenTop", {
			get: () => this.screenTop,
			configurable: true,
			enumerable: true,
		});

		// window.scrollY (readonly, reflects document scroll position)
		// Bounded to 0 like standard DOM - use screenTop for content positioning
		Object.defineProperty(this.window, "scrollY", {
			get: () => Math.max(0, this.scrollTop),
			configurable: true,
			enumerable: true,
		});

		// window.pageYOffset (readonly alias for scrollY)
		Object.defineProperty(this.window, "pageYOffset", {
			get: () => Math.max(0, this.scrollTop),
			configurable: true,
			enumerable: true,
		});

		// document.documentElement.scrollTop (writable, standard property)
		Object.defineProperty(this.document.documentElement, "scrollTop", {
			get: () => Math.max(0, this.scrollTop),
			set: (value: number) => {
				// No-op when in command start mode (content below viewport top)
				if (this.scrollTop < 0) return;
				this.scrollTop = value;
			},
			configurable: true,
			enumerable: true,
		});

		// document.body.scrollTop (writable, compatibility - keeps in sync with documentElement)
		Object.defineProperty(this.document.body, "scrollTop", {
			get: () => Math.max(0, this.scrollTop),
			set: (value: number) => {
				// No-op when in command start mode (content below viewport top)
				if (this.scrollTop < 0) return;
				this.scrollTop = value;
			},
			configurable: true,
			enumerable: true,
		});

		// Standard scroll methods
		this.window.scrollTo = (
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		) => {
			// No-op when in command start mode (content below viewport top)
			if (this.scrollTop < 0) return;

			if (typeof xOrOptions === "number") {
				this.scrollTop = y || 0;
			} else if (xOrOptions && typeof xOrOptions === "object") {
				this.scrollTop = xOrOptions.top || 0;
			}
		};

		this.window.scroll = (
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		) => {
			// No-op when in command start mode (content below viewport top)
			if (this.scrollTop < 0) return;

			if (typeof xOrOptions === "number") {
				this.scrollTop = y || 0;
			} else if (xOrOptions && typeof xOrOptions === "object") {
				this.scrollTop = xOrOptions.top || 0;
			}
		};
	}

	/**
	 * Set the terminal cursor position (screenTop)
	 * This is readonly from the user's perspective but we can update it internally
	 */
	setScreenTop(value: number): void {
		this.screenTop = value;
	}

	/**
	 * Set the document scroll position
	 */
	setScrollTop(value: number): void {
		this.scrollTop = value;
	}

	/**
	 * Get current scroll position
	 */
	getScrollTop(): number {
		return this.scrollTop;
	}

	/**
	 * Get current screen position
	 */
	getScreenTop(): number {
		return this.screenTop;
	}

	/**
	 * Get effective viewport offset for rendering
	 * Returns the row where content should start rendering (0-based)
	 */
	getViewportOffset(): number {
		return -this.scrollTop;
	}

	/**
	 * Scroll the document by a relative amount
	 */
	scrollBy(deltaY: number, internal: boolean = false): void {
		// No-op when in command start mode (content below viewport top), unless internal
		if (this.scrollTop < 0 && !internal) return;

		this.scrollTop += deltaY;
	}

	/**
	 * Set scroll position to show content from command start position
	 */
	scrollToCommandStart(): void {
		this.scrollTop = -this.screenTop;
	}

	/**
	 * Reset scroll to show content from terminal top
	 */
	scrollToTop(): void {
		this.scrollTop = 0;
	}
}
