/**
 * The user-agent stylesheets, and nothing else: the UA document sheet every
 * tree scope receives, and the sheets scoped to the form widgets' shadow
 * trees. CSS text in, CSS text out -- the cascade resolves it like any
 * author's, one origin lower.
 *
 * It anchors an invariant: no painter emits a terminal attribute that did not
 * come from a computed style. A selection is inverse video because a rule here
 * declares Highlight/HighlightText, which is CSS's spelling of swapping a
 * cell's colors -- load-bearing, not decorative.
 */
// ---- UA document stylesheet ----
/**
 * The UA DOCUMENT stylesheet. Rules here are UA origin (every author rule
 * outranks them) and, uniquely, apply in EVERY tree scope, exactly as a
 * browser's UA sheet styles shadow trees. The `::selection` rule is the
 * load-bearing one the header warns about: it is CSS's spelling of "swap the
 * cell's colors", which the selection painters translate to SGR 7.
 *
 * The two dialog rules are the same kind of load-bearing. A modal dialog is
 * a fixed box with `inset: 0` and auto margins on all four sides, which is
 * how a browser's own sheet centers one in the viewport -- the centering is
 * CSS, not a constant in the painter. Its `::backdrop` fills the viewport
 * with Canvas, the terminal's own background: a cell holds one color and
 * cannot blend a browser's translucent scrim, so the terminal-native reading
 * of "obscure the page" is to clear it. An author who wants a different one
 * writes `dialog::backdrop { background-color: ... }`, and `transparent`
 * removes it entirely.
 *
 * The popover rules are the dialog's, over an attribute instead of a method: a
 * popover is hidden until it is showing, and a showing one is the same fixed,
 * centered, bordered box on the terminal's own background. Its ::backdrop
 * paints nothing -- a browser's is transparent too, because a popover is a
 * thing over the page rather than a thing instead of it -- and the rule saying
 * so is what keeps a dialog shown as a popover from clearing the viewport.
 */
export const UA_DOCUMENT_STYLES = `
	*::selection { background-color: Highlight; color: HighlightText; }
	button::before { content: "[ "; }
	button::after { content: " ]"; }
	input[type=hidden i] { display: none !important; }
	a[href] { text-decoration: underline; }
	/*
	 * The dir attribute, so it reaches layout as the direction property it
	 * stands for. The Rendering section writes these over :dir() alone; the
	 * explicit values are spelled as attribute selectors instead, which say
	 * the same thing and leave an unrecognized value matching nothing, so it
	 * inherits its parent's direction as the directionality algorithm says.
	 * :dir() carries the cases that read the content: dir=auto, and a bdi
	 * with no attribute at all. It reads the first character rather than the
	 * first character with a strong direction, so auto content opening with
	 * digits or punctuation reads left-to-right.
	 *
	 * The unicode-bidi halves of the same rules are NOT here, and are named
	 * exclusions in tests/presentational-hints.test.ts: isolate on the flow
	 * elements and on [dir], isolate-override on bdo, plaintext on an auto
	 * input, textarea or pre, and bidi-override under ISO-8859-8. The property
	 * parses and computes but nothing reads it: reordering here runs per line
	 * over the paragraph direction, with no embedding levels for an isolate or
	 * an override to add.
	 */
	[dir=ltr i] { direction: ltr; }
	[dir=rtl i] { direction: rtl; }
	[dir=auto i]:dir(ltr), bdi:dir(ltr), input[type=tel i]:dir(ltr) { direction: ltr; }
	[dir=auto i]:dir(rtl), bdi:dir(rtl) { direction: rtl; }
	datalist { display: none; }
	dialog:not([open]) { display: none; }
	dialog:modal {
		position: fixed;
		top: 0; right: 0; bottom: 0; left: 0;
		margin: auto;
	}
	dialog::backdrop { background-color: Canvas; }
	[popover]:not(:popover-open):not(dialog[open]) { display: none; }
	dialog:popover-open { display: block; }
	[popover] {
		position: fixed;
		top: 0; right: 0; bottom: 0; left: 0;
		margin: auto;
		border: 1px solid;
		padding: 0 1ch;
		background-color: Canvas;
	}
	:popover-open::backdrop { background-color: transparent; }
	details > summary:first-of-type::before { content: "▸ "; }
	details[open] > summary:first-of-type::before { content: "▾ "; }
	summary:focus-visible { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
	legend::before, legend::after { content: " "; white-space: pre; }
	a[href]:focus-visible { background-color: Highlight; color: HighlightText; }
	button:focus-visible { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

// ---- Form-widget internal shadow stylesheets ----
/**
 * The UA stylesheet of a textarea's internal shadow tree. Unlike the input,
 * the textarea's parts render through the NORMAL pipeline -- the value text
 * node lays out, wraps and paints like any document text -- so these rules are
 * all there is: the placeholder's ghost gray, faint when the host is blurred,
 * hidden by the reconcile (an inline display:none) whenever a value exists,
 * and the focus outline, which the painter renders on the host's UA border
 * by repainting it in the outline color.
 */
export const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

/**
 * The UA stylesheet of an <input>'s internal shadow tree: the field design as
 * real, scoped CSS. The value and placeholder are single-line inline-blocks that
 * clip their text (the render loop sets scrollLeft to follow the caret); the
 * focus affordance is an `outline`, which the painter renders as a bottom
 * underline across the whole field in the outline color (a bordered field
 * would show it on the border instead). A blurred field carries no chrome.
 */
export const FIELD_UA_STYLES = `
	[part="value"], [part="placeholder"] { display: inline-block; white-space: pre; overflow: hidden; min-width: 1ch; max-width: 100%; vertical-align: top; }
	[part="placeholder"] { color: #808080; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

/**
 * The UA stylesheet of a details' internal shadow tree. The summary projects
 * through a bare slot; everything else projects into the content container,
 * a block whose display the disclosure flips inline from its `open` state --
 * which is what hides a closed details' body, text children included, with
 * no rule reaching into the light tree.
 */
export const DETAILS_UA_STYLES = `
	[part="details-content"] { display: block; }
`;

/**
 * The UA stylesheet of a progress bar's internal shadow tree.
 *
 * The track is the full-width box that clips; the bar is an inline-block whose
 * WIDTH is the fraction filled, so the fill is a real CSS length and the run of
 * block glyphs behind it is ordinary text. What follows the bar inside the same
 * clip is the groove, which is why an empty bar still reads as a bar.
 */
const GAUGE_UA_STYLES = `
	[part="track"] { display: inline-block; width: 100%; overflow: hidden; white-space: pre; vertical-align: top; }
	[part="groove"] { color: #808080; font-weight: lighter; }
	[part="bar"] { display: inline-block; overflow: hidden; white-space: pre; vertical-align: top; }
`;

/**
 * The UA stylesheet of a progress bar, on top of the shared gauge rules: a
 * determinate bar is the accent color, and an indeterminate one has no bar at
 * all, so the groove alone shows.
 */
export const PROGRESS_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"] { color: #5fafff; }
`;

/**
 * The UA stylesheet of a meter, on top of the shared gauge rules. A meter's
 * value is read against its low/high/optimum ranges, and the level that reading
 * produces is what colors the bar -- the browser's own three-way answer,
 * spelled as an attribute a rule matches rather than a color the painter picks.
 */
export const METER_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"][data-level="optimum"] { color: #5faf5f; }
	[part="bar"][data-level="suboptimum"] { color: #d7af5f; }
	[part="bar"][data-level="even-less-good"] { color: #d75f5f; }
`;

/**
 * The UA stylesheet of a select's internal shadow tree: the ▾ indicator is
 * faint -- affordance, not content. Everything else (the focused field's
 * underline included) inherits from the host's own defaults.
 */
export const SELECT_UA_STYLES = `
	[part="indicator"] { font-weight: lighter; }
	[part="picker"] {
		display: none;
		position: absolute;
		background-color: Canvas;
		text-decoration: none;
		border-top-width: 1px; border-right-width: 1px;
		border-bottom-width: 1px; border-left-width: 1px;
		border-top-style: solid; border-right-style: solid;
		border-bottom-style: solid; border-left-style: solid;
	}
	[part="option"] { display: block; white-space: pre; }
	[part="option"][data-highlighted] { background-color: Highlight; color: HighlightText; }
	[part="option"][data-disabled] { font-weight: lighter; }
	[part="optgroup"] { display: block; white-space: pre; font-weight: bold; }
	[part="option"][data-grouped] { padding-left: 2ch; }
`;
