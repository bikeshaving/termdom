/**
 * The shape of the platform, held by the compiler: for each internal class,
 * the members lib.dom declares that the class type does not, asserted EQUAL
 * to a ledger. A member appearing on neither side is conformance; a member
 * missing from the ledger is drift the build refuses; a ledger entry the
 * type grew into is staleness the build refuses just the same.
 *
 * The bins the ledger's comments sort by:
 * - RUNTIME: real on instances -- the tables in htmltables.ts and the
 *   engine install them -- but invisible to the class type. Type debt,
 *   not missing behavior.
 * - GAP: not implemented at all. Work candidates.
 * - NEVER: deliberately absent on a terminal.
 *
 * Key coverage only, by design: whole-interface assignability is
 * transitively global (one interface drags the entire co-recursive type
 * graph, including lib.dom's own inaccuracies), so signatures graduate
 * member by member instead. Nothing here executes; the module erases.
 */
import type {
	Attr,
	CharacterData,
	Comment,
	CustomEvent,
	DOMTokenList,
	DocumentFragment,
	Element,
	Event,
	EventTarget,
	KeyboardEvent,
	MouseEvent,
	MutationObserver,
	NamedNodeMap,
	Node,
	Range,
	Selection,
	ShadowRoot,
	StaticRange,
	Text,
} from "./dom.js";

/** The platform keys an internal type has not declared. */
type MissingFrom<Platform, Internal> = Exclude<keyof Platform, keyof Internal>;

/** Exact equality of two key unions, either direction's drift refused. */
type Equal<A, B> =
	[A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** RUNTIME: the Node interface constants, installed on prototypes at load. */
type NodeConstants =
	| "ELEMENT_NODE" |
	"ATTRIBUTE_NODE" |
	"TEXT_NODE" |
	"CDATA_SECTION_NODE" |
	"ENTITY_REFERENCE_NODE" |
	"ENTITY_NODE" |
	"PROCESSING_INSTRUCTION_NODE" |
	"COMMENT_NODE" |
	"DOCUMENT_NODE" |
	"DOCUMENT_TYPE_NODE" |
	"DOCUMENT_FRAGMENT_NODE" |
	"NOTATION_NODE" |
	"DOCUMENT_POSITION_DISCONNECTED" |
	"DOCUMENT_POSITION_PRECEDING" |
	"DOCUMENT_POSITION_FOLLOWING" |
	"DOCUMENT_POSITION_CONTAINS" |
	"DOCUMENT_POSITION_CONTAINED_BY" |
	"DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC";

/** RUNTIME: the ChildNode mixin, installed from the tables. */
type ChildNodeMixin =
	| "after" |
	"before" |
	"remove" |
	"replaceWith" |
	"nextElementSibling" |
	"previousElementSibling";

/** RUNTIME: the ParentNode mixin, installed from the tables. */
type ParentNodeMixin =
	| "childElementCount" |
	"children" |
	"firstElementChild" |
	"lastElementChild" |
	"append" |
	"prepend" |
	"querySelector" |
	"querySelectorAll" |
	"replaceChildren";

/** RUNTIME: the ARIA reflection surface, installed from the tables. */
type ARIAReflection =
	| "role" |
	`aria${string}`;

/** RUNTIME: selector engine entries, installed from the tables. */
type SelectorSurface = "closest" | "matches" | "webkitMatchesSelector";

/** GAP: pointer capture and locking -- no pointers to capture yet. */
type PointerSurface =
	| "hasPointerCapture" |
	"releasePointerCapture" |
	"requestPointerLock" |
	"setPointerCapture";

/** RUNTIME: fullscreen, installed by the engine. */
type FullscreenSurface =
	| "requestFullscreen" |
	"onfullscreenchange" |
	"onfullscreenerror";

/** GAP or NEVER, per member -- the un-binned remainder of Element. */
type ElementRemainder =
	| "currentCSSZoom" | // NEVER: zoom is a browser's
	"part" | // RUNTIME: reflected from the tables
	"checkVisibility" | // GAP
	"computedStyleMap" | // GAP: Typed OM
	"animate" | // GAP: no animation timeline
	"getAnimations"; // GAP

// -- key-complete today, held that way --------------------------------------
declare const _checked: [
	Equal<MissingFrom<globalThis.EventTarget, EventTarget>, never>,
	Equal<MissingFrom<globalThis.Event, Event>, never>,
	Equal<MissingFrom<globalThis.CustomEvent, CustomEvent>, never>,
	Equal<MissingFrom<globalThis.StaticRange, StaticRange>, never>,
	Equal<MissingFrom<globalThis.Selection, Selection>, never>,
	Equal<MissingFrom<globalThis.MutationObserver, MutationObserver>, never>,
	Equal<MissingFrom<globalThis.DOMTokenList, DOMTokenList>, never>,
	Equal<MissingFrom<globalThis.NamedNodeMap, NamedNodeMap>, never>,

	// -- constants only -----------------------------------------------------
	Equal<MissingFrom<globalThis.Node, Node>, NodeConstants>,
	Equal<MissingFrom<globalThis.Attr, Attr>, NodeConstants>,
	Equal<
		MissingFrom<globalThis.KeyboardEvent, KeyboardEvent>,
		| "DOM_KEY_LOCATION_STANDARD" |
		"DOM_KEY_LOCATION_LEFT" |
		"DOM_KEY_LOCATION_RIGHT" |
		"DOM_KEY_LOCATION_NUMPAD"
	>,

	// -- small curated ledgers ----------------------------------------------
	// RUNTIME: constants, engine geometry. GAP: createContextualFragment.
	Equal<
		MissingFrom<globalThis.Range, Range>,
		| "START_TO_START" |
		"START_TO_END" |
		"END_TO_END" |
		"END_TO_START" |
		"getBoundingClientRect" |
		"getClientRects" |
		"createContextualFragment"
	>,
	// GAP: layer/offset/page/movement coordinate spaces -- the terminal has
	// client coordinates and, so far, nothing else to offset against.
	Equal<
		MissingFrom<globalThis.MouseEvent, MouseEvent>,
		| "layerX" |
		"layerY" |
		"movementX" |
		"movementY" |
		"offsetX" |
		"offsetY" |
		"pageX" |
		"pageY" |
		"x" |
		"y"
	>,
	Equal<
		MissingFrom<globalThis.CharacterData, CharacterData>,
		NodeConstants | ChildNodeMixin
	>,
	Equal<MissingFrom<globalThis.Text, Text>, NodeConstants | ChildNodeMixin>,
	Equal<
		MissingFrom<globalThis.Comment, Comment>,
		NodeConstants | ChildNodeMixin
	>,
	Equal<
		MissingFrom<globalThis.DocumentFragment, DocumentFragment>,
		NodeConstants | ParentNodeMixin
	>,
	Equal<
		MissingFrom<globalThis.ShadowRoot, ShadowRoot>,
		| NodeConstants |
		ParentNodeMixin |
		// RUNTIME on the document; GAP on the root:
		"onslotchange" |
		"activeElement" |
		"adoptedStyleSheets" |
		"fullscreenElement" |
		"pictureInPictureElement" |
		"pointerLockElement" |
		"styleSheets" |
		"elementFromPoint" |
		"elementsFromPoint" |
		"getAnimations"
	>,
	Equal<
		MissingFrom<globalThis.Element, Element>,
		| NodeConstants |
		ChildNodeMixin |
		ParentNodeMixin |
		ARIAReflection |
		SelectorSurface |
		PointerSurface |
		FullscreenSurface |
		ElementRemainder
	>,
];

export type PlatformConformanceChecked = typeof _checked;
