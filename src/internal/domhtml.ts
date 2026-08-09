/**
 * The HTML Standard's element table: which interface every tag is built
 * through, and the content attributes each interface reflects.
 *
 * This is data, not code. The classes the table names live in dom.ts, and
 * their members are installed from here, because each evaluation of that
 * module is its own realm -- a test that replaces
 * `HTMLDivElement.prototype.align` must not reach the next one -- and a class
 * built in this module would be shared by every realm at once. Immutable
 * tables can be shared; constructors cannot.
 *
 * The members that are not reflections -- an input's value, a form's element
 * list, an anchor's URL decomposition, an activation behavior -- are written
 * out in dom.ts beside the class they belong to.
 */

/**
 * How a content attribute is reflected by an IDL attribute.
 *
 * - `string`: a DOMString, the empty string when the attribute is absent.
 * - `url`: a URL, resolved against the document's base URL on getting.
 * - `boolean`: present or absent.
 * - `long`, `unsigned-long`: a number parsed from the attribute, falling back
 *   to a default, with the range restrictions the attribute's definition
 *   names.
 * - `enum`: limited to only known values, with a missing-value default and an
 *   invalid-value default.
 * - `tokenlist`: a DOMTokenList over the attribute's tokens.
 * - `nullable-string`: a DOMString?, null when the attribute is absent.
 */
export type ReflectKind =
	| "string"
	| "nullable-string"
	| "url"
	| "boolean"
	| "long"
	| "unsigned-long"
	| "enum"
	| "tokenlist";

export interface ReflectSpec {
	property: string;
	attribute: string;
	kind: ReflectKind;
	/** The value a number-valued attribute takes when it is absent or unparsable. */
	fallback?: number;
	/** An enumerated attribute's known values, in their canonical spelling. */
	keywords?: readonly string[];
	/** The state an enumerated attribute takes when it is absent. */
	missing?: string;
	/** The state an enumerated attribute takes when its value is not known. */
	invalid?: string;
	/** Limited to only non-negative numbers: a negative set throws. */
	nonNegative?: boolean;
	/** Limited to only non-negative numbers greater than zero: a zero set throws. */
	greaterThanZero?: boolean;
	/** Clamped to a range on both getting and setting. */
	clampMin?: number;
	clampMax?: number;
	/** The tokens a DOMTokenList-reflecting attribute supports. */
	supported?: readonly string[];
	/** An enumerated attribute whose missing-value default is null. */
	nullable?: boolean;
}

export interface InterfaceSpec {
	/** The interface's name, which is also its Symbol.toStringTag. */
	name: string;
	/** The interface it inherits from; HTMLElement where this is absent. */
	base?: string;
	/** The tags built through it. */
	tags: readonly string[];
	/** The attributes it reflects. */
	reflect?: readonly ReflectSpec[];
}

const str = (
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec => ({
	property,
	attribute,
	kind: "string",
});

const url = (
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec => ({
	property,
	attribute,
	kind: "url",
});

const bool = (
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec => ({
	property,
	attribute,
	kind: "boolean",
});

const long = (
	property: string,
	attribute: string,
	fallback: number,
	nonNegative = false,
): ReflectSpec => ({
	property,
	attribute,
	kind: "long",
	fallback,
	nonNegative,
});

const ulong = (
	property: string,
	attribute: string,
	fallback: number,
	extra: Partial<ReflectSpec> = {},
): ReflectSpec => ({
	property,
	attribute,
	kind: "unsigned-long",
	fallback,
	...extra,
});

const keyword = (
	property: string,
	attribute: string,
	keywords: readonly string[],
	missing: string,
	invalid: string,
): ReflectSpec => ({
	property,
	attribute,
	kind: "enum",
	keywords,
	missing,
	invalid,
});

const tokens = (
	property: string,
	attribute: string,
	supported: readonly string[] = [],
): ReflectSpec => ({
	property,
	attribute,
	kind: "tokenlist",
	supported,
});

/** The referrer policies every attribute that names one is limited to. */
const REFERRER_POLICIES = [
	"",
	"no-referrer",
	"no-referrer-when-downgrade",
	"same-origin",
	"origin",
	"strict-origin",
	"origin-when-cross-origin",
	"strict-origin-when-cross-origin",
	"unsafe-url",
];

const referrerPolicy = (): ReflectSpec =>
	keyword("referrerPolicy", "referrerpolicy", REFERRER_POLICIES, "", "");

const crossOrigin = (): ReflectSpec => ({
	property: "crossOrigin",
	attribute: "crossorigin",
	kind: "enum",
	keywords: ["anonymous", "use-credentials"],
	nullable: true,
	missing: "",
	invalid: "anonymous",
});

const fetchPriority = (): ReflectSpec =>
	keyword(
		"fetchPriority",
		"fetchpriority",
		["high", "low", "auto"],
		"auto",
		"auto",
	);

const loading = (): ReflectSpec =>
	keyword("loading", "loading", ["lazy", "eager"], "eager", "eager");

/** The keywords a table cell, row, section or column aligns its content by. */
const CELL_ALIGN = [
	str("align"),
	str("ch", "char"),
	str("chOff", "charoff"),
	str("vAlign", "valign"),
];

/** The form-submission attributes a submit button carries. */
const FORM_SUBMISSION = [
	url("formAction", "formaction"),
	keyword(
		"formEnctype",
		"formenctype",
		["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"],
		"application/x-www-form-urlencoded",
		"application/x-www-form-urlencoded",
	),
	keyword("formMethod", "formmethod", ["get", "post", "dialog"], "get", "get"),
	bool("formNoValidate", "formnovalidate"),
	str("formTarget", "formtarget"),
];

/**
 * The global attributes HTMLElement reflects plainly. The ones that are not
 * plain -- an inherited translate or spellcheck, a hidden that is `any`, a
 * tabIndex whose default depends on the element -- are written out in dom.ts.
 */
export const HTML_ELEMENT_REFLECTIONS: readonly ReflectSpec[] = [
	str("title"),
	str("lang"),
	str("accessKey", "accesskey"),
	bool("autofocus"),
	bool("inert"),
	str("nonce"),
	keyword("dir", "dir", ["ltr", "rtl", "auto"], "", ""),
	keyword(
		"enterKeyHint",
		"enterkeyhint",
		["enter", "done", "go", "next", "previous", "search", "send"],
		"",
		"",
	),
	keyword(
		"inputMode",
		"inputmode",
		["none", "text", "tel", "url", "email", "numeric", "decimal", "search"],
		"",
		"",
	),
	keyword(
		"writingSuggestions",
		"writingsuggestions",
		["true", "false"],
		"true",
		"true",
	),
	{
		property: "popover",
		attribute: "popover",
		kind: "enum",
		keywords: ["auto", "manual", "hint"],
		nullable: true,
		missing: "",
		invalid: "manual",
	},
];

/**
 * The per-tag interface table.
 *
 * A tag that names no entry here is HTMLElement where HTML knows the name and
 * HTMLUnknownElement where it does not.
 */
export const HTML_INTERFACES: readonly InterfaceSpec[] = [
	{
		name: "HTMLHtmlElement",
		tags: ["html"],
		reflect: [str("version")],
	},
	{name: "HTMLHeadElement", tags: ["head"]},
	{name: "HTMLTitleElement", tags: ["title"]},
	{
		name: "HTMLBaseElement",
		tags: ["base"],
		reflect: [str("target")],
	},
	{
		name: "HTMLLinkElement",
		tags: ["link"],
		reflect: [
			url("href"),
			crossOrigin(),
			str("rel"),
			keyword(
				"as",
				"as",
				[
					"fetch",
					"audio",
					"audioworklet",
					"document",
					"embed",
					"font",
					"frame",
					"iframe",
					"image",
					"json",
					"manifest",
					"object",
					"paintworklet",
					"report",
					"script",
					"serviceworker",
					"sharedworker",
					"style",
					"track",
					"video",
					"webidentity",
					"worker",
					"xslt",
				],
				"",
				"",
			),
			str("media"),
			str("integrity"),
			str("hreflang"),
			str("type"),
			str("imageSrcset", "imagesrcset"),
			str("imageSizes", "imagesizes"),
			referrerPolicy(),
			fetchPriority(),
			bool("disabled"),
			tokens("relList", "rel"),
			tokens("sizes", "sizes"),
			tokens("blocking", "blocking", ["render"]),
			str("charset"),
			str("rev"),
			str("target"),
		],
	},
	{
		name: "HTMLMetaElement",
		tags: ["meta"],
		reflect: [
			str("name"),
			str("httpEquiv", "http-equiv"),
			str("content"),
			str("media"),
			str("scheme"),
		],
	},
	{
		name: "HTMLStyleElement",
		tags: ["style"],
		reflect: [
			str("media"),
			tokens("blocking", "blocking", ["render"]),
			str("type"),
		],
	},
	{
		name: "HTMLBodyElement",
		tags: ["body"],
		reflect: [
			str("text"),
			str("link"),
			str("vLink", "vlink"),
			str("aLink", "alink"),
			str("bgColor", "bgcolor"),
			str("background"),
		],
	},
	{
		name: "HTMLHeadingElement",
		tags: ["h1", "h2", "h3", "h4", "h5", "h6"],
		reflect: [str("align")],
	},
	{
		name: "HTMLParagraphElement",
		tags: ["p"],
		reflect: [str("align")],
	},
	{
		name: "HTMLHRElement",
		tags: ["hr"],
		reflect: [
			str("align"),
			str("color"),
			bool("noShade", "noshade"),
			str("size"),
			str("width"),
		],
	},
	{
		name: "HTMLPreElement",
		tags: ["pre", "listing", "xmp"],
		reflect: [long("width", "width", 0)],
	},
	{
		name: "HTMLQuoteElement",
		tags: ["blockquote", "q"],
		reflect: [url("cite")],
	},
	{
		name: "HTMLOListElement",
		tags: ["ol"],
		reflect: [
			bool("reversed"),
			long("start", "start", 1),
			str("type"),
			bool("compact"),
		],
	},
	{
		name: "HTMLUListElement",
		tags: ["ul"],
		reflect: [bool("compact"), str("type")],
	},
	{
		name: "HTMLMenuElement",
		tags: ["menu"],
		reflect: [bool("compact")],
	},
	{
		name: "HTMLLIElement",
		tags: ["li"],
		reflect: [long("value", "value", 0), str("type")],
	},
	{
		name: "HTMLDListElement",
		tags: ["dl"],
		reflect: [bool("compact")],
	},
	{
		name: "HTMLDivElement",
		tags: ["div"],
		reflect: [str("align")],
	},
	{
		name: "HTMLAnchorElement",
		tags: ["a"],
		reflect: [
			str("target"),
			str("download"),
			str("ping"),
			str("rel"),
			tokens("relList", "rel"),
			str("hreflang"),
			str("type"),
			referrerPolicy(),
			str("coords"),
			str("charset"),
			str("name"),
			str("rev"),
			str("shape"),
		],
	},
	{
		name: "HTMLDataElement",
		tags: ["data"],
		reflect: [str("value")],
	},
	{
		name: "HTMLTimeElement",
		tags: ["time"],
		reflect: [str("dateTime", "datetime")],
	},
	{name: "HTMLSpanElement", tags: ["span"]},
	{
		name: "HTMLBRElement",
		tags: ["br"],
		reflect: [str("clear")],
	},
	{
		name: "HTMLModElement",
		tags: ["ins", "del"],
		reflect: [url("cite"), str("dateTime", "datetime")],
	},
	{name: "HTMLPictureElement", tags: ["picture"]},
	{
		name: "HTMLSourceElement",
		tags: ["source"],
		reflect: [
			url("src"),
			str("type"),
			str("srcset"),
			str("sizes"),
			str("media"),
			ulong("width", "width", 0),
			ulong("height", "height", 0),
		],
	},
	{
		name: "HTMLImageElement",
		tags: ["img"],
		reflect: [
			str("alt"),
			url("src"),
			str("srcset"),
			str("sizes"),
			crossOrigin(),
			str("useMap", "usemap"),
			bool("isMap", "ismap"),
			ulong("width", "width", 0),
			ulong("height", "height", 0),
			referrerPolicy(),
			keyword(
				"decoding",
				"decoding",
				["sync", "async", "auto"],
				"auto",
				"auto",
			),
			loading(),
			fetchPriority(),
			str("name"),
			str("lowsrc"),
			str("align"),
			ulong("hspace", "hspace", 0),
			ulong("vspace", "vspace", 0),
			url("longDesc", "longdesc"),
			str("border"),
		],
	},
	{
		name: "HTMLIFrameElement",
		tags: ["iframe"],
		reflect: [
			url("src"),
			str("srcdoc"),
			str("name"),
			tokens("sandbox", "sandbox", [
				"allow-downloads",
				"allow-forms",
				"allow-modals",
				"allow-orientation-lock",
				"allow-pointer-lock",
				"allow-popups",
				"allow-popups-to-escape-sandbox",
				"allow-presentation",
				"allow-same-origin",
				"allow-scripts",
				"allow-top-navigation",
				"allow-top-navigation-by-user-activation",
				"allow-top-navigation-to-custom-protocols",
			]),
			str("allow"),
			bool("allowFullscreen", "allowfullscreen"),
			str("width"),
			str("height"),
			referrerPolicy(),
			loading(),
			str("align"),
			str("scrolling"),
			str("frameBorder", "frameborder"),
			url("longDesc", "longdesc"),
			str("marginHeight", "marginheight"),
			str("marginWidth", "marginwidth"),
		],
	},
	{
		name: "HTMLEmbedElement",
		tags: ["embed"],
		reflect: [
			url("src"),
			str("type"),
			str("width"),
			str("height"),
			str("align"),
			str("name"),
		],
	},
	{
		name: "HTMLObjectElement",
		tags: ["object"],
		reflect: [
			url("data"),
			str("type"),
			str("name"),
			str("width"),
			str("height"),
			str("align"),
			str("archive"),
			str("code"),
			bool("declare"),
			ulong("hspace", "hspace", 0),
			str("standby"),
			ulong("vspace", "vspace", 0),
			url("codeBase", "codebase"),
			str("codeType", "codetype"),
			str("useMap", "usemap"),
			str("border"),
		],
	},
	{
		name: "HTMLMediaElement",
		tags: [],
		reflect: [
			url("src"),
			crossOrigin(),
			keyword(
				"preload",
				"preload",
				["none", "metadata", "auto"],
				"metadata",
				"metadata",
			),
			bool("autoplay"),
			bool("loop"),
			bool("controls"),
			bool("defaultMuted", "muted"),
		],
	},
	{
		name: "HTMLVideoElement",
		base: "HTMLMediaElement",
		tags: ["video"],
		reflect: [
			ulong("width", "width", 0),
			ulong("height", "height", 0),
			url("poster"),
			bool("playsInline", "playsinline"),
		],
	},
	{name: "HTMLAudioElement", base: "HTMLMediaElement", tags: ["audio"]},
	{
		name: "HTMLTrackElement",
		tags: ["track"],
		reflect: [
			keyword(
				"kind",
				"kind",
				["subtitles", "captions", "descriptions", "chapters", "metadata"],
				"subtitles",
				"metadata",
			),
			url("src"),
			str("srclang"),
			str("label"),
			bool("default"),
		],
	},
	{
		name: "HTMLMapElement",
		tags: ["map"],
		reflect: [str("name")],
	},
	{
		name: "HTMLAreaElement",
		tags: ["area"],
		reflect: [
			str("alt"),
			str("coords"),
			str("shape"),
			str("target"),
			str("download"),
			str("ping"),
			str("rel"),
			tokens("relList", "rel"),
			referrerPolicy(),
			bool("noHref", "nohref"),
		],
	},
	{
		name: "HTMLTableElement",
		tags: ["table"],
		reflect: [
			str("align"),
			str("border"),
			str("frame"),
			str("rules"),
			str("summary"),
			str("width"),
			str("bgColor", "bgcolor"),
			str("cellPadding", "cellpadding"),
			str("cellSpacing", "cellspacing"),
		],
	},
	{
		name: "HTMLTableCaptionElement",
		tags: ["caption"],
		reflect: [str("align")],
	},
	{
		name: "HTMLTableColElement",
		tags: ["col", "colgroup"],
		reflect: [
			ulong("span", "span", 1, {clampMin: 1, clampMax: 1000}),
			...CELL_ALIGN,
			str("width"),
		],
	},
	{
		name: "HTMLTableSectionElement",
		tags: ["thead", "tbody", "tfoot"],
		reflect: CELL_ALIGN,
	},
	{
		name: "HTMLTableRowElement",
		tags: ["tr"],
		reflect: [...CELL_ALIGN, str("bgColor", "bgcolor")],
	},
	{
		name: "HTMLTableCellElement",
		tags: ["td", "th"],
		reflect: [
			ulong("colSpan", "colspan", 1, {clampMin: 1, clampMax: 1000}),
			ulong("rowSpan", "rowspan", 1, {clampMin: 0, clampMax: 65534}),
			tokens("headers", "headers"),
			keyword("scope", "scope", ["row", "col", "rowgroup", "colgroup"], "", ""),
			str("abbr"),
			str("align"),
			str("axis"),
			str("height"),
			str("width"),
			str("ch", "char"),
			str("chOff", "charoff"),
			bool("noWrap", "nowrap"),
			str("vAlign", "valign"),
			str("bgColor", "bgcolor"),
		],
	},
	{
		name: "HTMLFormElement",
		tags: ["form"],
		reflect: [
			str("acceptCharset", "accept-charset"),
			url("action"),
			keyword("autocomplete", "autocomplete", ["on", "off"], "on", "on"),
			keyword(
				"enctype",
				"enctype",
				[
					"application/x-www-form-urlencoded",
					"multipart/form-data",
					"text/plain",
				],
				"application/x-www-form-urlencoded",
				"application/x-www-form-urlencoded",
			),
			keyword("method", "method", ["get", "post", "dialog"], "get", "get"),
			str("name"),
			bool("noValidate", "novalidate"),
			str("target"),
			str("rel"),
			tokens("relList", "rel"),
		],
	},
	{
		name: "HTMLLabelElement",
		tags: ["label"],
		reflect: [str("htmlFor", "for")],
	},
	{
		name: "HTMLInputElement",
		tags: ["input"],
		reflect: [
			keyword(
				"type",
				"type",
				[
					"hidden",
					"text",
					"search",
					"tel",
					"url",
					"email",
					"password",
					"date",
					"month",
					"week",
					"time",
					"datetime-local",
					"number",
					"range",
					"color",
					"checkbox",
					"radio",
					"file",
					"submit",
					"image",
					"reset",
					"button",
				],
				"text",
				"text",
			),
			str("accept"),
			str("alt"),
			keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
			bool("defaultChecked", "checked"),
			str("defaultValue", "value"),
			str("dirName", "dirname"),
			bool("disabled"),
			...FORM_SUBMISSION,
			str("max"),
			long("maxLength", "maxlength", -1, true),
			str("min"),
			long("minLength", "minlength", -1, true),
			bool("multiple"),
			str("name"),
			str("pattern"),
			str("placeholder"),
			bool("readOnly", "readonly"),
			bool("required"),
			ulong("size", "size", 20, {greaterThanZero: true}),
			url("src"),
			str("step"),
			str("useMap", "usemap"),
			str("align"),
			ulong("height", "height", 0),
			ulong("width", "width", 0),
		],
	},
	{
		name: "HTMLButtonElement",
		tags: ["button"],
		reflect: [
			bool("disabled"),
			...FORM_SUBMISSION,
			str("name"),
			keyword(
				"type",
				"type",
				["submit", "reset", "button"],
				"submit",
				"submit",
			),
			str("value"),
		],
	},
	{
		name: "HTMLSelectElement",
		tags: ["select"],
		reflect: [
			keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
			bool("disabled"),
			bool("multiple"),
			str("name"),
			bool("required"),
			ulong("size", "size", 0),
		],
	},
	{name: "HTMLDataListElement", tags: ["datalist"]},
	{
		name: "HTMLOptGroupElement",
		tags: ["optgroup"],
		reflect: [bool("disabled"), str("label")],
	},
	{
		name: "HTMLOptionElement",
		tags: ["option"],
		reflect: [bool("disabled"), bool("defaultSelected", "selected")],
	},
	{
		name: "HTMLTextAreaElement",
		tags: ["textarea"],
		reflect: [
			keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
			ulong("cols", "cols", 20, {greaterThanZero: true}),
			str("dirName", "dirname"),
			bool("disabled"),
			long("maxLength", "maxlength", -1, true),
			long("minLength", "minlength", -1, true),
			str("name"),
			str("placeholder"),
			bool("readOnly", "readonly"),
			bool("required"),
			ulong("rows", "rows", 2, {greaterThanZero: true}),
			keyword("wrap", "wrap", ["soft", "hard"], "soft", "soft"),
		],
	},
	{
		name: "HTMLOutputElement",
		tags: ["output"],
		reflect: [tokens("htmlFor", "for"), str("name")],
	},
	// A progress bar and a gauge reflect nothing plainly: every number they
	// carry is read against the others, so all of them are written out.
	{name: "HTMLProgressElement", tags: ["progress"]},
	{name: "HTMLMeterElement", tags: ["meter"]},
	{
		name: "HTMLFieldSetElement",
		tags: ["fieldset"],
		reflect: [bool("disabled"), str("name")],
	},
	{
		name: "HTMLLegendElement",
		tags: ["legend"],
		reflect: [str("align")],
	},
	{
		name: "HTMLDetailsElement",
		tags: ["details"],
		reflect: [str("name"), bool("open")],
	},
	{
		name: "HTMLDialogElement",
		tags: ["dialog"],
		reflect: [
			bool("open"),
			keyword(
				"closedBy",
				"closedby",
				["any", "closerequest", "none"],
				"",
				"auto",
			),
		],
	},
	{
		name: "HTMLScriptElement",
		tags: ["script"],
		reflect: [
			url("src"),
			str("type"),
			bool("noModule", "nomodule"),
			bool("defer"),
			crossOrigin(),
			str("integrity"),
			referrerPolicy(),
			fetchPriority(),
			tokens("blocking", "blocking", ["render"]),
			str("charset"),
			str("event"),
			str("htmlFor", "for"),
		],
	},
	{
		name: "HTMLCanvasElement",
		tags: ["canvas"],
		reflect: [ulong("width", "width", 300), ulong("height", "height", 150)],
	},
	{
		name: "HTMLDirectoryElement",
		tags: ["dir"],
		reflect: [bool("compact")],
	},
	{
		name: "HTMLFontElement",
		tags: ["font"],
		reflect: [str("color"), str("face"), str("size")],
	},
	{
		name: "HTMLFrameElement",
		tags: ["frame"],
		reflect: [
			str("name"),
			str("scrolling"),
			url("src"),
			str("frameBorder", "frameborder"),
			url("longDesc", "longdesc"),
			bool("noResize", "noresize"),
			str("marginHeight", "marginheight"),
			str("marginWidth", "marginwidth"),
		],
	},
	{
		name: "HTMLFrameSetElement",
		tags: ["frameset"],
		reflect: [str("cols"), str("rows")],
	},
	{
		name: "HTMLMarqueeElement",
		tags: ["marquee"],
		reflect: [
			str("behavior"),
			str("bgColor", "bgcolor"),
			str("direction"),
			str("height"),
			ulong("hspace", "hspace", 0),
			str("scrollAmount", "scrollamount"),
			str("scrollDelay", "scrolldelay"),
			bool("trueSpeed", "truespeed"),
			ulong("vspace", "vspace", 0),
			str("width"),
		],
	},
	{
		name: "HTMLParamElement",
		tags: ["param"],
		reflect: [
			str("name"),
			str("value"),
			str("type"),
			str("valueType", "valuetype"),
		],
	},
];

/**
 * The names HTML gives no interface of their own: an element of one of these
 * is an HTMLElement.
 */
export const HTML_ELEMENT_TAGS: readonly string[] = [
	"abbr",
	"acronym",
	"address",
	"article",
	"aside",
	"b",
	"basefont",
	"bdi",
	"bdo",
	"big",
	"center",
	"cite",
	"code",
	"dd",
	"dfn",
	"dt",
	"em",
	"figcaption",
	"figure",
	"footer",
	"header",
	"hgroup",
	"i",
	"kbd",
	"main",
	"mark",
	"nav",
	"nobr",
	"noembed",
	"noframes",
	"noscript",
	"plaintext",
	"rb",
	"rp",
	"rt",
	"rtc",
	"ruby",
	"s",
	"samp",
	"search",
	"section",
	"small",
	"strike",
	"strong",
	"sub",
	"summary",
	"sup",
	"tt",
	"u",
	"var",
	"wbr",
];

/**
 * The names HTML knows and gives HTMLUnknownElement to anyway. Every name HTML
 * does not know at all lands there too, so this list only matters for the ones
 * a parser still recognizes.
 */
export const HTML_UNKNOWN_TAGS: readonly string[] = [
	"applet",
	"bgsound",
	"blink",
	"isindex",
	"keygen",
	"multicol",
	"nextid",
	"spacer",
];

/**
 * The ARIA mixin's string-valued members, each reflecting one aria-* content
 * attribute as a nullable DOMString.
 */
export const ARIA_STRING_REFLECTIONS: ReadonlyArray<readonly [string, string]> =
	[
		["role", "role"],
		["ariaAtomic", "aria-atomic"],
		["ariaAutoComplete", "aria-autocomplete"],
		["ariaBrailleLabel", "aria-braillelabel"],
		["ariaBrailleRoleDescription", "aria-brailleroledescription"],
		["ariaBusy", "aria-busy"],
		["ariaChecked", "aria-checked"],
		["ariaColCount", "aria-colcount"],
		["ariaColIndex", "aria-colindex"],
		["ariaColIndexText", "aria-colindextext"],
		["ariaColSpan", "aria-colspan"],
		["ariaCurrent", "aria-current"],
		["ariaDescription", "aria-description"],
		["ariaDisabled", "aria-disabled"],
		["ariaExpanded", "aria-expanded"],
		["ariaHasPopup", "aria-haspopup"],
		["ariaHidden", "aria-hidden"],
		["ariaInvalid", "aria-invalid"],
		["ariaKeyShortcuts", "aria-keyshortcuts"],
		["ariaLabel", "aria-label"],
		["ariaLevel", "aria-level"],
		["ariaLive", "aria-live"],
		["ariaModal", "aria-modal"],
		["ariaMultiLine", "aria-multiline"],
		["ariaMultiSelectable", "aria-multiselectable"],
		["ariaOrientation", "aria-orientation"],
		["ariaPlaceholder", "aria-placeholder"],
		["ariaPosInSet", "aria-posinset"],
		["ariaPressed", "aria-pressed"],
		["ariaReadOnly", "aria-readonly"],
		["ariaRelevant", "aria-relevant"],
		["ariaRequired", "aria-required"],
		["ariaRoleDescription", "aria-roledescription"],
		["ariaRowCount", "aria-rowcount"],
		["ariaRowIndex", "aria-rowindex"],
		["ariaRowIndexText", "aria-rowindextext"],
		["ariaRowSpan", "aria-rowspan"],
		["ariaSelected", "aria-selected"],
		["ariaSetSize", "aria-setsize"],
		["ariaSort", "aria-sort"],
		["ariaValueMax", "aria-valuemax"],
		["ariaValueMin", "aria-valuemin"],
		["ariaValueNow", "aria-valuenow"],
		["ariaValueText", "aria-valuetext"],
	];

/**
 * The ARIA mixin's element-reference members: a property naming one element
 * or a list of them, the content attribute it reflects, and whether it is a
 * list.
 */
export const ARIA_ELEMENT_REFLECTIONS: ReadonlyArray<
	readonly [string, string, boolean]
> = [
	["ariaActiveDescendantElement", "aria-activedescendant", false],
	["ariaControlsElements", "aria-controls", true],
	["ariaDescribedByElements", "aria-describedby", true],
	["ariaDetailsElements", "aria-details", true],
	["ariaErrorMessageElements", "aria-errormessage", true],
	["ariaFlowToElements", "aria-flowto", true],
	["ariaLabelledByElements", "aria-labelledby", true],
	["ariaOwnsElements", "aria-owns", true],
];
