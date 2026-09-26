/**
 * The testdriver vendor script, which WPT leaves empty for the automation
 * backend to fill in. This engine's backend types through the transport:
 * a WebDriver key becomes the bytes a terminal sends for it, pushed into
 * the input stream and parsed, dispatched and defaulted by the engine's
 * own path. `in_automation` makes every action the shim does not implement
 * throw instead of parking the test on a manual prompt.
 */
export const TESTDRIVER_VENDOR = String.raw`
(function() {
	if (!window.test_driver_internal) {
		return;
	}
	const KEY_BYTES = {
		"\uE003": "\x7f",
		"\uE004": "\t",
		"\uE006": "\r",
		"\uE007": "\r",
		"\uE00C": "\x1b",
		"\uE00D": " ",
		"\uE010": "\x1b[F",
		"\uE011": "\x1b[H",
		"\uE012": "\x1b[D",
		"\uE013": "\x1b[A",
		"\uE014": "\x1b[C",
		"\uE015": "\x1b[B",
		"\uE017": "\x1b[3~",
	};
	const MODIFIERS = new Set([
		"\uE008", "\uE009", "\uE00A", "\uE03D", "\uE050",
	]);
	function isShift(key) {
		return key === "\uE008" || key === "\uE050";
	}
	function bytesFor(key, shift) {
		if (key === "\uE004" && shift) {
			return "\x1b[Z";
		}
		return KEY_BYTES[key] ?? key;
	}
	function settled() {
		return new Promise((resolve) => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => resolve());
			});
		});
	}
	function getCell(element) {
		const rect = element.getBoundingClientRect();
		return {
			col: Math.floor(rect.left + rect.width / 2) + 1,
			row: Math.floor(rect.top + rect.height / 2) + 1,
		};
	}
	window.test_driver_internal.in_automation = true;
	window.test_driver_internal.send_keys = async function(element, keys) {
		element.focus();
		await settled();
		let shift = false;
		for (const key of keys) {
			if (MODIFIERS.has(key)) {
				shift = shift || isShift(key);
				continue;
			}
			__termdomDriverInput(bytesFor(key, shift));
		}
		await settled();
	};
	window.test_driver_internal.action_sequence = async function(sources) {
		const pressed = new Set();
		let col = 1;
		let row = 1;
		for (let tick = 0; ; tick++) {
			let any = false;
			for (const source of sources) {
				const action = source.actions[tick];
				if (action === undefined) {
					continue;
				}
				any = true;
				if (source.type === "key") {
					if (action.type === "keyDown") {
						if (MODIFIERS.has(action.value)) {
							pressed.add(action.value);
						} else {
							const shift = [...pressed].some(isShift);
							__termdomDriverInput(bytesFor(action.value, shift));
						}
					} else if (action.type === "keyUp") {
						pressed.delete(action.value);
					}
				} else if (source.type === "pointer") {
					if (action.type === "pointerMove") {
						const origin = action.origin;
						if (origin && origin.getBoundingClientRect) {
							const cell = getCell(origin);
							col = cell.col + (action.x ?? 0);
							row = cell.row + (action.y ?? 0);
						} else {
							col = (action.x ?? 0) + 1;
							row = (action.y ?? 0) + 1;
						}
						__termdomDriverInput("\x1b[<35;" + col + ";" + row + "M");
					} else if (action.type === "pointerDown") {
						__termdomDriverInput("\x1b[<0;" + col + ";" + row + "M");
					} else if (action.type === "pointerUp") {
						__termdomDriverInput("\x1b[<0;" + col + ";" + row + "m");
					}
				}
			}
			if (!any) {
				break;
			}
		}
		await settled();
	};
	window.test_driver_internal.click = async function(element) {
		const cell = getCell(element);
		__termdomDriverInput("\x1b[<0;" + cell.col + ";" + cell.row + "M");
		__termdomDriverInput("\x1b[<0;" + cell.col + ";" + cell.row + "m");
		await settled();
	};
})();
`;
