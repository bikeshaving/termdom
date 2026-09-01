// `url` resolves against the document's base URL on getting.
type ReflectKind =
	"string" |
	"nullable-string" |
	"url" |
	"boolean" |
	"long" |
	"unsigned-long" |
	"enum" |
	"tokenlist";

export interface ReflectSpec {
	property: string;
	attribute: string;
	kind: ReflectKind;

	// A number's value when the attribute is absent or unparsable.
	fallback?: number;

	keywords?: readonly string[];

	missing?: string;

	invalid?: string;

	empty?: string;

	// A negative set throws.
	nonNegative?: boolean;

	// A zero set throws too.
	greaterThanZero?: boolean;

	clampMin?: number;
	clampMax?: number;

	supported?: readonly string[];

	nullable?: boolean;
}

interface InterfaceSpec {
	name: string;
	// Empty for an interface that only serves as a base.
	tags: readonly string[];
	reflect?: readonly ReflectSpec[];
}

function str(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "string",
	};
}

function url(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "url",
	};
}

function bool(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "boolean",
	};
}

function long(
	property: string,
	attribute: string,
	fallback: number,
	nonNegative = false,
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "long",
		fallback,
		nonNegative,
	};
}

function ulong(
	property: string,
	attribute: string,
	fallback: number,
	extra: Partial<ReflectSpec> = {},
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "unsigned-long",
		fallback,
		...extra,
	};
}

function keyword(
	property: string,
	attribute: string,
	keywords: readonly string[],
	missing: string,
	invalid: string,
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "enum",
		keywords,
		missing,
		invalid,
	};
}

function tokens(
	property: string,
	attribute: string,
	supported: readonly string[] = [],
): ReflectSpec {
	return {
		property,
		attribute,
		kind: "tokenlist",
		supported,
	};
}

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

function popoverTargetAction(): ReflectSpec {
	return keyword(
		"popoverTargetAction",
		"popovertargetaction",
		["toggle", "show", "hide"],
		"toggle",
		"toggle",
	);
}

function referrerPolicy(): ReflectSpec {
	return keyword("referrerPolicy", "referrerpolicy", REFERRER_POLICIES, "", "");
}

function crossOrigin(): ReflectSpec {
	return {
		property: "crossOrigin",
		attribute: "crossorigin",
		kind: "enum",
		keywords: ["anonymous", "use-credentials"],
		nullable: true,
		missing: "",
		invalid: "anonymous",
	};
}

function fetchPriority(): ReflectSpec {
	return keyword(
		"fetchPriority",
		"fetchpriority",
		["high", "low", "auto"],
		"auto",
		"auto",
	);
}

function loading(): ReflectSpec {
	return keyword("loading", "loading", ["lazy", "eager"], "eager", "eager");
}

const CELL_ALIGN = [
	str("align"),
	str("ch", "char"),
	str("chOff", "charoff"),
	str("vAlign", "valign"),
];

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

// The global attributes reflected plainly; translate, spellcheck, hidden and
// tabIndex are written out in dom.ts.
export const HTML_ELEMENT_REFLECTIONS: readonly ReflectSpec[] = [
	str("accessKey", "accesskey"),
	bool("autofocus"),
	keyword("dir", "dir", ["ltr", "rtl", "auto"], "", ""),
	keyword(
		"enterKeyHint",
		"enterkeyhint",
		["enter", "done", "go", "next", "previous", "search", "send"],
		"",
		"",
	),
	bool("inert"),
	keyword(
		"inputMode",
		"inputmode",
		["none", "text", "tel", "url", "email", "numeric", "decimal", "search"],
		"",
		"",
	),
	str("lang"),
	str("nonce"),
	// The empty string is popover's own spelling of auto. hint is not
	// implemented, so it takes the unknown-value route.
	{
		property: "popover",
		attribute: "popover",
		kind: "enum",
		keywords: ["auto", "manual"],
		nullable: true,
		missing: "",
		empty: "auto",
		invalid: "manual",
	},
	str("title"),
	keyword(
		"writingSuggestions",
		"writingsuggestions",
		["true", "false"],
		"true",
		"true",
	),
];

// A tag with no entry is HTMLElement where HTML knows the name and
// HTMLUnknownElement where it does not.
export const HTML_INTERFACES: readonly InterfaceSpec[] = [
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
	{name: "HTMLAudioElement", tags: ["audio"]},
	{
		name: "HTMLBRElement",
		tags: ["br"],
		reflect: [str("clear")],
	},
	{
		name: "HTMLBaseElement",
		tags: ["base"],
		reflect: [str("target")],
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
			popoverTargetAction(),
		],
	},
	{
		name: "HTMLCanvasElement",
		tags: ["canvas"],
		reflect: [ulong("width", "width", 300), ulong("height", "height", 150)],
	},
	{
		name: "HTMLDListElement",
		tags: ["dl"],
		reflect: [bool("compact")],
	},
	{
		name: "HTMLDataElement",
		tags: ["data"],
		reflect: [str("value")],
	},
	{name: "HTMLDataListElement", tags: ["datalist"]},
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
		name: "HTMLDirectoryElement",
		tags: ["dir"],
		reflect: [bool("compact")],
	},
	{
		name: "HTMLDivElement",
		tags: ["div"],
		reflect: [str("align")],
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
		name: "HTMLFieldSetElement",
		tags: ["fieldset"],
		reflect: [bool("disabled"), str("name")],
	},
	{
		name: "HTMLFontElement",
		tags: ["font"],
		reflect: [str("color"), str("face"), str("size")],
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
	{name: "HTMLHeadElement", tags: ["head"]},
	{
		name: "HTMLHeadingElement",
		tags: ["h1", "h2", "h3", "h4", "h5", "h6"],
		reflect: [str("align")],
	},
	{
		name: "HTMLHtmlElement",
		tags: ["html"],
		reflect: [str("version")],
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
			popoverTargetAction(),
		],
	},
	{
		name: "HTMLLIElement",
		tags: ["li"],
		reflect: [long("value", "value", 0), str("type")],
	},
	{
		name: "HTMLLabelElement",
		tags: ["label"],
		reflect: [str("htmlFor", "for")],
	},
	{
		name: "HTMLLegendElement",
		tags: ["legend"],
		reflect: [str("align")],
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
		name: "HTMLMapElement",
		tags: ["map"],
		reflect: [str("name")],
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
		name: "HTMLMenuElement",
		tags: ["menu"],
		reflect: [bool("compact")],
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
		name: "HTMLModElement",
		tags: ["ins", "del"],
		reflect: [url("cite"), str("dateTime", "datetime")],
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
		name: "HTMLOutputElement",
		tags: ["output"],
		reflect: [tokens("htmlFor", "for"), str("name")],
	},
	{
		name: "HTMLParagraphElement",
		tags: ["p"],
		reflect: [str("align")],
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
	{name: "HTMLPictureElement", tags: ["picture"]},
	{
		name: "HTMLPreElement",
		tags: ["pre", "listing", "xmp"],
		reflect: [long("width", "width", 0)],
	},
	// Every number a gauge carries is read against the others; all written out.
	{name: "HTMLProgressElement", tags: ["progress"]},
	{name: "HTMLMeterElement", tags: ["meter"]},
	{
		name: "HTMLQuoteElement",
		tags: ["blockquote", "q"],
		reflect: [url("cite")],
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
	{name: "HTMLSpanElement", tags: ["span"]},
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
		name: "HTMLTableCaptionElement",
		tags: ["caption"],
		reflect: [str("align")],
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
		name: "HTMLTableColElement",
		tags: ["col", "colgroup"],
		reflect: [
			ulong("span", "span", 1, {clampMin: 1, clampMax: 1000}),
			...CELL_ALIGN,
			str("width"),
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
		name: "HTMLTableRowElement",
		tags: ["tr"],
		reflect: [...CELL_ALIGN, str("bgColor", "bgcolor")],
	},
	{
		name: "HTMLTableSectionElement",
		tags: ["thead", "tbody", "tfoot"],
		reflect: CELL_ALIGN,
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
		name: "HTMLTimeElement",
		tags: ["time"],
		reflect: [str("dateTime", "datetime")],
	},
	{name: "HTMLTitleElement", tags: ["title"]},
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
		name: "HTMLUListElement",
		tags: ["ul"],
		reflect: [bool("compact"), str("type")],
	},
	{
		name: "HTMLVideoElement",
		tags: ["video"],
		reflect: [
			ulong("width", "width", 0),
			ulong("height", "height", 0),
			url("poster"),
			bool("playsInline", "playsinline"),
		],
	},
];

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

// Names HTML knows and gives HTMLUnknownElement to anyway.
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

/* ------------------------------------------- event handler IDL attributes */

// The full HTML table plus the Pointer Events, CSS Animations, Transitions
// and Selection partials: what `"onclick" in element` probes, not what fires.
// The prefixed animation handlers listen for mixed-case types; the installer
// carries that mapping. Partials of specs this DOM has no notion of are out.
export const GLOBAL_EVENT_HANDLERS: readonly string[] = [
	"onabort",
	"onanimationcancel",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"onauxclick",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncommand",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"ongotpointercapture",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onlostpointercapture",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onpause",
	"onplay",
	"onplaying",
	"onpointercancel",
	"onpointerdown",
	"onpointerenter",
	"onpointerleave",
	"onpointermove",
	"onpointerout",
	"onpointerover",
	"onpointerrawupdate",
	"onpointerup",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onscrollend",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onselectionchange",
	"onselectstart",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"ontransitioncancel",
	"ontransitionend",
	"ontransitionrun",
	"ontransitionstart",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
];

export const WINDOW_EVENT_HANDLERS: readonly string[] = [
	"onafterprint",
	"onbeforeprint",
	"onbeforeunload",
	"onhashchange",
	"onlanguagechange",
	"onmessage",
	"onmessageerror",
	"onoffline",
	"ononline",
	"onpagehide",
	"onpagereveal",
	"onpageshow",
	"onpageswap",
	"onpopstate",
	"onrejectionhandled",
	"onstorage",
	"onunhandledrejection",
	"onunload",
];

export const DOCUMENT_AND_ELEMENT_EVENT_HANDLERS: readonly string[] = [
	"oncopy",
	"oncut",
	"onpaste",
];

export const DOCUMENT_EVENT_HANDLERS: readonly string[] = [
	"onfullscreenchange",
	"onfullscreenerror",
	"onreadystatechange",
	"onvisibilitychange",
];

// Set on a body or frameset, these land on its window and read back from it.
export const FORWARDED_BODY_EVENT_HANDLERS: readonly string[] = [
	"onblur",
	"onerror",
	"onfocus",
	"onload",
	"onresize",
	"onscroll",
	...WINDOW_EVENT_HANDLERS,
];
