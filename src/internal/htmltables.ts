import {
	HTML_REFLECTIONS,
	HTML_TAG_INTERFACES,
	WINDOW_EVENT_HANDLERS,
} from "../generated/htmltables.ts";

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

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

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
	reflect: readonly ReflectSpec[];
}

function str(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {property, attribute, kind: "string"};
}

function url(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {property, attribute, kind: "url"};
}

function bool(
	property: string,
	attribute = property.toLowerCase(),
): ReflectSpec {
	return {property, attribute, kind: "boolean"};
}

function long(
	property: string,
	attribute: string,
	fallback: number,
	nonNegative = false,
): ReflectSpec {
	return {property, attribute, kind: "long", fallback, nonNegative};
}

function ulong(
	property: string,
	attribute: string,
	fallback: number,
	extra: Partial<ReflectSpec> = {},
): ReflectSpec {
	return {property, attribute, kind: "unsigned-long", fallback, ...extra};
}

function keyword(
	property: string,
	attribute: string,
	keywords: readonly string[],
	missing: string,
	invalid: string,
): ReflectSpec {
	return {property, attribute, kind: "enum", keywords, missing, invalid};
}

function tokens(
	property: string,
	attribute: string,
	supported: readonly string[] = [],
): ReflectSpec {
	return {property, attribute, kind: "tokenlist", supported};
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

// The form submission attributes whose reflection is prose: formAction has
// its own setter algorithm, and the other two are enumerated.
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
];

// The reflections the IDL does not annotate, per interface: enumerated
// attributes, attributes with their own setter algorithm, and the few
// the HTML Standard describes in prose. An entry here replaces the
// generated one of the same property.
const HAND_REFLECTIONS: Readonly<Record<string, readonly ReflectSpec[]>> = {
	// translate, spellcheck, hidden and tabIndex are written out in dom.ts.
	HTMLElement: [
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
		str("nonce"),
		// The empty string is popover's own spelling of auto. hint is not
		// implemented, so it takes the unknown-value path.
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
		keyword(
			"writingSuggestions",
			"writingsuggestions",
			["true", "false"],
			"true",
			"true",
		),
	],
	HTMLAnchorElement: [referrerPolicy()],
	HTMLAreaElement: [referrerPolicy()],
	HTMLButtonElement: [
		...FORM_SUBMISSION,
		keyword("type", "type", ["submit", "reset", "button"], "submit", "submit"),
		popoverTargetAction(),
	],
	HTMLCanvasElement: [
		ulong("width", "width", 300),
		ulong("height", "height", 150),
	],
	HTMLDialogElement: [
		keyword(
			"closedBy",
			"closedby",
			["any", "closerequest", "none"],
			"",
			"auto",
		),
	],
	HTMLFormElement: [
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
	],
	HTMLIFrameElement: [
		str("srcdoc"),
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
		referrerPolicy(),
		loading(),
	],
	HTMLImageElement: [
		crossOrigin(),
		ulong("width", "width", 0),
		ulong("height", "height", 0),
		referrerPolicy(),
		keyword("decoding", "decoding", ["sync", "async", "auto"], "auto", "auto"),
		loading(),
		fetchPriority(),
	],
	HTMLInputElement: [
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
		keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
		...FORM_SUBMISSION,
		// Limited to positive numbers with a fallback, which the IDL does
		// not annotate.
		ulong("size", "size", 20, {greaterThanZero: true}),
		ulong("height", "height", 0),
		ulong("width", "width", 0),
		popoverTargetAction(),
	],
	HTMLLinkElement: [
		crossOrigin(),
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
		referrerPolicy(),
		fetchPriority(),
		tokens("blocking", "blocking", ["render"]),
	],
	HTMLMarqueeElement: [long("loop", "loop", -1)],
	HTMLMediaElement: [
		crossOrigin(),
		keyword(
			"preload",
			"preload",
			["none", "metadata", "auto"],
			"metadata",
			"metadata",
		),
		bool("disableRemotePlayback", "disableremoteplayback"),
	],
	HTMLScriptElement: [
		crossOrigin(),
		referrerPolicy(),
		fetchPriority(),
		tokens("blocking", "blocking", ["render"]),
	],
	HTMLSelectElement: [
		keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
	],
	HTMLStyleElement: [tokens("blocking", "blocking", ["render"])],
	HTMLTableCellElement: [
		keyword("scope", "scope", ["row", "col", "rowgroup", "colgroup"], "", ""),
	],
	HTMLTextAreaElement: [
		keyword("autocomplete", "autocomplete", ["on", "off"], "", ""),
		keyword("wrap", "wrap", ["soft", "hard"], "soft", "soft"),
	],
	HTMLTrackElement: [
		keyword(
			"kind",
			"kind",
			["subtitles", "captions", "descriptions", "chapters", "metadata"],
			"subtitles",
			"metadata",
		),
	],
};

function reflectionsOf(name: string): readonly ReflectSpec[] {
	const hand = HAND_REFLECTIONS[name] ?? [];
	const generated = (HTML_REFLECTIONS[name] ?? []).filter(
		(spec) => !hand.some((own) => own.property === spec.property),
	);
	return [...generated, ...hand];
}

export const HTML_ELEMENT_REFLECTIONS: readonly ReflectSpec[] =
	reflectionsOf("HTMLElement");

// The element interfaces this DOM has a class for, filled in from the
// tables. HTMLTemplateElement and HTMLSlotElement register themselves
// in dom.ts.
const INTERFACE_NAMES: readonly string[] = [
	"HTMLAnchorElement",
	"HTMLAreaElement",
	"HTMLAudioElement",
	"HTMLBRElement",
	"HTMLBaseElement",
	"HTMLBodyElement",
	"HTMLButtonElement",
	"HTMLCanvasElement",
	"HTMLDListElement",
	"HTMLDataElement",
	"HTMLDataListElement",
	"HTMLDetailsElement",
	"HTMLDialogElement",
	"HTMLDirectoryElement",
	"HTMLDivElement",
	"HTMLEmbedElement",
	"HTMLFieldSetElement",
	"HTMLFontElement",
	"HTMLFormElement",
	"HTMLFrameElement",
	"HTMLFrameSetElement",
	"HTMLHRElement",
	"HTMLHeadElement",
	"HTMLHeadingElement",
	"HTMLHtmlElement",
	"HTMLIFrameElement",
	"HTMLImageElement",
	"HTMLInputElement",
	"HTMLLIElement",
	"HTMLLabelElement",
	"HTMLLegendElement",
	"HTMLLinkElement",
	"HTMLMapElement",
	"HTMLMarqueeElement",
	"HTMLMediaElement",
	"HTMLMenuElement",
	"HTMLMetaElement",
	"HTMLModElement",
	"HTMLOListElement",
	"HTMLObjectElement",
	"HTMLOptGroupElement",
	"HTMLOptionElement",
	"HTMLOutputElement",
	"HTMLParagraphElement",
	"HTMLParamElement",
	"HTMLPictureElement",
	"HTMLPreElement",
	"HTMLProgressElement",
	"HTMLMeterElement",
	"HTMLQuoteElement",
	"HTMLScriptElement",
	"HTMLSelectElement",
	"HTMLSourceElement",
	"HTMLSpanElement",
	"HTMLStyleElement",
	"HTMLTableCaptionElement",
	"HTMLTableCellElement",
	"HTMLTableColElement",
	"HTMLTableElement",
	"HTMLTableRowElement",
	"HTMLTableSectionElement",
	"HTMLTextAreaElement",
	"HTMLTimeElement",
	"HTMLTitleElement",
	"HTMLTrackElement",
	"HTMLUListElement",
	"HTMLVideoElement",
];

const tagsOf = (name: string): readonly string[] =>
	Object.keys(HTML_TAG_INTERFACES).filter(
		(tag) => HTML_TAG_INTERFACES[tag] === name,
	);

export const HTML_INTERFACES: readonly InterfaceSpec[] = INTERFACE_NAMES.map(
	(name) => ({name, tags: tagsOf(name), reflect: reflectionsOf(name)}),
);

// A tag the HTML Standard gives HTMLElement, or an interface this DOM has
// no class for, which an author sees as an HTMLElement too.
export const HTML_ELEMENT_TAGS: readonly string[] = Object.keys(
	HTML_TAG_INTERFACES,
).filter((tag) => {
	const name = HTML_TAG_INTERFACES[tag];
	return (
		name !== "HTMLUnknownElement" &&
		name !== "HTMLTemplateElement" &&
		name !== "HTMLSlotElement" &&
		!INTERFACE_NAMES.includes(name)
	);
});

// Names HTML knows and gives HTMLUnknownElement to anyway.
export const HTML_UNKNOWN_TAGS: readonly string[] = Object.keys(
	HTML_TAG_INTERFACES,
).filter((tag) => HTML_TAG_INTERFACES[tag] === "HTMLUnknownElement");

// Set on a body or frameset, these are stored on its window and read
// back from it.
export const FORWARDED_BODY_EVENT_HANDLERS: readonly string[] = [
	"onblur",
	"onerror",
	"onfocus",
	"onload",
	"onresize",
	"onscroll",
	...WINDOW_EVENT_HANDLERS,
];
