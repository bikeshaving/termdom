/**
 * CSS color parsing: a color string to packed 24-bit RGB (0xRRGGBB), or null.
 *
 * Named colors, #hex, rgb()/rgba(), and hsl()/hsla(). The NAMED_COLORS table is
 * generated from Bun.color so the pure-JS path agrees with Bun exactly. A leaf
 * with no dependencies, consumed by the cascade (styles) and termdom.
 */

// Named CSS colors, 24-bit RGB (0xRRGGBB), matching Bun.color(name, "number").
// Generated from Bun.color so the two agree exactly.
const NAMED_COLORS: Record<string, number> = {
	aliceblue: 0xf0f8ff,
	antiquewhite: 0xfaebd7,
	aqua: 0x00ffff,
	aquamarine: 0x7fffd4,
	azure: 0xf0ffff,
	beige: 0xf5f5dc,
	bisque: 0xffe4c4,
	black: 0x000000,
	blanchedalmond: 0xffebcd,
	blue: 0x0000ff,
	blueviolet: 0x8a2be2,
	brown: 0xa52a2a,
	burlywood: 0xdeb887,
	cadetblue: 0x5f9ea0,
	chartreuse: 0x7fff00,
	chocolate: 0xd2691e,
	coral: 0xff7f50,
	cornflowerblue: 0x6495ed,
	cornsilk: 0xfff8dc,
	crimson: 0xdc143c,
	cyan: 0x00ffff,
	darkblue: 0x00008b,
	darkcyan: 0x008b8b,
	darkgoldenrod: 0xb8860b,
	darkgray: 0xa9a9a9,
	darkgreen: 0x006400,
	darkgrey: 0xa9a9a9,
	darkkhaki: 0xbdb76b,
	darkmagenta: 0x8b008b,
	darkolivegreen: 0x556b2f,
	darkorange: 0xff8c00,
	darkorchid: 0x9932cc,
	darkred: 0x8b0000,
	darksalmon: 0xe9967a,
	darkseagreen: 0x8fbc8f,
	darkslateblue: 0x483d8b,
	darkslategray: 0x2f4f4f,
	darkslategrey: 0x2f4f4f,
	darkturquoise: 0x00ced1,
	darkviolet: 0x9400d3,
	deeppink: 0xff1493,
	deepskyblue: 0x00bfff,
	dimgray: 0x696969,
	dimgrey: 0x696969,
	dodgerblue: 0x1e90ff,
	firebrick: 0xb22222,
	floralwhite: 0xfffaf0,
	forestgreen: 0x228b22,
	fuchsia: 0xff00ff,
	gainsboro: 0xdcdcdc,
	ghostwhite: 0xf8f8ff,
	gold: 0xffd700,
	goldenrod: 0xdaa520,
	gray: 0x808080,
	green: 0x008000,
	greenyellow: 0xadff2f,
	grey: 0x808080,
	honeydew: 0xf0fff0,
	hotpink: 0xff69b4,
	indianred: 0xcd5c5c,
	indigo: 0x4b0082,
	ivory: 0xfffff0,
	khaki: 0xf0e68c,
	lavender: 0xe6e6fa,
	lavenderblush: 0xfff0f5,
	lawngreen: 0x7cfc00,
	lemonchiffon: 0xfffacd,
	lightblue: 0xadd8e6,
	lightcoral: 0xf08080,
	lightcyan: 0xe0ffff,
	lightgoldenrodyellow: 0xfafad2,
	lightgray: 0xd3d3d3,
	lightgreen: 0x90ee90,
	lightgrey: 0xd3d3d3,
	lightpink: 0xffb6c1,
	lightsalmon: 0xffa07a,
	lightseagreen: 0x20b2aa,
	lightskyblue: 0x87cefa,
	lightslategray: 0x778899,
	lightslategrey: 0x778899,
	lightsteelblue: 0xb0c4de,
	lightyellow: 0xffffe0,
	lime: 0x00ff00,
	limegreen: 0x32cd32,
	linen: 0xfaf0e6,
	magenta: 0xff00ff,
	maroon: 0x800000,
	mediumaquamarine: 0x66cdaa,
	mediumblue: 0x0000cd,
	mediumorchid: 0xba55d3,
	mediumpurple: 0x9370db,
	mediumseagreen: 0x3cb371,
	mediumslateblue: 0x7b68ee,
	mediumspringgreen: 0x00fa9a,
	mediumturquoise: 0x48d1cc,
	mediumvioletred: 0xc71585,
	midnightblue: 0x191970,
	mintcream: 0xf5fffa,
	mistyrose: 0xffe4e1,
	moccasin: 0xffe4b5,
	navajowhite: 0xffdead,
	navy: 0x000080,
	oldlace: 0xfdf5e6,
	olive: 0x808000,
	olivedrab: 0x6b8e23,
	orange: 0xffa500,
	orangered: 0xff4500,
	orchid: 0xda70d6,
	palegoldenrod: 0xeee8aa,
	palegreen: 0x98fb98,
	paleturquoise: 0xafeeee,
	palevioletred: 0xdb7093,
	papayawhip: 0xffefd5,
	peachpuff: 0xffdab9,
	peru: 0xcd853f,
	pink: 0xffc0cb,
	plum: 0xdda0dd,
	powderblue: 0xb0e0e6,
	purple: 0x800080,
	rebeccapurple: 0x663399,
	red: 0xff0000,
	rosybrown: 0xbc8f8f,
	royalblue: 0x4169e1,
	saddlebrown: 0x8b4513,
	salmon: 0xfa8072,
	sandybrown: 0xf4a460,
	seagreen: 0x2e8b57,
	seashell: 0xfff5ee,
	sienna: 0xa0522d,
	silver: 0xc0c0c0,
	skyblue: 0x87ceeb,
	slateblue: 0x6a5acd,
	slategray: 0x708090,
	slategrey: 0x708090,
	snow: 0xfffafa,
	springgreen: 0x00ff7f,
	steelblue: 0x4682b4,
	tan: 0xd2b48c,
	teal: 0x008080,
	thistle: 0xd8bfd8,
	tomato: 0xff6347,
	transparent: 0x000000,
	turquoise: 0x40e0d0,
	violet: 0xee82ee,
	wheat: 0xf5deb3,
	white: 0xffffff,
	whitesmoke: 0xf5f5f5,
	yellow: 0xffff00,
	yellowgreen: 0x9acd32,
};

/**
 * The CSS system colors, mapped onto what a terminal already has: its default
 * colors and the theme-resolved ANSI palette. A system color names whatever
 * the user's environment says, which is the same contract the palette keeps,
 * so the mapping invents no colors. 0 is the cell grid's "no SGR color"
 * sentinel -- the terminal's own default foreground or background -- and a
 * nonzero value is packed RGB that the emitter renders at any color depth.
 *
 * Canvas, CanvasText, Highlight and HighlightText keep their special painter
 * translations (default-background clear, default foreground, SGR inverse);
 * the values here only answer for the paths those guards do not intercept,
 * such as a border or outline color.
 */
const SYSTEM_COLORS: Record<string, number> = {
	accentcolor: 0x0000ff, // the accent: blue
	accentcolortext: 0, // text on the accent: the terminal's default background
	activetext: 0xff0000, // an active link: red
	buttonborder: 0, // a control's border: the default foreground
	buttonface: 0, // a control's face: the default background
	buttontext: 0, // a control's label: the default foreground
	canvas: 0, // the document background: the default background
	canvastext: 0, // document text: the default foreground
	field: 0, // an input's background: the default background
	fieldtext: 0, // an input's text: the default foreground
	graytext: 0x808080, // disabled text: bright black, the dim gray
	highlight: 0x0000ff, // the selection, when inverse cannot express it: blue
	highlighttext: 0, // selected text, likewise: the default background
	linktext: 0x0000ff, // a link: blue
	mark: 0xffff00, // a <mark>'s background: yellow
	marktext: 0, // a <mark>'s text: black, which this engine stores as 0
	selecteditem: 0x0000ff, // a selected item, when not inverse: blue
	selecteditemtext: 0, // its text, likewise: the default background
	visitedtext: 0xff00ff, // a visited link: magenta
	activeborder: 0, // deprecated -> ButtonBorder
	activecaption: 0, // deprecated -> Canvas
	appworkspace: 0, // deprecated -> Canvas
	background: 0, // deprecated -> Canvas
	buttonhighlight: 0, // deprecated -> ButtonFace
	buttonshadow: 0, // deprecated -> ButtonFace
	captiontext: 0, // deprecated -> CanvasText
	inactiveborder: 0, // deprecated -> ButtonBorder
	inactivecaption: 0, // deprecated -> Canvas
	inactivecaptiontext: 0x808080, // deprecated -> GrayText
	infobackground: 0, // deprecated -> Canvas
	infotext: 0, // deprecated -> CanvasText
	menu: 0, // deprecated -> Canvas
	menutext: 0, // deprecated -> CanvasText
	scrollbar: 0, // deprecated -> Canvas
	threeddarkshadow: 0, // deprecated -> ButtonBorder
	threedface: 0, // deprecated -> ButtonFace
	threedhighlight: 0, // deprecated -> ButtonBorder
	threedlightshadow: 0, // deprecated -> ButtonBorder
	threedshadow: 0, // deprecated -> ButtonBorder
	window: 0, // deprecated -> Canvas
	windowtext: 0, // deprecated -> CanvasText
};

/** A parsed CSS color: packed 24-bit RGB, and its alpha in [0, 1]. */
function parseColor(text: string): {color: number; alpha: number} | null {
	const color = text.trim().toLowerCase();

	if (color in NAMED_COLORS) {
		return {color: NAMED_COLORS[color], alpha: 1};
	}

	if (color.startsWith("#")) {
		const hex = color.slice(1);
		if (!/^[0-9a-f]+$/.test(hex)) {
			return null;
		}
		const short = hex.length === 3 || hex.length === 4;
		if (!short && hex.length !== 6 && hex.length !== 8) {
			return null;
		}
		const size = short ? 1 : 2;
		const channel = (index: number): number => {
			const part = hex.slice(index * size, (index + 1) * size);
			return parseInt(short ? part + part : part, 16);
		};
		const packed = (channel(0) << 16) | (channel(1) << 8) | channel(2);
		const alpha =
			hex.length === 4 || hex.length === 8 ? channel(3) / 255 : 1;
		return {color: packed, alpha};
	}

	const rgbMatch = color.match(
		/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?))?\s*\)/,
	);
	if (rgbMatch) {
		const r = parseInt(rgbMatch[1], 10);
		const g = parseInt(rgbMatch[2], 10);
		const b = parseInt(rgbMatch[3], 10);
		return {color: (r << 16) | (g << 8) | b, alpha: parseAlpha(rgbMatch[4])};
	}

	const hslMatch = color.match(
		/hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+%?))?\s*\)/,
	);
	if (hslMatch) {
		const h = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
		const s = Math.min(100, Math.max(0, parseFloat(hslMatch[2]))) / 100;
		const l = Math.min(100, Math.max(0, parseFloat(hslMatch[3]))) / 100;
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = l - c / 2;
		let r1 = 0,
			g1 = 0,
			b1 = 0;
		if (h < 60) {
			[r1, g1, b1] = [c, x, 0];
		} else if (h < 120) {
			[r1, g1, b1] = [x, c, 0];
		} else if (h < 180) {
			[r1, g1, b1] = [0, c, x];
		} else if (h < 240) {
			[r1, g1, b1] = [0, x, c];
		} else if (h < 300) {
			[r1, g1, b1] = [x, 0, c];
		}	else {
			[r1, g1, b1] = [c, 0, x];
		}
		const r = Math.round((r1 + m) * 255);
		const g = Math.round((g1 + m) * 255);
		const b = Math.round((b1 + m) * 255);
		return {color: (r << 16) | (g << 8) | b, alpha: parseAlpha(hslMatch[4])};
	}

	return null;
}

/** An alpha component: a number or a percentage, absent meaning opaque. */
function parseAlpha(raw: string | undefined): number {
	if (raw === undefined) {
		return 1;
	}
	const value = raw.endsWith("%") ?
		Number(raw.slice(0, -1)) / 100 :
			Number(raw);
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/**
 * Whether a color paints nothing: the `transparent` keyword, `none`, an empty
 * value, or any color whose alpha has reached zero.
 */
export function isTransparentColor(color: string): boolean {
	const text = color.trim().toLowerCase();
	if (!text || text === "transparent" || text === "none") {
		return true;
	}
	return parseColor(text)?.alpha === 0;
}

/**
 * A color's computed spelling: `rgb(r, g, b)`, or `rgba(r, g, b, a)` when it
 * is not opaque. Null for a value that names no color -- `currentcolor`
 * before it resolves, a keyword the color table does not carry. A system
 * color is deliberately null: it computes as its keyword, since the value it
 * stands for belongs to the terminal's theme and this process cannot state it
 * as an rgb().
 */
export function serializeCSSColor(value: string): string | null {
	const components = parseCSSColorComponents(value);
	if (components === null) {
		return null;
	}
	const [red, green, blue] = components;
	if (components[3] < 1) {
		const alpha = Math.round(components[3] * 1000) / 1000;
		return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
	}
	return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * A color's channels: [red, green, blue, alpha]. Null for a value this
 * process cannot state channels for -- `currentcolor` before it resolves,
 * a system color, an unknown keyword.
 */
export function parseCSSColorComponents(
	value: string,
): [number, number, number, number] | null {
	const text = value.trim().toLowerCase();
	if (!text || text === "currentcolor") {
		return null;
	}
	if (text === "transparent") {
		return [0, 0, 0, 0];
	}
	const parsed = parseColor(text);
	if (parsed === null) {
		return null;
	}
	return [
		(parsed.color >> 16) & 0xff,
		(parsed.color >> 8) & 0xff,
		parsed.color & 0xff,
		parsed.alpha,
	];
}

/**
 * Parse a CSS color to packed 24-bit RGB (0xRRGGBB). A system color answers
 * through the palette mapping, where 0 is the terminal's own default color.
 * Empty, `transparent`, and `none` -- and anything unrecognized -- resolve to
 * 0: a painter has no null to carry into a cell.
 */
export function cssColorToNumber(cssColor: string): number {
	if (!cssColor || cssColor === "transparent" || cssColor === "none") {
		return 0;
	}
	const system = SYSTEM_COLORS[cssColor.trim().toLowerCase()];
	if (system !== undefined) {
		return system;
	}
	return parseColor(cssColor)?.color ?? 0;
}
