/**
 * Runtime abstraction layer for Bun-specific APIs.
 * Provides fallbacks for Node.js and Deno environments.
 */

// Detect runtime
const isBun = typeof globalThis.Bun !== "undefined";
const isDeno = typeof (globalThis as any).Deno !== "undefined";

/**
 * Get the display width of a string in terminal columns.
 * Uses Bun.stringWidth when available, otherwise falls back to
 * a basic implementation that handles common cases.
 */
export function stringWidth(str: string): number {
	if (isBun) {
		return Bun.stringWidth(str);
	}

	// Fallback: count characters, handling wide chars (CJK, emoji)
	let width = 0;
	for (const char of str) {
		const code = char.codePointAt(0)!;
		if (code === 0) continue;
		// Control characters
		if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
		// Wide characters: CJK Unified Ideographs, Hangul, etc.
		if (isWideChar(code)) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * Parse a CSS color string to a numeric RGBA value.
 * Uses Bun.color when available, otherwise falls back to a basic parser.
 */
export function cssColorToNumber(cssColor: string): number | null {
	if (isBun) {
		return Bun.color(cssColor, "number") ?? null;
	}

	return parseColor(cssColor);
}

/**
 * Check if a Unicode codepoint represents a wide (2-column) character.
 */
function isWideChar(code: number): boolean {
	// CJK Unified Ideographs
	if (code >= 0x4e00 && code <= 0x9fff) return true;
	// CJK Unified Ideographs Extension A
	if (code >= 0x3400 && code <= 0x4dbf) return true;
	// CJK Compatibility Ideographs
	if (code >= 0xf900 && code <= 0xfaff) return true;
	// Hangul Syllables
	if (code >= 0xac00 && code <= 0xd7af) return true;
	// Fullwidth Forms
	if (code >= 0xff01 && code <= 0xff60) return true;
	if (code >= 0xffe0 && code <= 0xffe6) return true;
	// CJK Unified Ideographs Extension B+
	if (code >= 0x20000 && code <= 0x2ffff) return true;
	// Emoji modifiers and presentation
	if (code >= 0x1f000 && code <= 0x1faff) return true;
	return false;
}

// Named CSS colors (subset of most common)
// Named CSS colors - 24-bit RGB (0xRRGGBB) to match Bun.color("...", "number")
const NAMED_COLORS: Record<string, number> = {
	black: 0x000000,
	white: 0xffffff,
	red: 0xff0000,
	green: 0x008000,
	blue: 0x0000ff,
	yellow: 0xffff00,
	cyan: 0x00ffff,
	magenta: 0xff00ff,
	orange: 0xffa500,
	purple: 0x800080,
	pink: 0xffc0cb,
	gray: 0x808080,
	grey: 0x808080,
	silver: 0xc0c0c0,
	maroon: 0x800000,
	olive: 0x808000,
	lime: 0x00ff00,
	aqua: 0x00ffff,
	teal: 0x008080,
	navy: 0x000080,
	fuchsia: 0xff00ff,
	transparent: 0x000000,
};

function parseColor(color: string): number | null {
	color = color.trim().toLowerCase();

	// Named colors
	if (color in NAMED_COLORS) {
		return NAMED_COLORS[color];
	}

	// Hex colors - return 24-bit RGB
	if (color.startsWith("#")) {
		const hex = color.slice(1);
		let r: number, g: number, b: number;
		if (hex.length === 3 || hex.length === 4) {
			r = parseInt(hex[0] + hex[0], 16);
			g = parseInt(hex[1] + hex[1], 16);
			b = parseInt(hex[2] + hex[2], 16);
		} else if (hex.length === 6 || hex.length === 8) {
			r = parseInt(hex.slice(0, 2), 16);
			g = parseInt(hex.slice(2, 4), 16);
			b = parseInt(hex.slice(4, 6), 16);
		} else {
			return null;
		}
		if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
		return (r << 16) | (g << 8) | b;
	}

	// rgb()/rgba()
	const rgbMatch = color.match(
		/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/,
	);
	if (rgbMatch) {
		const r = parseInt(rgbMatch[1], 10);
		const g = parseInt(rgbMatch[2], 10);
		const b = parseInt(rgbMatch[3], 10);
		return (r << 16) | (g << 8) | b;
	}

	return null;
}

// Export runtime detection for conditional logic
export {isBun, isDeno};
