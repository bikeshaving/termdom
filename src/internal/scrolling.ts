import type {DOMWindow} from "jsdom";

/**
 * Manages the command-start anchor: window.screenTop (the row the document
 * starts on). The document camera -- window.scrollY / pageYOffset / scrollBy /
 * scrollTo / scroll, and document.documentElement/body.scrollTop, all one
 * value -- is owned by TermDOM itself (see #initializeWindow); this manager
 * must not bind any of those.
 *
 * The anchor's own scroll-relative position (#scrollTop, always -screenTop
 * once set) survives here only for fullscreen mode's hit-testing formula,
 * which predates the camera and is algebraically equivalent to -screenTop.
 */
export class ScrollingManager {
	#scrollTop = 0;
	#screenTop = 0;
	#window: DOMWindow;

	constructor(window: DOMWindow, _document: Document) {
		this.#window = window;
		this.#initializeScrollingProperties();
	}

	#initializeScrollingProperties(): void {
		// window.screenTop (readonly, terminal viewport position)
		Object.defineProperty(this.#window, "screenTop", {
			get: () => this.#screenTop,
			configurable: true,
			enumerable: true,
		});
	}

	/**
	 * Set the terminal cursor position (screenTop)
	 * This is readonly from the user's perspective but we can update it internally
	 */
	setScreenTop(value: number): void {
		this.#screenTop = value;
	}

	/**
	 * Get current scroll position. Fullscreen hit-testing only -- see the class
	 * doc comment.
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
	 * Set scroll position to show content from command start position
	 */
	scrollToCommandStart(): void {
		this.#scrollTop = -this.#screenTop;
	}
}
