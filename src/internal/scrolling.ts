import type {DOMWindow} from "jsdom";

/**
 * Manages the command-start anchor: window.screenTop (the row the document
 * starts on) plus the writable document.scrollTop / scrollTo knobs. The camera
 * position -- window.scrollY / pageYOffset / scrollBy -- is owned by TermDOM
 * itself (it maps to the camera offset), so this manager must not bind those.
 */
export class ScrollingManager {
	#scrollTop = 0;
	#screenTop = 0;
	#window: DOMWindow;
	#document: Document;

	constructor(window: DOMWindow, document: Document) {
		this.#window = window;
		this.#document = document;
		this.#initializeScrollingProperties();
	}

	/**
	 * Initialize all scrolling-related DOM properties
	 */
	#initializeScrollingProperties(): void {
		// window.screenTop (readonly, terminal viewport position)
		Object.defineProperty(this.#window, "screenTop", {
			get: () => this.#screenTop,
			configurable: true,
			enumerable: true,
		});

		// window.scrollY / pageYOffset are the camera position and are owned by
		// TermDOM (see #initializeWindow); this manager must not bind them.

		// document.documentElement.scrollTop (writable, standard property)
		Object.defineProperty(this.#document.documentElement, "scrollTop", {
			get: () => Math.max(0, this.#scrollTop),
			set: (value: number) => {
				// No-op when in command start mode (content below viewport top)
				if (this.#scrollTop < 0) return;
				this.#scrollTop = value;
			},
			configurable: true,
			enumerable: true,
		});

		// document.body.scrollTop (writable, compatibility - keeps in sync with documentElement)
		Object.defineProperty(this.#document.body, "scrollTop", {
			get: () => Math.max(0, this.#scrollTop),
			set: (value: number) => {
				// No-op when in command start mode (content below viewport top)
				if (this.#scrollTop < 0) return;
				this.#scrollTop = value;
			},
			configurable: true,
			enumerable: true,
		});

		// Standard scroll methods
		this.#window.scrollTo = (
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		) => {
			// No-op when in command start mode (content below viewport top)
			if (this.#scrollTop < 0) return;

			if (typeof xOrOptions === "number") {
				this.#scrollTop = y || 0;
			} else if (xOrOptions && typeof xOrOptions === "object") {
				this.#scrollTop = xOrOptions.top || 0;
			}
		};

		this.#window.scroll = (
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		) => {
			// No-op when in command start mode (content below viewport top)
			if (this.#scrollTop < 0) return;

			if (typeof xOrOptions === "number") {
				this.#scrollTop = y || 0;
			} else if (xOrOptions && typeof xOrOptions === "object") {
				this.#scrollTop = xOrOptions.top || 0;
			}
		};
	}

	/**
	 * Set the terminal cursor position (screenTop)
	 * This is readonly from the user's perspective but we can update it internally
	 */
	setScreenTop(value: number): void {
		this.#screenTop = value;
	}

	/**
	 * Set the document scroll position
	 */
	setScrollTop(value: number): void {
		this.#scrollTop = value;
	}

	/**
	 * Get current scroll position
	 */
	getScrollTop(): number {
		return this.#scrollTop;
	}

	/**
	 * Get current screen position
	 */
	getScreenTop(): number {
		return this.#screenTop;
	}

	/**
	 * Get effective viewport offset for rendering
	 * Returns the row where content should start rendering (0-based)
	 */
	getViewportOffset(): number {
		return -this.#scrollTop;
	}

	/**
	 * Scroll the document by a relative amount
	 */
	scrollBy(deltaY: number, internal: boolean = false): void {
		// No-op when in command start mode (content below viewport top), unless internal
		if (this.#scrollTop < 0 && !internal) return;

		this.#scrollTop += deltaY;
	}

	/**
	 * Set scroll position to show content from command start position
	 */
	scrollToCommandStart(): void {
		this.#scrollTop = -this.#screenTop;
	}

	/**
	 * Reset scroll to show content from terminal top
	 */
	scrollToTop(): void {
		this.#scrollTop = 0;
	}
}
