// No painter emits an attribute that did not come from a computed
// style. A selection is inverse because a rule here says
// Highlight/HighlightText.

// Parsed before UA_DOCUMENT_STYLES, so that sheet wins ties. What
// cannot be CSS (a select sized to its widest option, the size
// attribute) is handled by the cascade's getElementDefaults.
export const UA_ELEMENT_STYLES = `
	head { display: none; }
	link { display: none; }
	meta { display: none; }
	script { display: none; }
	style { display: none; }
	title { display: none; }
	article { display: block; }
	aside { display: block; }
	blockquote { display: block; }
	body { display: block; }
	dd { display: block; }
	details { display: block; }
	summary { display: block; cursor: pointer; }
	div { display: block; }
	dl { display: block; }
	dt { display: block; }
	fieldset { display: block; border: 1px solid; padding: 0 1ch; }
	legend { display: block; margin-top: -1px; font-weight: bold; }
	figcaption { display: block; }
	figure { display: block; }
	footer { display: block; }
	form { display: block; }
	h1 { display: block; }
	h2 { display: block; }
	h3 { display: block; }
	h4 { display: block; }
	h5 { display: block; }
	h6 { display: block; }
	header { display: block; }
	hr { display: block; border-top: 1px solid; }
	html { display: block; }
	li { display: list-item; }
	main { display: block; }
	nav { display: block; }
	ol { display: block; }
	p { display: block; }
	pre { display: block; white-space: pre; }
	progress { display: inline-block; width: 10ch; white-space: pre; }
	meter { display: inline-block; width: 10ch; white-space: pre; }
	section { display: block; }
	ul { display: block; }
	a { display: inline; }
	abbr { display: inline; }
	b { display: inline; font-weight: bold; }
	br { display: inline; }
	cite { display: inline; font-style: italic; }
	code { display: inline; background-color: rgba(0, 0, 0, 0.1); }
	dfn { display: inline; font-style: italic; }
	em { display: inline; font-style: italic; }
	i { display: inline; font-style: italic; }
	kbd { display: inline; font-weight: bold; text-decoration: underline; }
	label { display: inline; }
	mark { display: inline; }
	q { display: inline; }
	s { display: inline; text-decoration: line-through; }
	samp { display: inline; }
	slot { display: contents; }
	small { display: inline; font-weight: lighter; }
	span { display: inline; }
	strong { display: inline; font-weight: bold; }
	sub { display: inline; }
	sup { display: inline; }
	time { display: inline; }
	u { display: inline; text-decoration: underline; }
	var { display: inline; font-style: italic; }
	button { display: inline-block; cursor: pointer; }
	dialog { display: block; border: 1px solid; padding: 0 1ch; background-color: Canvas; }
	input { display: inline-block; white-space: pre; }
	select { display: inline-block; white-space: pre; }
	textarea { display: inline-block; border: 1px solid; padding: 0 1ch; white-space: pre-wrap; overflow-wrap: break-word; }
	caption { display: table-caption; }
	col { display: table-column; }
	colgroup { display: table-column-group; }
	table { display: table; border-collapse: collapse; }
	tbody { display: table-row-group; }
	td { display: table-cell; border-top-width: 1px; border-right-width: 1px; border-bottom-width: 1px; border-left-width: 1px; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid; padding-left: 1ch; padding-right: 1ch; }
	tfoot { display: table-footer-group; }
	th { display: table-cell; border-top-width: 1px; border-right-width: 1px; border-bottom-width: 1px; border-left-width: 1px; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid; padding-left: 1ch; padding-right: 1ch; font-weight: bold; }
	thead { display: table-header-group; }
	tr { display: table-row; }
	input[type=checkbox i], input[type=radio i] { width: 3ch; }
	input:focus, select:focus, button:focus {
		text-decoration-line: underline;
	}
`;

// Applies in every tree scope, as a browser's UA sheet styles shadow
// trees. A modal dialog centers by inset: 0 and auto margins, as a
// browser's sheet does. Its ::backdrop is Canvas because a cell cannot
// blend a scrim. A popover's ::backdrop is transparent, which keeps a
// dialog shown as a popover from clearing the viewport.
export const UA_DOCUMENT_STYLES = `
	*::selection { background-color: Highlight; color: HighlightText; }
	button::before { content: "[ "; }
	button::after { content: " ]"; }
	input[type=hidden i] { display: none !important; }
	[hidden]:not([hidden=until-found i]) { display: none; }
	a[href] { text-decoration: underline; }
	/*
	 * Explicit dir values as attribute selectors, so an unrecognized value
	 * matches nothing and inherits; :dir() carries the cases that read the
	 * content. The unicode-bidi halves are not here: nothing reads the
	 * property, since reordering runs per line over the paragraph direction.
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

// The value text node lays out and paints like any document text. The
// sync hides the placeholder inline whenever a value exists.
export const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

// The value and placeholder clip their text. The render loop sets
// scrollLeft to follow the caret. The outline paints as a bottom
// underline.
export const TEXT_CONTROL_UA_STYLES = `
	[part="value"], [part="placeholder"] { display: inline-block; white-space: pre; overflow: hidden; min-width: 1ch; max-width: 100%; vertical-align: top; }
	[part="placeholder"] { color: #808080; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

// The disclosure flips the content container's display inline from
// `open`, which hides a closed details' text children without any rule
// in the light tree.
export const DETAILS_UA_STYLES = `
	[part="details-content"] { display: block; }
`;

// The bar's width is the fraction filled. The groove follows it in the
// same clip, so an empty bar still reads as a bar.
const GAUGE_UA_STYLES = `
	[part="track"] { display: inline-block; width: 100%; overflow: hidden; white-space: pre; vertical-align: top; }
	[part="groove"] { color: #808080; font-weight: lighter; }
	[part="bar"] { display: inline-block; overflow: hidden; white-space: pre; vertical-align: top; }
`;

// An indeterminate bar has no bar at all. Only the groove shows.
export const PROGRESS_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"] { color: #5fafff; }
`;

// The level the value falls in against low/high/optimum is an
// attribute a rule matches, not a color the painter picks.
export const METER_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"][data-level="optimum"] { color: #5faf5f; }
	[part="bar"][data-level="suboptimum"] { color: #d7af5f; }
	[part="bar"][data-level="even-less-good"] { color: #d75f5f; }
`;

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
