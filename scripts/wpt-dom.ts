/**
 * Run the web-platform-tests dom suites against TermDOM's own DOM.
 *
 * Each test is a testharness.js document. The document is parsed by this DOM's
 * own HTML parser, its globals are installed on the realm the harness runs in
 * -- so `document`, `Node`, `Element` and the rest are this implementation's --
 * and the file's scripts are evaluated in document order inside one block at
 * global scope, so that a name a script declares is a name the realm has, as
 * it is in a browser.
 *
 * The suites are fetched into .wpt/ on first run and cached. Results are
 * written to docs/dom-conformance.md.
 *
 * Run: node --experimental-strip-types scripts/wpt-dom.ts [name-filter]
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Document} from "../src/internal/dom.ts";

/**
 * A test file's DOM.
 *
 * Each file gets its own instance of the module, because a test that tampers
 * with `NodeList.prototype.length` -- and several do -- would otherwise leave
 * that prototype tampered with for every file after it. In a browser each file
 * is its own realm; here a fresh module evaluation is the same isolation.
 */
type DOMModule = typeof import("../src/internal/dom.ts");

let moduleCounter = 0;

async function freshDOM(): Promise<DOMModule> {
	return (await import(
		`../src/internal/dom.ts?wpt=${moduleCounter++}`
	)) as DOMModule;
}

/** The names a test file expects to find on its global. */
function domGlobals(dom: DOMModule): Record<string, unknown> {
	const names = [
		"AbstractRange",
		"Attr",
		"CDATASection",
		"CharacterData",
		"Comment",
		"CompositionEvent",
		"CustomElementRegistry",
		"customElements",
		"CustomEvent",
		"CustomStateSet",
		"Document",
		"DocumentFragment",
		"DocumentType",
		"DOMImplementation",
		"DOMParser",
		"DOMStringMap",
		"DOMTokenList",
		"Element",
		"ElementInternals",
		"Event",
		"EventTarget",
		"FocusEvent",
		"HTMLAnchorElement",
		"HTMLAreaElement",
		"HTMLAudioElement",
		"HTMLBaseElement",
		"HTMLBodyElement",
		"HTMLBRElement",
		"HTMLButtonElement",
		"HTMLCanvasElement",
		"HTMLCollection",
		"HTMLDataElement",
		"HTMLDataListElement",
		"HTMLDetailsElement",
		"HTMLDialogElement",
		"HTMLDirectoryElement",
		"HTMLDivElement",
		"HTMLDListElement",
		"HTMLElement",
		"HTMLEmbedElement",
		"HTMLFieldSetElement",
		"HTMLFontElement",
		"HTMLFormControlsCollection",
		"HTMLFormElement",
		"HTMLFrameElement",
		"HTMLFrameSetElement",
		"HTMLHeadElement",
		"HTMLHeadingElement",
		"HTMLHRElement",
		"HTMLHtmlElement",
		"HTMLIFrameElement",
		"HTMLImageElement",
		"HTMLInputElement",
		"HTMLLabelElement",
		"HTMLLegendElement",
		"HTMLLIElement",
		"HTMLLinkElement",
		"HTMLMapElement",
		"HTMLMarqueeElement",
		"HTMLMediaElement",
		"HTMLMenuElement",
		"HTMLMetaElement",
		"HTMLMeterElement",
		"HTMLModElement",
		"HTMLObjectElement",
		"HTMLOListElement",
		"HTMLOptGroupElement",
		"HTMLOptionElement",
		"HTMLOptionsCollection",
		"HTMLOutputElement",
		"HTMLParagraphElement",
		"HTMLParamElement",
		"HTMLPictureElement",
		"HTMLPreElement",
		"HTMLProgressElement",
		"HTMLQuoteElement",
		"HTMLScriptElement",
		"HTMLSelectElement",
		"HTMLSlotElement",
		"HTMLSourceElement",
		"HTMLSpanElement",
		"HTMLStyleElement",
		"HTMLTableCaptionElement",
		"HTMLTableCellElement",
		"HTMLTableColElement",
		"HTMLTableElement",
		"HTMLTableRowElement",
		"HTMLTableSectionElement",
		"HTMLTemplateElement",
		"HTMLTextAreaElement",
		"HTMLTimeElement",
		"HTMLTitleElement",
		"HTMLTrackElement",
		"HTMLUListElement",
		"HTMLUnknownElement",
		"HTMLVideoElement",
		"InputEvent",
		"KeyboardEvent",
		"MathMLElement",
		"MouseEvent",
		"MutationObserver",
		"MutationRecord",
		"NamedNodeMap",
		"Node",
		"NodeFilter",
		"NodeIterator",
		"NodeList",
		"PointerEvent",
		"ProcessingInstruction",
		"RadioNodeList",
		"Range",
		"Selection",
		"ShadowRoot",
		"StaticRange",
		"SubmitEvent",
		"SVGElement",
		"Text",
		"ToggleEvent",
		"TreeWalker",
		"UIEvent",
		"ValidityState",
		"WheelEvent",
		"XMLDocument",
	];
	const globals: Record<string, unknown> = {};
	const source = dom as unknown as Record<string, unknown>;
	for (const name of names) globals[name] = source[name];
	return globals;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".wpt");
const RAW = "https://raw.githubusercontent.com/web-platform-tests/wpt/master";
const SUITES = [
	"dom/nodes",
	"dom/traversal",
	"dom/collections",
	"dom/lists",
	"dom/events",
	"dom/ranges",
	"selection",
	"shadow-dom",
	"custom-elements",
];
/** A test that has not finished in this long is recorded as a timeout. */
const TIMEOUT_MS = 5000;
/** What `<meta name=timeout content=long>` buys a test. */
const LONG_TIMEOUT_MS = 60000;

async function cached(path: string): Promise<string | null> {
	const file = join(CACHE, path);
	if (existsSync(file)) {
		const text = readFileSync(file, "utf8");
		return text === "%%WPT-MISSING%%" ? null : text;
	}
	const response = await fetch(`${RAW}/${path}`);
	mkdirSync(dirname(file), {recursive: true});
	if (!response.ok) {
		writeFileSync(file, "%%WPT-MISSING%%");
		return null;
	}
	const text = await response.text();
	writeFileSync(file, text);
	return text;
}

interface Entry {
	path: string;
	type: string;
}

/**
 * Directories that hold no test files: a fixture a test loads, or a crash test,
 * which is scored by whether the browser survived rather than by subtests.
 */
const NON_TEST_DIRECTORIES = new Set(["support", "resources", "crashtests"]);

/**
 * Every test file under a suite, subdirectories and all.
 *
 * The tree API answers a whole subtree in one request, which the contents API
 * cannot: a suite like shadow-dom keeps most of its files a directory or two
 * down, and walking it a directory at a time spends a request on each.
 */
async function listDirectory(suite: string): Promise<string[]> {
	const response = await fetch(
		`https://api.github.com/repos/web-platform-tests/wpt/git/trees/master:${suite}?recursive=1`,
	);
	const tree = (await response.json()) as {
		tree?: Entry[];
		truncated?: boolean;
		message?: string;
	};
	if (!Array.isArray(tree.tree)) {
		throw new Error(`Could not list ${suite}: ${JSON.stringify(tree)}`);
	}
	if (tree.truncated) {
		throw new Error(`The listing of ${suite} came back truncated`);
	}
	const names: string[] = [];
	for (const entry of tree.tree) {
		if (entry.type !== "blob") continue;
		const parts = entry.path.split("/");
		const name = parts[parts.length - 1];
		if (parts.slice(0, -1).some((part) => NON_TEST_DIRECTORIES.has(part))) {
			continue;
		}
		if (!/\.html$/.test(name) && !/\.(any|window)\.js$/.test(name)) continue;
		if (/-ref\.html$|-manual\.html$|-crash\.html$/.test(name)) continue;
		names.push(`${suite}/${entry.path}`);
	}
	return names;
}

async function suiteFiles(suite: string): Promise<string[]> {
	const listing = join(CACHE, `${suite.replace(/\//g, "-")}-listing.json`);
	if (existsSync(listing)) return JSON.parse(readFileSync(listing, "utf8"));
	const names = (await listDirectory(suite)).sort();
	mkdirSync(CACHE, {recursive: true});
	writeFileSync(listing, JSON.stringify(names, null, "\t"));
	return names;
}

/**
 * The tests this DOM does not run, each with the one reason it does not.
 *
 * Every reason names something outside the tree: a browsing context, a script
 * the document's own parser must execute, a user action, a network fetch, an
 * XML parser, a testdriver call into the browser itself, or a proposal that is
 * not a standard. "Hard" is not a reason, and neither is "later" -- everything
 * else either passes or is a failure this table does not hide.
 */
const EXCLUSIONS: Record<string, string> = {
	// requires-browsing-context: the test reaches a second document through a
	// frame, or a second realm through one. This DOM has no window, so
	// `frames[0]`, `contentDocument` and `defaultView` have nothing to name.
	"dom/nodes/Comment-constructor.html":
		"requires-browsing-context: the shared constructor test builds a frame document",
	"dom/nodes/Text-constructor.html":
		"requires-browsing-context: the shared constructor test builds a frame document",
	"dom/nodes/Document-URL.html":
		"requires-browsing-context: a frame's document URL",
	"dom/nodes/Document-createElement-namespace.html":
		"requires-browsing-context: elements created in framed XML and XHTML documents",
	"dom/nodes/Document-createElementNS.html":
		"requires-browsing-context: two thirds of the cases run in framed XML and XHTML documents, and the rest reach DOMException through defaultView",
	"dom/nodes/Element-getElementsByTagName-change-document-HTMLNess.html":
		"requires-browsing-context: an element adopted between an HTML and an XML frame",
	"dom/nodes/Element-matches.html":
		"requires-browsing-context: the selector corpus is loaded into a frame",
	"dom/nodes/Element-webkitMatchesSelector.html":
		"requires-browsing-context: the selector corpus is loaded into a frame",
	"dom/nodes/ParentNode-querySelector-All.html":
		"requires-browsing-context: the selector corpus is loaded into a frame",
	"dom/nodes/Node-parentNode.html":
		"requires-browsing-context: a frame's document element parentage",
	"dom/nodes/Node-isConnected.html":
		"requires-browsing-context: connectedness across a frame's document",
	"dom/nodes/query-target-in-load-event.html":
		"requires-browsing-context: the query runs in a frame's load event",
	"dom/nodes/DOMImplementation-createHTMLDocument-with-saved-implementation.html":
		"requires-browsing-context: a DOMImplementation kept from a detached frame",
	"dom/nodes/node-creation-realm.html":
		"requires-browsing-context: which realm's constructor a node carries",
	"dom/nodes/node-realm-adoption-after-frame-removal.html":
		"requires-browsing-context: a node's realm after its frame is removed",
	"dom/nodes/node-realm-mixed-across-adoption.html":
		"requires-browsing-context: realms mixed by adoption between frames",
	"dom/nodes/node-realm-preserved-across-adoption.html":
		"requires-browsing-context: a node's realm across adoption between frames",
	"dom/nodes/node-realm-preserved-across-frameless-adoption.html":
		"requires-browsing-context: a node's realm across adoption out of a frame",
	"dom/nodes/create-element-realm-after-adoption.html":
		"requires-browsing-context: which realm createElement uses after adoption",
	"dom/nodes/remove-and-adopt-thcrash.html":
		"requires-browsing-context: adoption into a frame's document",
	"dom/traversal/TreeWalker-realm.html":
		"requires-browsing-context: a TreeWalker built in another realm",
	"dom/traversal/TreeWalker-acceptNode-filter-cross-realm.html":
		"requires-browsing-context: filters that are objects from another realm",
	"dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html":
		"requires-browsing-context: a filter from a detached frame's realm",
	"dom/nodes/querySelector-empty-id.html":
		"requires-browsing-context: the fixture is named through the window's named property access",
	"dom/nodes/remove-next-sibling-during-replace-with.html":
		"requires-browsing-context: the fixture is named through the window's named property access",
	"dom/events/Event-dispatch-handlers-changed.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-multiple-cancelBubble.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-multiple-stopPropagation.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-omitted-capture.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-reenter.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-target-moved.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-target-removed.html":
		"requires-browsing-context: the expected propagation path begins at the window",
	"dom/events/Event-dispatch-throwing.html":
		"requires-browsing-context: a listener's exception is counted as an error event at the window",
	"dom/events/Event-dispatch-throwing-multiple-globals.html":
		"requires-browsing-context: which global an error event is fired at, across frames",
	"dom/events/Event-dispatch-redispatch.html":
		"requires-browsing-context: the redispatched events are the window's own load and the browser's mouseup",
	"dom/events/Event-timestamp-cross-realm-getter.html":
		"requires-browsing-context: a timeStamp getter taken from a frame's realm",
	"dom/events/EventListener-addEventListener.sub.window.js":
		"requires-browsing-context: a listener that is a cross-origin window",
	"dom/events/EventListener-handleEvent-cross-realm.html":
		"requires-browsing-context: listener objects built in a frame's realm",
	"dom/events/EventListener-incumbent-global-1.sub.html":
		"requires-browsing-context: which global a listener is called with, across frames",
	"dom/events/EventListener-incumbent-global-2.sub.html":
		"requires-browsing-context: which global a listener is called with, across frames",
	"dom/events/EventListener-incumbent-global-subframe-1.sub.html":
		"requires-browsing-context: a subframe of the incumbent-global test",
	"dom/events/EventListener-incumbent-global-subframe-2.sub.html":
		"requires-browsing-context: a subframe of the incumbent-global test",
	"dom/events/EventListener-incumbent-global-subsubframe.sub.html":
		"requires-browsing-context: a subframe of the incumbent-global test",
	"dom/events/event-global.html":
		"requires-browsing-context: window.event, which is the window's own slot",
	"dom/events/event-global-extra.window.js":
		"requires-browsing-context: window.event across frames",
	"dom/events/event-global-set-before-handleEvent-lookup.window.js":
		"requires-browsing-context: window.event, which is the window's own slot",
	"dom/events/event-global-is-still-set-when-coercing-beforeunload-result.html":
		"requires-browsing-context: window.event during a beforeunload the window fires",
	"dom/events/event-global-is-still-set-when-reporting-exception-onerror.html":
		"requires-browsing-context: window.event inside window.onerror",
	"dom/events/window-event-restored-after-throwing-onerror.html":
		"requires-browsing-context: window.event inside window.onerror",

	// requires-fetch: the document's encoding comes from a response the test
	// arranges over the network.
	"dom/nodes/Document-characterSet-normalization-1.html":
		"requires-fetch: encoding labels normalized from fetched documents",
	"dom/nodes/Document-characterSet-normalization-2.html":
		"requires-fetch: encoding labels normalized from fetched documents",

	// requires-script-execution: the document's own parser must compile and
	// run a script -- an event handler content attribute here. This DOM parses
	// scripts as text, as a terminal document has no script runner.
	"dom/nodes/remove-unscopable.html":
		"requires-script-execution: the test reads its result out of an onclick content attribute",
	"dom/nodes/MutationObserver-document.html":
		"requires-script-execution: the records under test are the parser's own insertions, seen by an observer that a script the parser runs installs partway through the document",

	// requires-user-input: the test drives a real pointer or keyboard through
	// testdriver, which asks the browser under test to synthesize input.
	"dom/events/click-on-absolute-pseudo.html":
		"requires-user-input: a pointer action sequence over a pseudo-element",
	"dom/events/focus-event-document-move.html":
		"requires-user-input: a pointer action sequence that moves the node it presses",
	"dom/events/handler-count.html":
		"requires-user-input: pointer action sequences against a running CSS animation",
	"dom/events/pointer-event-document-move.html":
		"requires-user-input: a pointer action sequence that moves the node it presses",
	"dom/events/no-focus-events-at-clicking-editable-content-in-link.html":
		"requires-user-input: clicks on editable content, and the focus events HTML fires from them",

	// requires-css-animations: the events under test are fired by the CSS
	// animation and transition machinery, which belongs to the engine.
	"dom/events/EventListener-invoke-legacy.html":
		"requires-css-animations: the legacy prefixed types are only reached by a trusted animation or transition event",
	"dom/events/webkit-animation-end-event.html":
		"requires-css-animations: a running CSS animation",
	"dom/events/webkit-animation-iteration-event.html":
		"requires-css-animations: a running CSS animation",
	"dom/events/webkit-animation-start-event.html":
		"requires-css-animations: a running CSS animation",
	"dom/events/webkit-transition-end-event.html":
		"requires-css-animations: a running CSS transition",

	// revisited when that phase lands.
	"dom/nodes/attach-shadow-realm-after-adoption.html":
		"requires-browsing-context: the shadow host is adopted out of a frame's document",
	"dom/nodes/remove-from-shadow-host-and-adopt-into-iframe.html":
		"requires-browsing-context: the node is adopted into a frame's document",
	"dom/nodes/MutationObserver-cross-realm-callback-report-exception.html":
		"requires-browsing-context: a callback taken from a frame's realm, and which global its exception is reported to",

	// UI Events standard's, and the activation behavior they run belongs to
	// HTML's elements. Dispatch has the hooks; nothing fills them in yet.

	// no-xml-parser: there is no XML parser here, and none is planned; XML
	// nodes are built through the DOM instead.
	"dom/nodes/processing-instruction-attributes.html":
		"no-xml-parser: half the cases parse XML, and the other half test a WICG incubation (declarative-partial-updates) that gives processing instructions attributes, which the DOM Standard does not",

	// requires-layout: the test measures a box. There is no layout in this DOM
	// -- the engine owns it -- so offsetTop, getBoundingClientRect,
	// elementFromPoint and their kin have nothing to answer with.

	// requires-browsing-context: the fixture is a rendered document inside an
	// iframe, which the untriaged suite's shared helper builds for every test
	// in it.
	"shadow-dom/leaktests/window-frames.html":
		"requires-browsing-context: whether a shadow tree's nodes leak into window.frames",
	"shadow-dom/leaktests/selection.html":
		"requires-browsing-context: a Selection over a rendered frame",
	"shadow-dom/declarative/declarative-shadow-dom-write-to-iframe.html":
		"requires-browsing-context: the markup is written into a frame's document",
	"shadow-dom/untriaged/elements-and-dom-objects/extensions-to-element-interface/methods/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/activeElement-confirm-return-null.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-007.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-009.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-010.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-011.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-012.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-attributes/test-013.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-methods/test-004.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-methods/test-010.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-dispatch/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-dispatch/test-003.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-retargeting/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-retargeting/test-003.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-focus-events/test-001.html":
		"requires-browsing-context: focus events in a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-focus-events/test-002.html":
		"requires-browsing-context: focus events in a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-focus-events/test-003.html":
		"requires-browsing-context: focus events in a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-relatedtarget/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-relatedtarget/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-relatedtarget/test-003.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/html-elements-in-shadow-trees/inert-html-elements/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/html-elements-in-shadow-trees/inert-html-elements/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/shadow-trees/upper-boundary-encapsulation/test-011.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-001.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-003.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-005.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-008.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/user-interaction/active-element/test-001.html":
		"requires-browsing-context: the document's focused element, in a frame",
	"shadow-dom/untriaged/user-interaction/active-element/test-002.html":
		"requires-browsing-context: the document's focused element, in a frame",
	"shadow-dom/untriaged/user-interaction/editing/inheritance-of-content-editable-001.html":
		"requires-browsing-context: contentEditable in a rendered document in a frame",
	"shadow-dom/untriaged/user-interaction/ranges-and-selections/test-001.html":
		"requires-browsing-context: a Selection over a rendered document in a frame",
	"shadow-dom/untriaged/user-interaction/ranges-and-selections/test-002.html":
		"requires-browsing-context: a Selection over a rendered document in a frame",

	// behavior is this DOM's; the interface the test reads it through is not.

	// FocusEvent or a pointer action; none of those interfaces exists here.
	"shadow-dom/touch-event-retargeting-leak.html":
		"requires-user-input: a touch action sequence driven through testdriver",
	"shadow-dom/wheel-event-related-target.html":
		"requires-user-input: a wheel action sequence driven through testdriver",
	"shadow-dom/nested-hover-pseudo-class-removal.html":
		"requires-user-input: a pointer action sequence over a :hover rule",

	// requires-script-execution: the document's own parser must run a script
	// partway through, which is what the case is about. This DOM parses
	// scripts as text.
	"shadow-dom/declarative/declarative-after-attachshadow.html":
		"requires-script-execution: a script inside the document attaches a shadow root before the parser reaches the declarative one",
	"shadow-dom/declarative/declarative-with-disabled-shadow.html":
		"requires-script-execution: the definition that disables shadow roots is registered by a script the parser runs",
	"shadow-dom/declarative/declarative-shadow-dom-opt-in.html":
		"requires-script-execution: the opt-in is read by a script the parser runs",
	"shadow-dom/declarative/declarative-parser-interaction.html":
		"requires-script-execution: the case is what a script sees while the parser is still inside the template",
	"shadow-dom/declarative/declarative-shadow-dom-repeats-2.html":
		"requires-script-execution: the second template is judged by a script the parser runs between them",
	"shadow-dom/declarative/innerhtml-before-closing-tag.html":
		"requires-script-execution: innerHTML is set by a script the parser runs before the closing tag",
	"shadow-dom/declarative/move-template-before-closing-tag.html":
		"requires-script-execution: the template is moved by a script the parser runs before the closing tag",
	"shadow-dom/declarative/script-access.html":
		"requires-script-execution: a script inside the shadow template reads its own root",
	"shadow-dom/declarative/gethtml-ordering.html":
		"requires-script-execution: the serialization order is read by a script the parser runs mid-document",
	"shadow-dom/declarative/innerhtml-on-ordinary-template.html":
		"requires-script-execution: the fixture is named by a script the parser runs mid-document",
	"custom-elements/parser/parser-constructs-custom-element-synchronously.html":
		"requires-script-execution: the definition is registered, and the element observed, by scripts the parser runs between tags",
	"custom-elements/parser/parser-constructs-custom-elements.html":
		"requires-script-execution: the definition is registered, and the element observed, by scripts the parser runs between tags",
	"custom-elements/parser/parser-fallsback-to-unknown-element.html":
		"requires-script-execution: the element is observed by a script the parser runs between tags",
	"custom-elements/parser/parser-uses-constructed-element.html":
		"requires-script-execution: the element is observed by a script the parser runs between tags",
	"custom-elements/parser/parser-sets-attributes-and-children.html":
		"requires-script-execution: the reactions counted are the ones the parser enqueues between tags",
	"custom-elements/microtasks-and-constructors.html":
		"requires-script-execution: the case is which microtasks run while the parser is inside an element",
	"custom-elements/upgrading/upgrading-parser-created-element.html":
		"requires-script-execution: the element under test is one the parser created around a script it ran",
	"custom-elements/connected-callbacks-template.html":
		"requires-script-execution: the definition is registered by a script the parser runs inside the template",
	"custom-elements/custom-element-reaction-queue.html":
		"requires-script-execution: the reaction order under test is the parser's own",
	"custom-elements/upgrading.html":
		"requires-script-execution: the elements upgraded are ones the parser created around the script that defines them",
	"custom-elements/upgrading/upgrade-custom-element-error-event.html":
		"requires-browsing-context: the failure is counted as an error event at the window",

	// reflection it carries.

	// another standard. The reaction machinery itself is covered by the files
	// that use DOM interfaces.

	// customized built-ins: the is= form of a custom element. Safari never
	// shipped it and this DOM declares it dead (see the deviation below); the
	// files whose whole subject is that form are excluded rather than counted.
	"custom-elements/Document-createElement-customized-builtins.html":
		"customized built-ins: createElement with an is option",
	"custom-elements/Document-createElementNS-customized-builtins.html":
		"customized built-ins: createElementNS with an is option",
	"custom-elements/HTMLElement-constructor-customized-builtins.html":
		"customized built-ins: a constructor that extends a built-in interface",
	"custom-elements/parser/parser-constructs-custom-elements-with-is.html":
		"customized built-ins: the parser reading an is attribute",
	"custom-elements/parser/serializing-html-fragments-customized-builtins.html":
		"customized built-ins: serializing an is attribute",
	"custom-elements/upgrading/Node-cloneNode-customized-builtins.html":
		"customized built-ins: cloning an element with an is value",
	"custom-elements/upgrading/Document-importNode-customized-builtins.html":
		"customized built-ins: importing an element with an is value",

	// requires-browsing-context: the case is run inside an iframe, whose
	// document this DOM has no way to build.
	"dom/ranges/Range-cloneContents.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"dom/ranges/Range-deleteContents.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"dom/ranges/Range-extractContents.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"dom/ranges/Range-insertNode.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"dom/ranges/Range-surroundContents.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"dom/ranges/Range-extractContents-dynamic-end.html":
		"requires-browsing-context: the end container is removed from inside an iframe's unload event",
	"dom/ranges/Range-in-shadow-after-the-shadow-removed.html":
		"requires-browsing-context: the shadow mode under test is read out of document.location, which is null without one",
	"selection/getSelection.html":
		"requires-browsing-context: every case is an iframe's selection, or asserts that the document's defaultView is not null",
	"selection/Document-open.html":
		"requires-browsing-context: the selection under test is an iframe's, across a document.open()",
	"selection/deleteFromDocument.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",

	// requires-user-input: the selection under test is one a pointer or key
	// action sequence makes, which testdriver asks the browser to synthesize.
	"selection/anchor-removal.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/canvas-click.html":
		"requires-user-input: a pointer action sequence over a canvas",
	"selection/canvas-drag.html":
		"requires-user-input: a pointer action sequence over a canvas",
	"selection/drag-disabled-textarea-shadow-dom.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/drag-out-of-floated-content.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/drag-selection-contenteditable-to-out-of-flow-user-select-none.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/drag-selection-extend-to-user-select-none.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/extend-selection-in-shadow-tree.html":
		"requires-user-input: the selection is dragged out with a pointer action sequence",
	"selection/fire-selectionchange-event-on-deleting-single-character-inside-inline-element.html":
		"requires-user-input: the character is deleted by a key action sequence",
	"selection/fire-selectionchange-event-on-pressing-backspace.html":
		"requires-user-input: the character is deleted by a key action sequence",
	"selection/fire-selectionchange-event-on-textcontrol-element-on-pressing-backspace.html":
		"requires-user-input: the character is deleted by a key action sequence",
	"selection/move-by-word-korean.html":
		"requires-user-input: the caret is moved by a key action sequence",
	"selection/move-by-word-with-symbol.html":
		"requires-user-input: the caret is moved by a key action sequence",
	"selection/onselectstart-on-key-in-contenteditable.html":
		"requires-user-input: the selection is made by a key action sequence",
	"selection/select-end-of-line-image.tentative.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/selection-direction-on-single-click.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/selection-direction-on-double-click.tentative.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/selection-direction-on-triple-click.tentative.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/selection-focused-element-becomes-nonfocusable.html":
		"requires-user-input: the element is focused by a pointer action sequence",
	"selection/stringifier_editable_element.tentative.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/user-select-on-input-and-contenteditable.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/anonymous/details-ancestor.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/anonymous/details-mutate.html":
		"requires-user-input: the selection is made by a pointer action sequence",
	"selection/caret/move-around-contenteditable-false.html":
		"requires-user-input: the caret is moved by a key action sequence",
	"selection/caret/move-around-generated-content.html":
		"requires-user-input: the caret is moved by a key action sequence",
	"selection/contenteditable/initial-selection-during-focus-event-propagation.html":
		"requires-user-input: the editing host is focused by a pointer action sequence",
	"selection/contenteditable/modifying-selection-with-primary-mouse-button.tentative.html":
		"requires-user-input: the selection is modified by a pointer action sequence",
	"selection/contenteditable/modifying-selection-with-non-primary-mouse-button.tentative.html":
		"requires-user-input: the selection is modified by a pointer action sequence",
	"selection/textcontrols/initial-selection-during-focus-event-propagation.html":
		"requires-user-input: the control is focused by a pointer action sequence",
	"selection/textcontrols/click-input-after-iframe-focus.html":
		"requires-user-input: the control is clicked by a pointer action sequence",
	"selection/textcontrols/focus.html":
		"requires-user-input: the control is focused by a pointer action sequence",

	// Every subtest of each of these is outside this DOM by construction.
	"custom-elements/builtin-coverage.html":
		"customized built-ins: every case defines one with an extends option before it asserts anything",
	"custom-elements/ElementInternals-role.html":
		"requires-testdriver: every case reads a computed role out of the browser's own accessibility tree through testdriver.js",
	"custom-elements/element-internals-behaviors.tentative.html":
		"not-a-standard: HTMLSubmitButtonBehavior and the behaviors option on attachInternals are a proposal, filed under tentative in the suite",
	"custom-elements/form-associated/ElementInternals-behavior-accessibility.tentative.html":
		"not-a-standard: HTMLSubmitButtonBehavior and the behaviors option on attachInternals are a proposal, filed under tentative in the suite",
	"custom-elements/form-associated/ElementInternals-submit-behavior.tentative.html":
		"not-a-standard: HTMLSubmitButtonBehavior and the behaviors option on attachInternals are a proposal, filed under tentative in the suite",
	"custom-elements/form-associated/ElementInternals-submit-behavior-dialog.tentative.html":
		"not-a-standard: HTMLSubmitButtonBehavior and the behaviors option on attachInternals are a proposal, filed under tentative in the suite",
	"dom/events/Event-dispatch-single-activation-behavior.html":
		"requires-script-execution: every activation under test is observed through an inline on* content attribute, which becomes a handler only by compiling it as script",
	"dom/events/event-disabled-dynamic.html":
		"requires-browsing-context: the case runs inside the window's load event",
};

/**
 * Directories the same reason excludes every file of.
 *
 * A directory is here only where its subject is a whole standard this DOM does
 * not implement -- HTML's focus model, its form machinery, a CSSOM interface,
 * an incubation that is in no standard at all. The table below still names
 * every file one by one; this is where the reason is written once.
 */
const EXCLUDED_DIRECTORIES: Array<[string, string]> = [
	[
		"dom/ranges/tentative/",
		"not-a-standard: OpaqueRange and the createValueRange that builds one are a proposal, filed under tentative in the suite",
	],
	[
		"dom/events/scrolling/",
		"requires-layout: a scroll event needs a scroller, a viewport and a scroll position, all of which the engine owns",
	],
	[
		"dom/events/non-cancelable-when-passive/",
		"requires-user-input: each case drives a touch or wheel action sequence through testdriver",
	],
	[
		"dom/nodes/Document-contentType/",
		"requires-fetch: the document's content type comes from the response that delivered it",
	],
	[
		"dom/nodes/Document-createElement-namespace-tests/",
		"no-xml-parser: these are the XHTML, SVG and MathML fixtures the excluded Document-createElement-namespace.html loads into a frame",
	],
	[
		"dom/nodes/insertion-removing-steps/",
		"requires-script-execution: each case counts the steps of a script the parser runs, an iframe that navigates, or a style sheet that applies",
	],
	[
		"shadow-dom/reference-target/",
		"not-a-standard: shadowrootreferencetarget is a WICG incubation, filed under tentative in the suite",
	],
	[
		"custom-elements/reactions/customized-builtins/",
		"customized built-ins: the is= form of a custom element, which this DOM declares dead (see the deviation below)",
	],
];

function excludedDirectory(file: string): string | null {
	for (const [prefix, reason] of EXCLUDED_DIRECTORIES) {
		if (file.startsWith(prefix)) return reason;
	}
	return null;
}

/** Failures this DOM owns as design. They stay counted in the table. */
const DEVIATIONS: Array<[string, string]> = [
	[
		"dom/collections/HTMLCollection-own-props.html, HTMLCollection-delete.html, HTMLCollection-supported-property-indices.html, HTMLCollection-supported-property-names.html, HTMLCollection-as-prototype.html",
		"A collection's indexed and named properties are ordinary own accessors, not a legacy platform object's exotic ones, because this tree uses no Proxy anywhere -- the reason it is faster than the DOM it replaces. Reads and writes through them are correct and live; what differs is the meta-level: `delete collection.name` succeeds until the next mutation redefines it, `Object.defineProperty` over an existing index does not throw, and an index past the end can be shadowed by an expando.",
	],
	[
		"dom/nodes/Document-createEvent.https.html",
		"createEvent builds every name in the legacy table whose interface exists here: the Event and CustomEvent names, and the UI Events ones -- UIEvent, MouseEvent, KeyboardEvent, FocusEvent, CompositionEvent, and the TextEvent alias for a composition event. The names that map to interfaces of other specifications -- DragEvent, HashChangeEvent, MessageEvent, StorageEvent, TouchEvent, BeforeUnloadEvent, DeviceMotionEvent and DeviceOrientationEvent -- throw NotSupportedError, because a createEvent that answered them with an event of some other interface would be a lie about what it built.",
	],
	[
		"dom/events/Event-dispatch-bubbles-false.html, Event-dispatch-bubbles-true.html, passive-by-default.html, EventListener-handleEvent.html",
		"A propagation path ends at the document. The spec continues it to the Window when the document has a browsing context, and there is no Window in this DOM: the harness supplies a bare event target under that name so the test files load. The subtests that fail are the ones that put the window in an expected path, that expect a scroll-blocking listener on the window to be passive by default, or that expect a listener's exception to arrive as an error event at the window; every other subtest in those files passes.",
	],
	[
		"dom/events/Event-subclasses-constructors.html",
		"The UI Events interfaces are here: UIEvent, MouseEvent, KeyboardEvent, FocusEvent, InputEvent, CompositionEvent, WheelEvent, and the PointerEvent a synthetic click is built through. The subtests that still fail construct interfaces of other specifications, which are not.",
	],
	[
		"dom/ranges/Range-getClientRects.html and every selection test that measures a box",
		"Range.getClientRects() and Range.getBoundingClientRect() are absent. They are CSSOM View's, not the DOM Standard's, and they answer with boxes the layout engine owns; the engine reaches its own geometry through its layout tree rather than through this file. The same holds for everything the selection suite scores by rendering -- Selection.modify()'s line and paragraph granularities, toString() over user-select and display:none, the caret cases -- which fails here rather than being excluded.",
	],
	[
		"selection/modify.tentative.html, bidi/modify-*.html, contenteditable/modify*.html, move-by-word-*.html",
		'Selection.modify() is absent. Its "character" and "word" granularities could be answered from the tree, but "line", "lineboundary", "paragraph" and the rest are positions only layout knows, and a modify() that moved the focus for some granularities and ignored the others would be a subset wearing the name of the whole method.',
	],
	[
		"selection/getSelection.html (excluded), and the defaultView sanity checks in it",
		"`getSelection()` lives on Document here and always answers with that document's selection. The Selection API defines it to return null for a document with no browsing context, and to hang a forwarding copy off the Window. There is no Window in this DOM and no browsing context to have -- a document is the top of the tree -- so returning null would leave the interface unreachable. The harness supplies the Window's forwarding copy, exactly as it supplies element.style.",
	],
	[
		"selection/shadow-dom/tentative/Selection-getComposedRanges-collapsed.html, Selection-getComposedRanges-range-update.html",
		"A selection whose range is inside a shadow tree of the document still answers `rangeCount` 1 and hands that range to `getRangeAt(0)`. The suite contradicts itself here: Mozilla's cross-shadow-boundary-extend.html and shadow-dom/tentative/Range-isPointInRange.html, and WebKit's selection-at-nodes-not-part-of-flattened-tree.html, all read a range out of a selection that sits in a shadow tree, while Chromium's Selection-getComposedRanges-range-update.html expects getRangeAt to throw for the same shape. Two engines against one decided it; the one subtest that wants the throw is counted as a failure.",
	],
	[
		"selection/shadow-dom/selection-at-nodes-not-part-of-flattened-tree.html",
		"`containsNode` answers over the node tree, so a node that a shadow root leaves out of the flattened tree is still contained in a selection over its parent. The four subtests that expect false are scoring the flattened tree, which is a rendering question.",
	],
	[
		"dom/nodes/querySelector-id-nth-child.html",
		"An element's id does not become a property of a global. Window is not part of this DOM, and its named property access is the one place the spec's own text calls a legacy quirk; the document stands alone with `defaultView` null.",
	],
	[
		"dom/nodes/Element-matches-namespaced-elements.html, querySelector-mixed-case.html",
		"A selector with an explicit namespace prefix (`*|name`, `svg|circle`) is rejected. The selector engine is nwsapi, rented rather than written, and it does not carry a namespace prefix map.",
	],
	[
		"dom/nodes/Element-closest.html",
		"`:scope` inside matches() and closest() resolves against the document, not the element the method was called on. The selector engine is nwsapi, rented rather than written, and its match entry point takes no scoping root.",
	],
	[
		"dom/events/Body-FrameSet-Event-Handlers.html, and every subtest that reads an on* content attribute",
		"The event handler IDL attributes -- onclick and its ninety-odd siblings -- are here, on HTMLElement, SVGElement, MathMLElement and Document. Their content-attribute half is not: `onclick=\"...\"` in markup is a function compiled from the attribute's value, and this DOM never executes script, so the attribute sets no handler and the IDL attribute reads back null. The subtests that still fail in this file are the ones that compile a content attribute, and the ones that expect a body's or a frameset's forwarded handler to land on a Window: a document with no browsing context has no event handler target for the forwarded set, so the write is dropped and the read answers null -- which is what the algorithm says of it -- and the harness's window is a bare event target.",
	],
	[
		"dom/collections/domstringmap-supported-property-names.html, custom-elements/reactions/DOMStringMap.html",
		"`dataset` answers with a DOMStringMap whose properties are ordinary own accessors, one per data-* attribute, for the same reason a collection's indexed properties are: this tree uses no Proxy anywhere. Reading and writing a name the element already carries goes straight through to the attribute; assigning a name it does not carry yet creates an ordinary property instead of the attribute, which is the one thing a proxy would have caught.",
	],
	[
		"custom-elements/HTMLElement-attachInternals.html, and the constraint validation members of the built-in controls",
		"`willValidate`, `validity`, `validationMessage`, `checkValidity`, `reportValidity` and `setCustomValidity` are on ElementInternals, where the flags are the author's own, and absent from input, select, textarea, button, fieldset, object and output. Computing them for a built-in control means the input value-space algorithms -- converting a value to a number or a date per type, the step base and the allowed value step -- and a validity that answered false to constraints it never checked would be worse than none.",
	],
	[
		"the focus members, and every subtest that calls focus() or blur()",
		"`focus()`, `blur()` and `document.activeElement` are absent. A focusable area is defined over elements that are being rendered, and nothing is rendered here; a focus() that could never focus anything is not the method the specification defines. The same holds for the popover members, whose showing puts an element in the top layer.",
	],
	[
		"SVG and MathML elements",
		"An element in the SVG or MathML namespace is an SVGElement or a MathMLElement and nothing more: the SVGGraphicsElement and MathMLMathElement hierarchies, and the geometry and presentation interfaces under them, are other specifications' and describe a rendering this DOM does not do. Every tree operation over a foreign element -- creation, namespace, cloning, serialization, selectors -- is the DOM Standard's and is here.",
	],
	[
		"shadow-dom/declarative/declarative-shadow-dom-attachment.html",
		"All 654 subtests pass and the harness reports a timeout: the file builds 654 declarative shadow trees in one document, and every live collection materialized along the way is resynchronized on every mutation after it, which is the cost of indexed properties that are accessors rather than a proxy's traps. The cost is quadratic in the number of collections the file has read, and this file reads enough of them to pass testharness's own ten seconds.",
	],
	[
		"dom/nodes/NodeList-static-length-getter-tampered-*.html",
		"These pass their subtests but their harness times out: each is a 250-million-iteration JIT stress loop over `nodeList[i]`, and an accessor property is slower to read than the exotic indexed getter a browser's binding layer generates.",
	],
];

interface Subtest {
	name: string;
	status: number;
	message: string | null;
}

interface Outcome {
	file: string;
	harness: string;
	subtests: Subtest[];
	error?: string;
}

/** Resolve a script's src against a test file, as a repo path. */
function resolveScript(src: string, file: string): string {
	if (src.startsWith("/")) return src.slice(1);
	const base = dirname(file);
	const parts = `${base}/${src}`.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

/** The document a `.any.js` or `.window.js` test would be generated into. */
function generatedDocument(file: string, source: string): string {
	const metas = [...source.matchAll(/^\/\/\s*META:\s*script=(\S+)/gm)];
	const scripts = metas
		.map((match) => `<script src="${match[1]}"></script>`)
		.join("\n");
	const name = file.split("/").pop() as string;
	return (
		"<!doctype html>\n<meta charset=utf-8>\n" +
		'<script src="/resources/testharness.js"></script>\n' +
		'<script src="/resources/testharnessreport.js"></script>\n' +
		`${scripts}\n<div id="log"></div>\n` +
		`<script src="${name}"></script>\n`
	);
}

interface HarnessGlobals {
	restore(): void;
}

/**
 * The CSSOM seam.
 *
 * Several traversal and node tests hide a scratch element with
 * `element.style.display = "none"` before they walk it. `style` belongs to
 * CSSOM, which this DOM does not implement -- the engine owns it -- so the
 * harness supplies the property the environment would, exactly as the CSSOM
 * harness supplies clientWidth off the layout engine. Nothing reads back what
 * a test writes here.
 */
function installStyleSeam(dom: DOMModule): void {
	const styles = new WeakMap<object, Record<string, string>>();
	Object.defineProperty(dom.HTMLElement.prototype, "style", {
		get(this: object): Record<string, string> {
			let style = styles.get(this);
			if (style === undefined) {
				style = {};
				styles.set(this, style);
			}
			return style;
		},
		configurable: true,
	});
}

/** Install this DOM as the realm's DOM, and hand back the undo. */
function installGlobals(
	dom: DOMModule,
	document: Document,
	url: string,
): HarnessGlobals {
	installStyleSeam(dom);
	const scope = globalThis as unknown as Record<string, unknown>;
	const saved = new Map<string, {had: boolean; value: unknown}>();
	const target = new dom.EventTarget();
	const windowShim = {
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		dispatchEvent: target.dispatchEvent.bind(target),
		// The Selection API puts getSelection on both the Window and the
		// Document, the Window's being defined as a call to the Document's.
		// There is no Window here, so the environment supplies the one that
		// forwards, exactly as it supplies element.style.
		getSelection: () => document.getSelection(),
	};
	const values: Record<string, unknown> = {
		...domGlobals(dom),
		document,
		location: {
			href: url,
			search: "",
			hash: "",
			pathname: new URL(url).pathname,
			origin: new URL(url).origin,
			toString: () => url,
		},
		...windowShim,
	};
	for (const [name, value] of Object.entries(values)) {
		saved.set(name, {
			had: Object.prototype.hasOwnProperty.call(scope, name),
			value: scope[name],
		});
		scope[name] = value;
	}
	for (const name of ["self", "window", "parent", "top", "frames"]) {
		saved.set(name, {
			had: Object.prototype.hasOwnProperty.call(scope, name),
			value: scope[name],
		});
		scope[name] = scope;
	}
	// The window's named property access. A great many test files name their
	// fixture by its id alone -- `createTestTree(test1)` over a `<div
	// id=test1>` -- which is the Window's legacy named access, not the tree's.
	// The environment supplies it here, over the ids the parsed document
	// already has, exactly as it supplies the window and element.style; a name
	// the harness itself installed is never shadowed.
	for (const element of document.getElementsByTagName("*")) {
		const id = element.getAttribute("id");
		if (id === null || id === "" || saved.has(id)) continue;
		if (Object.prototype.hasOwnProperty.call(scope, id)) continue;
		saved.set(id, {had: false, value: undefined});
		scope[id] = element;
	}
	// The harness reads this before it decides whether to wait for a load.
	Object.defineProperty(document, "readyState", {
		value: "complete",
		configurable: true,
	});
	dom.setAmbientDocument(document);
	return {
		restore(): void {
			for (const [name, entry] of saved) {
				if (entry.had) {
					scope[name] = entry.value;
				} else {
					delete scope[name];
				}
			}
		},
	};
}

async function runFile(file: string): Promise<Outcome> {
	const reason = EXCLUSIONS[file] ?? excludedDirectory(file);
	if (reason !== null && reason !== undefined) {
		return {file, harness: "EXCLUDED", subtests: [], error: reason};
	}
	const source = await cached(file);
	if (source === null) {
		return {file, harness: "ERROR", subtests: [], error: "not fetched"};
	}
	const html = /\.(any|window)\.js$/.test(file)
		? generatedDocument(file, source)
		: source;
	const url = `http://web-platform.test/${file}`;

	const dom = await freshDOM();
	let document: Document;
	try {
		document = dom.parseHTMLDocument(html, url);
	} catch (error) {
		return {
			file,
			harness: "ERROR",
			subtests: [],
			error: `parse: ${(error as Error).message}`,
		};
	}

	const sources: string[] = [];
	let harnessLoaded = false;
	for (const script of document.getElementsByTagName("script")) {
		const src = script.getAttribute("src");
		if (src !== null) {
			if (/testharnessreport\.js$/.test(src)) continue;
			if (/testharness\.js$/.test(src)) {
				harnessLoaded = true;
				const harness = await cached("resources/testharness.js");
				if (harness === null) {
					return {
						file,
						harness: "ERROR",
						subtests: [],
						error: "no testharness.js",
					};
				}
				sources.push(harness);
				sources.push("setup({output: false});");
				continue;
			}
			const text = await cached(resolveScript(src, file));
			if (text === null) {
				return {
					file,
					harness: "ERROR",
					subtests: [],
					error: `missing script ${src}`,
				};
			}
			sources.push(text);
		} else if (script.getAttribute("type") === "module") {
			return {
				file,
				harness: "SKIPPED",
				subtests: [],
				error: "module script",
			};
		} else {
			sources.push(script.textContent ?? "");
		}
	}

	if (!harnessLoaded) {
		return {file, harness: "REFTEST", subtests: []};
	}

	const outcome: Outcome = {file, harness: "TIMEOUT", subtests: []};
	const globals = installGlobals(dom, document, url);
	const scope = globalThis as unknown as Record<string, unknown>;
	// The names the realm had before the file ran. A classic script's `var` and
	// function declarations become properties of the global, and the file's are
	// dropped once it is done so the next file starts from a bare realm.
	const before = new Set(Object.keys(scope));
	try {
		let settle: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		scope.__complete = (
			tests: Subtest[],
			status: {status: number; message: string | null},
		) => {
			outcome.harness = ["OK", "ERROR", "TIMEOUT", "PRECONDITION_FAILED"][
				status.status
			];
			outcome.subtests = tests.map((test) => ({
				name: test.name,
				status: test.status,
				message: test.message ?? null,
			}));
			settle();
		};
		const body = `${sources.join(
			"\n;\n",
		)}\n;\nadd_completion_callback(__complete);`;
		try {
			// One block at global scope for the whole file: the harness and the
			// test share it exactly as they share a document's script scope. The
			// block is what a browser gives a classic script -- `var` and
			// function declarations land on the global, where a test that evals
			// a name (`params.map(eval)`) finds them, while `let` and `const`
			// stay in the file's own scope rather than the realm's.
			(0, eval)(`{\n${body}\n}`);
			(scope.dispatchEvent as (event: object) => boolean)(
				new dom.Event("load"),
			);
			document.dispatchEvent(new dom.Event("DOMContentLoaded"));
		} catch (error) {
			return {
				file,
				harness: "ERROR",
				subtests: [],
				error: (error as Error).message,
			};
		}
		const timer = setTimeout(
			settle,
			/<meta\s+name=["']?timeout["']?\s+content=["']?long/i.test(html)
				? LONG_TIMEOUT_MS
				: TIMEOUT_MS,
		);
		timer.unref?.();
		await done;
		clearTimeout(timer);
	} finally {
		delete scope.__complete;
		globals.restore();
		for (const name of Object.keys(scope)) {
			if (!before.has(name)) delete scope[name];
		}
	}
	return outcome;
}

// A test file that is abandoned mid-flight (an async test whose timer fires
// after the file's globals are gone) must not take the run down with it.
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

const filter = process.argv[2];
const files: string[] = [];
for (const suite of SUITES) files.push(...(await suiteFiles(suite)));
const selected = files.filter((file) => !filter || file.includes(filter));

const outcomes: Outcome[] = [];
for (const file of selected) {
	try {
		outcomes.push(await runFile(file));
	} catch (error) {
		outcomes.push({
			file,
			harness: "ERROR",
			subtests: [],
			error: (error as Error).message,
		});
	}
	const last = outcomes[outcomes.length - 1];
	const passed = last.subtests.filter((test) => test.status === 0).length;
	console.info(
		`${last.harness.padEnd(8)} ${passed}/${last.subtests.length} ${file}${
			last.error ? ` -- ${last.error}` : ""
		}`,
	);
}

const all = outcomes.flatMap((outcome) => outcome.subtests);
const passed = all.filter((test) => test.status === 0);
const failed = all.filter((test) => test.status !== 0);
const reftests = outcomes.filter((outcome) => outcome.harness === "REFTEST");
const excluded = outcomes.filter((outcome) => outcome.harness === "EXCLUDED");
const brokenFiles = outcomes.filter(
	(outcome) =>
		outcome.harness !== "OK" &&
		outcome.harness !== "REFTEST" &&
		outcome.harness !== "EXCLUDED",
);

const lines: string[] = [
	`# DOM conformance: web-platform-tests ${SUITES.join(", ")}`,
	"",
	"Generated by `node --experimental-strip-types scripts/wpt-dom.ts`.",
	"",
	"Every test runs against `src/internal/dom.ts`: the document is built by",
	"that file's HTML parser, and `document`, `Node`, `Element` and the rest of",
	"the realm's DOM globals are its classes. Each file gets its own evaluation",
	"of the module, so a test that tampers with a prototype cannot reach the",
	"next file.",
	"",
	"The harness supplies three things the environment would, none of which is",
	"part of this DOM: a `window` object carrying addEventListener, its pair,",
	"and the `getSelection()` the Selection API defines as a call to the",
	"document's own; and an `element.style` scratch object, which several",
	"traversal tests use to hide a fixture. CSSOM belongs to the engine, not to",
	"the tree. That window is a bare event target, not a Window: an event path",
	"ends at the document, as the spec says it does for a document with no",
	"browsing context.",
	"",
	`- Test files in the suites: ${outcomes.length}`,
	`- Reference tests (no testharness, scored by pixels): ${reftests.length}`,
	`- Excluded, each with its reason below: ${excluded.length}`,
	`- Files whose harness completed: ${
		outcomes.length - brokenFiles.length - reftests.length - excluded.length
	}`,
	`- Files whose harness did not complete: ${brokenFiles.length}`,
	`- Subtests passed: ${passed.length}`,
	`- Subtests failed: ${failed.length}`,
	"",
	"## Exclusions",
	"",
	"| File | Reason |",
	"| --- | --- |",
	...excluded.map((outcome) => `| ${outcome.file} | ${outcome.error} |`).sort(),
	"",
	"## Deliberate deviations",
	"",
	"These are failures this DOM owns as design. They are counted as failures",
	"above, not excluded, so the number stays honest.",
	"",
	...DEVIATIONS.flatMap(([file, reason]) => [`### ${file}`, "", reason, ""]),
	"## Files",
	"",
	"| File | Harness | Passed | Failed |",
	"| --- | --- | ---: | ---: |",
];
for (const outcome of outcomes) {
	const filePassed = outcome.subtests.filter((test) => test.status === 0);
	lines.push(
		`| ${outcome.file} | ${outcome.harness}${
			outcome.error ? ` (${outcome.error})` : ""
		} | ${filePassed.length} | ${outcome.subtests.length - filePassed.length} |`,
	);
}

lines.push("", "## Failing subtests", "");
for (const outcome of outcomes) {
	const fails = outcome.subtests.filter((test) => test.status !== 0);
	if (fails.length === 0) continue;
	lines.push(`### ${outcome.file}`, "");
	for (const test of fails) {
		lines.push(`- ${test.name}: ${(test.message ?? "").split("\n")[0]}`);
	}
	lines.push("");
}

if (filter) {
	for (const outcome of outcomes) {
		for (const test of outcome.subtests) {
			if (test.status === 0) continue;
			console.info(`  ${outcome.file} :: ${test.name}: ${test.message ?? ""}`);
		}
	}
} else {
	writeFileSync(
		join(ROOT, "docs", "dom-conformance.md"),
		`${lines.join("\n")}\n`,
	);
}
console.info(
	`\n${passed.length} passed, ${failed.length} failed across ${outcomes.length} files`,
);
