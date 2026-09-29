/**
 * The testdriver vendor script, which WPT leaves empty for the automation
 * backend to fill in. This engine's backend types through the transport:
 * a WebDriver key or pointer action becomes the bytes a terminal sends for
 * it, pushed into the input stream and parsed, dispatched and defaulted by
 * the engine's own path. Coordinates are CSS pixels, which this engine
 * measures as cells. An action, key or pointer type a terminal has no bytes
 * for throws, so the test fails rather than running on input it never got.
 * `in_automation` makes every testdriver call this script does not define
 * reject instead of parking the test on a manual prompt.
 */
export const TESTDRIVER_VENDOR = String.raw`
(function() {
	if (!window.test_driver_internal) {
		return;
	}
	// Keys a terminal sends as a byte of their own, and the code CSI u names
	// them by once a modifier is held.
	const CODED_KEYS = {
		"\uE003": {plain: "\x7f", code: 127},
		"\uE004": {plain: "\t", code: 9},
		"\uE006": {plain: "\r", code: 13},
		"\uE007": {plain: "\r", code: 13},
		"\uE00C": {plain: "\x1b", code: 27},
		"\uE00D": {plain: " ", code: 32},
	};
	// Keys a terminal sends as CSI <n> ~, and CSI <n> ; <mod> ~ modified.
	const TILDE_KEYS = {
		"\uE00E": 5, "\uE054": 5,
		"\uE00F": 6, "\uE055": 6,
		"\uE016": 2, "\uE05C": 2,
		"\uE017": 3, "\uE05D": 3,
		"\uE035": 15, "\uE036": 17, "\uE037": 18, "\uE038": 19,
		"\uE039": 20, "\uE03A": 21, "\uE03B": 23, "\uE03C": 24,
	};
	// Keys a terminal sends as CSI <letter>, or SS3 <letter> for F1-F4, and
	// CSI 1 ; <mod> <letter> modified.
	const LETTER_KEYS = {
		"\uE010": "F", "\uE056": "F",
		"\uE011": "H", "\uE057": "H",
		"\uE012": "D", "\uE058": "D",
		"\uE013": "A", "\uE059": "A",
		"\uE014": "C", "\uE05A": "C",
		"\uE015": "B", "\uE05B": "B",
	};
	const FUNCTION_KEYS = {
		"\uE031": "P", "\uE032": "Q", "\uE033": "R", "\uE034": "S",
	};
	// The numeric keypad and its operators type the characters on them.
	const KEYPAD_CHARACTERS = {
		"\uE018": ";", "\uE019": "=",
		"\uE01A": "0", "\uE01B": "1", "\uE01C": "2", "\uE01D": "3",
		"\uE01E": "4", "\uE01F": "5", "\uE020": "6", "\uE021": "7",
		"\uE022": "8", "\uE023": "9",
		"\uE024": "*", "\uE025": "+", "\uE026": ",", "\uE027": "-",
		"\uE028": ".", "\uE029": "/",
	};
	const MODIFIER_KEYS = {
		"\uE008": "shift", "\uE050": "shift",
		"\uE009": "ctrl", "\uE051": "ctrl",
		"\uE00A": "alt", "\uE052": "alt",
		"\uE03D": "meta", "\uE053": "meta",
	};
	const NULL_KEY = "\uE000";

	function isModifier(key) {
		return MODIFIER_KEYS[key] !== undefined;
	}
	// xterm's modifier parameter: 1 plus 1 Shift, 2 Alt, 4 Ctrl, 8 Meta.
	function modifierParameter(held) {
		return 1 +
			(held.has("shift") ? 1 : 0) +
			(held.has("alt") ? 2 : 0) +
			(held.has("ctrl") ? 4 : 0) +
			(held.has("meta") ? 8 : 0);
	}
	function bytesFor(key, held) {
		const mod = modifierParameter(held);
		const character = KEYPAD_CHARACTERS[key] ?? key;
		const coded = CODED_KEYS[key];
		if (coded !== undefined) {
			if (mod === 1) {
				return coded.plain;
			}
			if (key === "\uE004" && mod === 2) {
				return "\x1b[Z";
			}
			return "\x1b[" + coded.code + ";" + mod + "u";
		}
		if (TILDE_KEYS[key] !== undefined) {
			return mod === 1
				? "\x1b[" + TILDE_KEYS[key] + "~"
				: "\x1b[" + TILDE_KEYS[key] + ";" + mod + "~";
		}
		if (LETTER_KEYS[key] !== undefined) {
			return mod === 1
				? "\x1b[" + LETTER_KEYS[key]
				: "\x1b[1;" + mod + LETTER_KEYS[key];
		}
		if (FUNCTION_KEYS[key] !== undefined) {
			return mod === 1
				? "\x1bO" + FUNCTION_KEYS[key]
				: "\x1b[1;" + mod + FUNCTION_KEYS[key];
		}
		const code = character.codePointAt(0);
		if (code >= 0xe000 && code <= 0xf8ff) {
			throw new Error(
				"testdriver: WebDriver key U+" + code.toString(16).toUpperCase() +
				" has no terminal encoding here",
			);
		}
		return mod === 1 ? character : "\x1b[" + code + ";" + mod + "u";
	}
	function settled() {
		return new Promise((resolve) => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => resolve());
			});
		});
	}
	// WebDriver numbers the buttons as MouseEvent.button does: 0 main, 1
	// middle, 2 secondary. SGR mouse reports number them the same way, and
	// report no others.
	function buttonCode(button) {
		const code = button ?? 0;
		if (code !== 0 && code !== 1 && code !== 2) {
			throw new Error(
				"testdriver: pointer button " + code + " has no terminal mouse report",
			);
		}
		return code;
	}
	// The modifier bits of an SGR mouse report: 4 Shift, 8 Alt, 16 Ctrl. A
	// terminal reports no Meta on the mouse.
	function mouseModifiers(held) {
		if (held.has("meta")) {
			throw new Error("testdriver: a terminal mouse report carries no Meta");
		}
		return (held.has("shift") ? 4 : 0) +
			(held.has("alt") ? 8 : 0) +
			(held.has("ctrl") ? 16 : 0);
	}
	// The cell at an element's in-view center, after scrolling it into
	// view as WebDriver does.
	function getCell(element) {
		element.scrollIntoView({block: "end", inline: "nearest"});
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			throw new Error("testdriver: the element has no box to point at");
		}
		return {
			col: Math.floor(rect.left + rect.width / 2) + 1,
			row: Math.floor(rect.top + rect.height / 2) + 1,
		};
	}
	function checkInViewport(col, row) {
		const view = document.defaultView;
		if (col < 1 || row < 1 || col > view.innerWidth || row > view.innerHeight) {
			throw new Error(
				"testdriver: pointer position (" + (col - 1) + ", " + (row - 1) +
				") is outside the viewport",
			);
		}
	}
	window.test_driver_internal.in_automation = true;
	window.test_driver_internal.send_keys = async function(element, keys) {
		element.focus();
		await settled();
		const held = new Set();
		for (const key of keys) {
			if (key === NULL_KEY) {
				held.clear();
			} else if (isModifier(key)) {
				const name = MODIFIER_KEYS[key];
				if (held.has(name)) {
					held.delete(name);
				} else {
					held.add(name);
				}
			} else {
				__termdomDriverInput(bytesFor(key, held));
			}
		}
		await settled();
	};
	window.test_driver_internal.action_sequence = async function(sources) {
		for (const source of sources) {
			if (source.type !== "key" && source.type !== "pointer" &&
				source.type !== "none") {
				throw new Error(
					"testdriver: " + source.type + " action sources are not sent",
				);
			}
			const pointerType = source.parameters?.pointerType ?? "mouse";
			if (source.type === "pointer" && pointerType !== "mouse") {
				throw new Error(
					"testdriver: a terminal reports no " + pointerType + " input",
				);
			}
		}
		const held = new Set();
		// The SGR code of the pointer button held down, or null.
		let pressed = null;
		let col = 1;
		let row = 1;
		for (let tick = 0; ; tick++) {
			let any = false;
			let pause = 0;
			for (const source of sources) {
				const action = source.actions[tick];
				if (action === undefined) {
					continue;
				}
				any = true;
				if (action.type === "pause") {
					pause = Math.max(pause, action.duration ?? 0);
				} else if (source.type === "key" && action.type === "keyDown") {
					if (isModifier(action.value)) {
						held.add(MODIFIER_KEYS[action.value]);
					} else {
						__termdomDriverInput(bytesFor(action.value, held));
					}
				} else if (source.type === "key" && action.type === "keyUp") {
					if (isModifier(action.value)) {
						held.delete(MODIFIER_KEYS[action.value]);
					}
				} else if (source.type === "pointer" &&
					action.type === "pointerMove") {
					const origin = action.origin;
					const dx = action.x ?? 0;
					const dy = action.y ?? 0;
					if (origin && origin.getBoundingClientRect) {
						const cell = getCell(origin);
						col = cell.col + dx;
						row = cell.row + dy;
					} else if (origin === "pointer") {
						col += dx;
						row += dy;
					} else {
						col = dx + 1;
						row = dy + 1;
					}
					checkInViewport(col, row);
					// A move with a button down is a drag, which a terminal
					// reports as that button with the motion bit.
					const motion = (pressed === null ? 35 : 32 + pressed) +
						mouseModifiers(held);
					__termdomDriverInput(
						"\x1b[<" + motion + ";" + col + ";" + row + "M",
					);
				} else if (source.type === "pointer" &&
					action.type === "pointerDown") {
					pressed = buttonCode(action.button);
					__termdomDriverInput(
						"\x1b[<" + (pressed + mouseModifiers(held)) + ";" + col + ";" +
						row + "M",
					);
				} else if (source.type === "pointer" &&
					action.type === "pointerUp") {
					const code = buttonCode(action.button);
					pressed = null;
					__termdomDriverInput(
						"\x1b[<" + (code + mouseModifiers(held)) + ";" + col + ";" +
						row + "m",
					);
				} else {
					throw new Error(
						"testdriver: " + source.type + " action " + action.type +
						" is not sent",
					);
				}
			}
			if (!any) {
				break;
			}
			if (pause > 0) {
				await new Promise((resolve) => setTimeout(resolve, pause));
			}
		}
		await settled();
	};
	window.test_driver_internal.click = async function(element) {
		const cell = getCell(element);
		checkInViewport(cell.col, cell.row);
		__termdomDriverInput("\x1b[<0;" + cell.col + ";" + cell.row + "M");
		__termdomDriverInput("\x1b[<0;" + cell.col + ";" + cell.row + "m");
		await settled();
	};
})();
`;
