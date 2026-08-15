/**
 * What the browsers do with a CJK input method, and what has to be done about
 * it.
 *
 * xterm.js reads composed text off the composition events -- compositionstart,
 * compositionupdate, compositionend -- and off `input` events whose
 * `inputType` is `insertText`. Two engines do not deliver Korean that way, and
 * each needs one intervention of its own:
 *
 *   Chromium delivers the jamo as ordinary keydowns with real keyCodes, so
 *   xterm sends the raw jamo and cancels the key, which is what stops the
 *   composition from ever starting (xterm.js#5348). Declining those keys
 *   hands them back to the IME, and xterm's own composition path then sends
 *   the finished syllable.
 *
 *   WebKit fires no composition events for Korean at all. The first jamo
 *   arrives as `insertText` and every syllable after it as
 *   `insertReplacementText`, which xterm drops (xterm.js#5704), while the
 *   keydowns carrying keyCode 229 make xterm's textarea-diff fallback send
 *   the half-built syllables one at a time. Nothing here composes anything:
 *   the syllable the engine has already composed is echoed to the terminal
 *   as it stands, and each replacement takes the last echo back with
 *   backspaces -- the field previews the composition the way a browser's
 *   own field does.
 *
 * Every other browser is left on stock xterm behaviour.
 */
import type {Terminal} from "@xterm/xterm";

/** Hangul: jamo, compatibility jamo, the syllables, and the extended blocks. */
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/;
/** Hangul, plus the kana a Japanese IME composes with. */
const IME_CLAIMED = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿぀-ヿ]/;

export type IMEEngine = "webkit" | "blink" | "other";

/**
 * Which engine's IME dispatch this is.
 *
 * What differs between them is not a feature but which events an IME
 * produces, and in what order -- there is nothing to test for without an IME
 * to type with. So the engine is read off the vendor string, which still
 * separates the three: WebKit reports Apple whoever ships it, which is Safari
 * and every WKWebView including the iOS browsers wearing other names, and
 * Chromium reports Google. Anything else -- Firefox, and any engine that
 * arrives after this was written -- is `other`, and gets stock xterm.
 */
export function imeEngine(): IMEEngine {
	switch (navigator.vendor) {
		case "Apple Computer, Inc.":
			return "webkit";
		case "Google Inc.":
			return "blink";
		default:
			return "other";
	}
}

/**
 * Give `terminal` whatever its browser's IME needs, or nothing.
 *
 * Called once, after `terminal.open`: the WebKit path listens on the
 * emulator's own element, which does not exist before that.
 */
export function installIMEQuirks(terminal: Terminal): IMEEngine {
	const engine = imeEngine();
	if (engine === "blink") declineComposingKeys(terminal);
	if (engine === "webkit") forwardReplacementText(terminal);
	return engine;
}

/**
 * Chromium: let the IME have the keys it is composing with.
 *
 * The keys arrive as though they were typed -- a real keyCode, `isComposing`
 * false -- and xterm sends them and calls preventDefault, which is what the
 * IME needs not to happen. Declining a key leaves it to the textarea, where
 * the IME composes with it and the composition events follow.
 */
function declineComposingKeys(terminal: Terminal): void {
	terminal.attachCustomKeyEventHandler((ev) => {
		if (ev.type !== "keydown") return true;
		if (ev.ctrlKey || ev.altKey || ev.metaKey) return true;
		if (ev.isComposing || ev.keyCode === 229) return false;
		if (ev.key.length === 1 && IME_CLAIMED.test(ev.key)) return false;
		return true;
	});
}

/**
 * WebKit: echo the syllable the engine composed, and only that.
 *
 * The composition lives in the textarea, where the engine keeps it; this
 * mirrors it to the terminal, phase by phase. Every event that
 * would have made xterm send a piece of it itself is stopped before xterm's
 * own listeners see it -- these listen on the element the textarea sits in,
 * during the capture phase, which is the one place a page can get in front of
 * a listener the emulator has already bound to the textarea itself.
 *
 * If the engine does fire a real composition -- a Japanese or Chinese IME on
 * the same browser -- this stands down for the length of it and xterm's
 * composition path does the work, because two of them doing it is how a
 * syllable gets typed twice.
 */
function forwardReplacementText(terminal: Terminal): void {
	const host = terminal.element;
	const textarea = terminal.textarea;
	if (!host || !textarea) return;

	// The composed syllable, as the engine last had it, echoed to the
	// terminal as it changes: the field shows every phase of the syllable,
	// which is the value a browser's own field holds mid-composition. A
	// replacement takes back the previous state with backspaces before the
	// new one goes down. The textarea holds the syllable too, and is left
	// alone: an IME composes against what it put there, and rewriting it
	// mid-composition is how a syllable gets lost.
	let pending = "";
	let standDown = false;

	const setPending = (next: string): void => {
		if (next === pending) return;
		const prev = [...pending];
		const chars = [...next];
		let shared = 0;
		while (
			shared < prev.length &&
			shared < chars.length &&
			prev[shared] === chars[shared]
		) {
			shared++;
		}
		const taken = "\x7f".repeat(prev.length - shared);
		const given = chars.slice(shared).join("");
		if (taken || given) terminal.input(taken + given, true);
		pending = next;
	};

	// The syllable is already on screen; ending the composition is only
	// forgetting that it was provisional.
	const flush = (): void => {
		pending = "";
	};

	const onInput = (event: Event): void => {
		if (standDown || event.target !== textarea) return;
		const ev = event as InputEvent;
		const data = ev.data;

		if (ev.inputType === "insertReplacementText" && data) {
			// A replacement of a syllable being composed, or of one this is
			// already holding. Anything else -- an autocorrection, say -- is
			// left to xterm, which is to say dropped, as it is today.
			if (!pending && !HANGUL.test(data)) return;
			setPending(data);
			event.stopPropagation();
			return;
		}

		if (ev.inputType === "insertText" && data && HANGUL.test(data)) {
			// A new syllable begins: whatever came before it is finished.
			flush();
			setPending(data);
			event.stopPropagation();
			return;
		}

		if (!pending) return;

		if (!data) {
			// The composition was deleted out from under itself: take back
			// what was echoed for it.
			setPending("");
			event.stopPropagation();
			return;
		}

		// An ordinary character ends the composition, and xterm sends it.
		flush();
	};

	const onKeyDown = (event: Event): void => {
		if (standDown || event.target !== textarea) return;
		const ev = event as KeyboardEvent;

		if (ev.isComposing || ev.keyCode === 229) {
			// A key the IME is composing with. xterm answers keyCode 229 by
			// sending whatever changed in the textarea, which is the syllable
			// half-built; the input event above is where the finished one comes
			// from.
			event.stopPropagation();
			return;
		}

		if (pending && ev.key === "Backspace") {
			// Backspace unbuilds the syllable rather than deleting a character
			// of its own. The engine does the unbuilding and says what is left
			// in the input event that follows, which mirrors it to the screen.
			event.stopPropagation();
			return;
		}

		// Any other key ends the composition. The syllable is already on
		// screen; the key follows, and xterm handles it as it always does.
		flush();
	};

	const onCompositionStart = (event: Event): void => {
		if (event.target !== textarea) return;
		standDown = true;
		flush();
	};

	const onCompositionEnd = (event: Event): void => {
		if (event.target !== textarea) return;
		standDown = false;
	};

	host.addEventListener("keydown", onKeyDown, true);
	host.addEventListener("input", onInput, true);
	host.addEventListener("compositionstart", onCompositionStart, true);
	host.addEventListener("compositionend", onCompositionEnd, true);
	// A composition abandoned by leaving the terminal is still a composition
	// the reader typed.
	textarea.addEventListener("blur", flush);
}
