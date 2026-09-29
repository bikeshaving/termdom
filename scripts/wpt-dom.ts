/**
 * Run the web-platform-tests dom suites against TermDOM's own DOM.
 *
 * Each test is a testharness.js document, attached on a full engine over a
 * mock transport: the file's markup becomes the engine's initial document,
 * so layout, the cascade, focus rendering and the rest of the user agent are
 * live under the test. The engine realm's globals are installed on the realm
 * the harness runs in -- so `document`, `Node`, `Element` and the rest are
 * this implementation's -- and the file's scripts are evaluated in document
 * order inside one block at global scope, so that a name a script declares
 * is a name the realm has, as it is in a browser.
 *
 * The suites are fetched into .wpt/ on first run and cached. Results are
 * written to docs/dom-conformance.md.
 *
 * Run: node --experimental-strip-types scripts/wpt-dom.ts [name-filter]
 */

import {register} from "node:module";

register("./ts-specifier-hooks.js", import.meta.url);

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Document} from "../src/internal/dom.ts";
import type * as DOM from "../src/internal/dom.ts";
import type * as TermDOM from "../src/index.ts";
import type {TerminalTransport} from "../src/internal/exchange.ts";
import {TESTDRIVER_VENDOR} from "./wpt-testdriver.ts";
import {WPT_COMMIT, WPT_RAW} from "./wpt-ref.ts";

/**
 * A test file's realm: the engine module and the DOM module of one
 * generation.
 *
 * Each file gets its own instance of the whole engine graph, because a test
 * that tampers with `NodeList.prototype.length` -- and several do -- would
 * otherwise leave that prototype tampered with for every file after it. In a
 * browser each file is its own realm; here a fresh module evaluation is the
 * same isolation. The resolver hooks propagate the `?wpt=N` query through
 * relative imports, so the termdom and dom imports below land on one shared
 * copy of the graph.
 */
type DOMModule = typeof DOM;
type EngineModule = typeof TermDOM;

interface Realm {
	dom: DOMModule;
	termdom: EngineModule;
}

let moduleCounter = 0;

async function freshRealm(): Promise<Realm> {
	const generation = moduleCounter++;
	const termdom = (await import(
		`../src/index.ts?wpt=${generation}`,
	)) as EngineModule;
	const dom = (await import(
		`../src/internal/dom.ts?wpt=${generation}`,
	)) as DOMModule;
	return {dom, termdom};
}

interface MockTransport extends TerminalTransport {

	/** Type into the engine: the bytes a terminal would send for the keys. */
	pushInput(text: string): void;
}

/**
 * The terminal a test file's engine renders to: a fixed-size sink that
 * swallows frames, and whose keyboard is the testdriver shim -- pushInput
 * feeds the readable stream the session parses, so a driven Tab takes the
 * same path a user's would. 80x24 is the layout viewport every geometry
 * subtest measures against.
 */
function mockTransport(): MockTransport {
	let input!: ReadableStreamDefaultController<string>;
	return {
		cols: 80,
		rows: 24,
		colorDepth: "rgb",
		readable: new ReadableStream<string>({
			start(controller) {
				input = controller;
			},
		}),
		writable: new WritableStream<string>({write() {}}),
		resizes: new ReadableStream({start() {}}),
		sharesScreen: false,
		interactive: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		close() {},
		pushInput(text: string) {
			input.enqueue(text);
		},
	} as MockTransport;
}

/** The names a test file expects to find on its global. */
/**
 * The constructors come off the engine's window, which carries every
 * platform class; the module exports most of them as types only.
 */
function domGlobals(
	dom: DOMModule,
	window: DOM.Window,
): Record<string, unknown> {
	const names = [
		"AbstractRange",
		"AnimationEvent",
		"Attr",
		"BeforeUnloadEvent",
		"CDATASection",
		"CharacterData",
		"CommandEvent",
		"Comment",
		"CompositionEvent",
		"CSS",
		"CustomElementRegistry",
		"customElements",
		"CustomEvent",
		"CustomStateSet",
		"Document",
		"DocumentFragment",
		"DocumentType",
		"DOMImplementation",
		"DragEvent",
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
		"HTMLAllCollection",
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
		"HashChangeEvent",
		"Highlight",
		"HighlightRegistry",
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
		"MessageEvent",
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
		"StorageEvent",
		"SubmitEvent",
		"SVGElement",
		"Text",
		"TextEvent",
		"ToggleEvent",
		"TransitionEvent",
		"TreeWalker",
		"UIEvent",
		"ValidityState",
		"WheelEvent",
		"XMLDocument",
	];
	const globals: Record<string, unknown> = {};
	const source = dom as unknown as Record<string, unknown>;
	const fromWindow = window as unknown as Record<string, unknown>;
	for (const name of names) {
		globals[name] = fromWindow[name] ?? source[name];
	}
	return globals;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".wpt");
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

/**
 * How long a file runs before the runner ends it. testharness is set up with
 * an explicit timeout, as WPT's own runner sets it up, so ending it is a call
 * to its `timeout()`: every subtest still running is marked timed out and the
 * file reports what finished. A file whose harness never answers that is
 * recorded as a timeout with nothing reported.
 */
const TIMEOUT_MS = 5000;

/** How long a harness gets to report once it has been told to time out. */
const REPORT_GRACE_MS = 1000;

/** What `<meta name=timeout content=long>` buys a test. */
const LONG_TIMEOUT_MS = 60000;

async function cached(path: string): Promise<string | null> {
	const file = join(CACHE, path);
	if (existsSync(file)) {
		const text = readFileSync(file, "utf8");
		return text === "%%WPT-MISSING%%" ? null : text;
	}
	const response = await fetch(`${WPT_RAW}/${path}`);
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
		`https://api.github.com/repos/web-platform-tests/wpt/git/trees/${WPT_COMMIT}:${suite}?recursive=1`,
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
		if (entry.type !== "blob") {
			continue;
		}
		const parts = entry.path.split("/");
		const name = parts[parts.length - 1];
		if (parts.slice(0, -1).some((part) => NON_TEST_DIRECTORIES.has(part))) {
			continue;
		}
		if (!/\.html$/.test(name) && !/\.(any|window)\.js$/.test(name)) {
			continue;
		}
		if (/-ref\.html$|-manual\.html$|-crash\.html$/.test(name)) {
			continue;
		}
		names.push(`${suite}/${entry.path}`);
	}
	return names;
}

async function suiteFiles(suite: string): Promise<string[]> {
	const listing = join(CACHE, `${suite.replace(/\//g, "-")}-listing.json`);
	if (existsSync(listing)) {
		return JSON.parse(readFileSync(listing, "utf8"));
	}
	const names = (await listDirectory(suite)).sort();
	mkdirSync(CACHE, {recursive: true});
	writeFileSync(listing, JSON.stringify(names, null, "\t"));
	return names;
}

/**
 * The tests this DOM does not run, each with the one reason it does not.
 *
 * Every reason names something outside the tree: a browsing context, a script
 * the document's own parser must execute, touch input a terminal does not
 * report, a network fetch, a testdriver call into the browser itself, or a
 * proposal that is not a standard. "Hard" is not a reason, and neither is "later" -- everything
 * else either passes or is a failure this table does not hide.
 */
const EXCLUSIONS: Record<string, string> = {
	// requires-browsing-context: the test reaches a second document through a
	// frame whose src must be fetched, or a second JavaScript realm through
	// one. The engine loads no frame documents, and runs in one realm.
	"dom/nodes/Document-URL.html":
		"requires-browsing-context: a frame's document URL",
	"dom/nodes/Element-getElementsByTagName-change-document-HTMLNess.html":
		"requires-browsing-context: an element adopted between an HTML and an XML frame",
	"dom/nodes/Node-parentNode.html":
		"requires-browsing-context: a frame's document element parentage",
	"dom/nodes/query-target-in-load-event.html":
		"requires-browsing-context: the query runs in a frame's load event",
	"dom/nodes/moveBefore/iframe-document-preserve.window.js":
		"requires-browsing-context: the move happens inside a frame's document",
	"dom/nodes/moveBefore/css-transition-cross-document.html":
		"requires-browsing-context: the transitioning node moves into a frame's document",
	"dom/nodes/node-realm-adoption-after-frame-removal.html":
		"requires-browsing-context: a node's realm after its frame is removed",
	"dom/nodes/remove-and-adopt-thcrash.html":
		"requires-browsing-context: adoption into a frame's document",
	"dom/traversal/TreeWalker-realm.html":
		"requires-browsing-context: a TreeWalker built in another realm",
	"dom/traversal/TreeWalker-acceptNode-filter-cross-realm.html":
		"requires-browsing-context: filters that are objects from another realm",
	"dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html":
		"requires-browsing-context: a filter from a detached frame's realm",
	"dom/events/Event-dispatch-throwing-multiple-globals.html":
		"requires-browsing-context: which global an error event is fired at, across frames",
	"dom/events/Event-timestamp-cross-realm-getter.html":
		"requires-browsing-context: a timeStamp getter taken from a frame's realm",
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
	"dom/events/event-global-extra.window.js":
		"requires-browsing-context: window.event across frames",

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
		"requires-script-execution: the observer is installed by a script the parser runs partway through the document, and the records under test are the parser's own insertions",

	// requires-css-animations: the events under test are fired by the CSS
	// animation machinery (@keyframes), which the engine does not run yet.
	// Transitions run and fire their events; what keeps their two files out
	// is stated on each.
	"dom/events/EventListener-invoke-legacy.html":
		"requires-css-animations: four of the six subtests await a running CSS animation's events",
	"dom/events/webkit-animation-end-event.html":
		"requires-css-animations: a running CSS animation",
	"dom/events/webkit-animation-iteration-event.html":
		"requires-css-animations: a running CSS animation",
	"dom/events/webkit-animation-start-event.html":
		"requires-css-animations: a running CSS animation",

	"dom/nodes/remove-from-shadow-host-and-adopt-into-iframe.html":
		"requires-browsing-context: the node is adopted into a frame's document",
	"dom/nodes/MutationObserver-cross-realm-callback-report-exception.html":
		"requires-browsing-context: a callback taken from a frame's realm, and which global its exception is reported to",

	"dom/nodes/processing-instruction-attributes.html":
		"not-a-standard: the XML parses succeed, but 130 of the 140 subtests test declarative-partial-updates, a WICG incubation that gives processing instructions attributes, which the DOM Standard does not",

	// requires-browsing-context: the fixture is a rendered document inside an
	// iframe, which the untriaged suite's shared helper builds for every test
	// in it.
	"shadow-dom/leaktests/window-frames.html":
		"requires-browsing-context: whether a shadow tree's nodes leak into window.frames",
	"shadow-dom/leaktests/selection.html":
		"requires-browsing-context: a Selection over a rendered frame",
	"shadow-dom/declarative/declarative-shadow-dom-write-to-iframe.html":
		"requires-browsing-context: the markup is written into a frame's document",
	"shadow-dom/untriaged/elements-and-dom-objects/shadowroot-object/shadowroot-methods/test-004.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-dispatch/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/event-dispatch/test-003.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-focus-events/test-002.html":
		"requires-browsing-context: focus events in a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-focus-events/test-003.html":
		"requires-browsing-context: focus events in a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-relatedtarget/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/events/retargeting-relatedtarget/test-002.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/html-elements-in-shadow-trees/inert-html-elements/test-001.html":
		"requires-browsing-context: the fixture is a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-001.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-005.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/styles/test-008.html":
		"requires-browsing-context: styles applied in a rendered document in a frame",
	"shadow-dom/untriaged/user-interaction/ranges-and-selections/test-002.html":
		"requires-browsing-context: a Selection over a rendered document in a frame",

	// requires-touch-input: the test drives touches, which a terminal does
	// not report.
	"shadow-dom/touch-event-retargeting-leak.html":
		"requires-touch-input: a touch action sequence, and a terminal reports no touches",

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

	// customized built-ins: the is= form of a custom element. Safari never
	// shipped it and this DOM does not implement it; the files whose whole
	// subject is that form are excluded rather than counted.
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
	"selection/Document-open.html":
		"requires-browsing-context: the selection under test is an iframe's, across a document.open()",
	"selection/deleteFromDocument.html":
		"requires-browsing-context: the fixture is built in one iframe and compared against a reference document in another",
	"selection/textcontrols/click-input-after-iframe-focus.html":
		"requires-browsing-context: the focus moves in from an iframe",

	// Every subtest of each of these is outside this DOM by construction.
	"custom-elements/builtin-coverage.html":
		"customized built-ins: every case defines a customized built-in with an extends option",
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
		"requires-script-execution: each activation is observed through an inline on* content attribute, which becomes a handler only when compiled as script",
};

/**
 * Path prefixes the same reason excludes every file under.
 *
 * A prefix is here only where every file under it needs the same thing
 * outside the tree: a script the parser runs, a fetch, touch input, or an
 * incubation that is in no standard at all.
 */
const EXCLUDED_DIRECTORIES: Array<[string, string]> = [
	[
		"dom/ranges/tentative/",
		"not-a-standard: OpaqueRange and the createValueRange that builds one are a proposal, filed under tentative in the suite",
	],
	[
		"shadow-dom/focus-navigation/reading-flow/",
		"not-a-standard: the CSS reading-flow property these navigate by is a proposal, filed under tentative in the suite",
	],
	[
		"shadow-dom/focus-navigation/tentative/",
		"not-a-standard: focusgroup and the scroller focus rules are proposals, filed under tentative in the suite",
	],
	[
		"dom/events/non-cancelable-when-passive/passive-touch",
		"requires-touch-input: the case drives a touch, and a terminal reports no touches",
	],
	[
		"dom/events/non-cancelable-when-passive/non-passive-touch",
		"requires-touch-input: the case drives a touch, and a terminal reports no touches",
	],
	[
		"dom/nodes/Document-contentType/",
		"requires-fetch: the document's content type comes from the response that delivered it",
	],
	[
		"dom/nodes/Document-createElement-namespace-tests/",
		"not-a-test: these are the XHTML, SVG and MathML fixture documents Document-createElement-namespace.html loads into a frame; they carry no testharness of their own",
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
		"customized built-ins: the is= form of a custom element, which this DOM does not implement",
	],
];

function excludedDirectory(file: string): string | null {
	for (const [prefix, reason] of EXCLUDED_DIRECTORIES) {
		if (file.startsWith(prefix)) {
			return reason;
		}
	}
	return null;
}

/** Failures this DOM owns as design. They stay counted in the table. */
const DEVIATIONS: Array<[string, string]> = [
	[
		"dom/collections/HTMLCollection-own-props.html, HTMLCollection-delete.html, HTMLCollection-supported-property-indices.html, HTMLCollection-supported-property-names.html, HTMLCollection-as-prototype.html",
		"A collection's indexed and named properties are ordinary own accessors rather than a legacy platform object's exotic properties. This tree uses no Proxy anywhere. Reads and writes through the properties are correct and live. The differences are at the meta level. `delete collection.name` succeeds until the next mutation redefines it, `Object.defineProperty` over an existing index does not throw, and an index past the end can be shadowed by an expando.",
	],
	[
		"dom/nodes/Document-createEvent.https.html",
		"createEvent builds every name in the legacy table except three: DeviceMotionEvent, DeviceOrientationEvent and TouchEvent throw NotSupportedError, because sensors and touch digitizers name hardware a terminal does not have. The touch subtests declare the optional feature unsupported and score apart from failure; the sensor subtests fail and stay counted.",
	],
	[
		"dom/events/Event-subclasses-constructors.html",
		"The UI Events interfaces are implemented, and so are DragEvent, MessageEvent, HashChangeEvent, StorageEvent, TextEvent and BeforeUnloadEvent. The failing subtests construct interfaces that remain unimplemented: the sensor events, and the interfaces whose specifications this engine does not enter.",
	],
	[
		"selection/modify.tentative.html, bidi/modify-*.html, contenteditable/modify*.html, move-by-word-*.html",
		'Selection.modify() implements the "character", "word", "line", "lineboundary" and document-boundary granularities. "sentence" and "paragraph" do nothing. A line is a laid-out line rather than a property of the string, read from the layout of the attached document. A caret in an editing host stays in it.',
	],
	[
		"selection/shadow-dom/tentative/Selection-getComposedRanges-collapsed.html, Selection-getComposedRanges-range-update.html",
		"A selection whose range is inside a shadow tree of the document still answers `rangeCount` 1 and hands that range to `getRangeAt(0)`. The suite disagrees with itself here. Mozilla's cross-shadow-boundary-extend.html and shadow-dom/tentative/Range-isPointInRange.html, and WebKit's selection-at-nodes-not-part-of-flattened-tree.html, all read a range out of a selection that sits in a shadow tree. Chromium's Selection-getComposedRanges-range-update.html expects getRangeAt to throw for the same shape. This DOM follows the two engines against the one, and the subtest that wants the throw is counted as a failure.",
	],
	[
		"selection/shadow-dom/selection-at-nodes-not-part-of-flattened-tree.html",
		"`containsNode` answers over the node tree, so a node that a shadow root leaves out of the flattened tree is still contained in a selection over its parent. The four failing subtests expect false, which scores the flattened tree. That is a rendering question.",
	],
	[
		"dom/nodes/querySelector-id-nth-child.html",
		"An element's id does not become a property of the window. The HTML Standard calls the Window's named property access a legacy quirk, and this engine does not implement it, so a test that reaches a fixture by its bare id fails.",
	],
	[
		"dom/events/Body-FrameSet-Event-Handlers.html, and every subtest that reads an on* content attribute",
		"The event handler IDL attributes are implemented on HTMLElement, SVGElement, MathMLElement and Document. Their content-attribute half is not. `onclick=\"...\"` in markup is a function compiled from the attribute's value, and this engine never compiles script, so the attribute sets no handler and the IDL attribute reads back null.",
	],
	[
		"dom/collections/domstringmap-supported-property-names.html, custom-elements/reactions/DOMStringMap.html",
		"`dataset` answers with a DOMStringMap whose properties are ordinary own accessors, one per data-* attribute, for the same reason a collection's indexed properties are: this tree uses no Proxy anywhere. Reading and writing a name the element already carries goes straight through to the attribute. Assigning a name it does not carry yet creates an ordinary property instead of the attribute.",
	],
	[
		"custom-elements/HTMLElement-attachInternals.html, and the constraint validation members of the built-in controls",
		"`willValidate`, `validity`, `validationMessage`, `checkValidity`, `reportValidity` and `setCustomValidity` are on ElementInternals, where the flags are the author's own. They are absent from input, select, textarea, button, fieldset, object and output. Computing them for a built-in control needs the input value-space algorithms: converting a value to a number or a date per type, the step base, and the allowed value step. Those are not implemented. `:valid`, `:invalid`, `:user-valid`, `:user-invalid`, `:in-range` and `:out-of-range` read the same flags, so they are selectors this engine accepts and matches nothing with -- which is the `:invalid` subtest of dom/nodes/Element-closest.html.",
	],
	[
		"SVG and MathML elements",
		"An element in the SVG or MathML namespace is an SVGElement or a MathMLElement and nothing more. The SVGGraphicsElement and MathMLMathElement hierarchies, and the geometry and presentation interfaces under them, belong to other specifications and describe rendering this DOM does not do. Every tree operation over a foreign element is implemented: creation, namespace, cloning, serialization and selectors.",
	],
	[
		"shadow-dom/declarative/declarative-shadow-dom-attachment.html",
		"All 654 subtests pass and the harness reports a timeout. The file builds 654 declarative shadow trees in one document, and every live collection materialized along the way is resynchronized on each later mutation, because indexed properties are accessors rather than a proxy's traps. That cost is quadratic in the number of collections the file has read, and this file reads enough of them to exceed testharness's own ten-second limit.",
	],
	[
		"dom/nodes/NodeList-static-length-getter-tampered-*.html",
		"These pass their subtests and their harness times out. Each is a 250-million-iteration JIT stress loop over `nodeList[i]`, and an accessor property is slower to read than the exotic indexed getter a browser's binding layer generates.",
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
	if (src.startsWith("/")) {
		return src.slice(1);
	}
	const base = dirname(file);
	const parts = `${base}/${src}`.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") {
			continue;
		}
		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
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

// The timers the running file set. They are cleared when it is scored, so
// a callback it left behind cannot throw into the next file, where its
// error would be counted against a test that never raised it.
const fileTimers = new Set<ReturnType<typeof setTimeout>>();
// The runtime's own, taken before a file's scripts replace the globals.
const {setTimeout: runtimeSetTimeout, setInterval: runtimeSetInterval} =
	globalThis;

/**
 * The scope that makes the engine window this realm's global for name
 * lookup. A name the realm owns, a script's `var` or function or a global
 * installed above, is the realm's, as it would be the window's own property.
 * Any other name the engine window answers is read from and written to the
 * window, receiver and all, so every value is the engine's. A `with` scope
 * must answer `has` for names it cannot list in advance, which only a Proxy
 * can.
 */
function windowScope(realm: object, window: object): object {
	// eslint-disable-next-line no-restricted-globals
	return new Proxy(window, {
		has(target, name): boolean {
			return !Object.prototype.hasOwnProperty.call(realm, name) &&
				name in target;
		},
		get(target, name): unknown {
			return Reflect.get(target, name, target);
		},
		set(target, name, value): boolean {
			return Reflect.set(target, name, value, target);
		},
	});
}

/** Install this realm's DOM as the harness realm's DOM, and hand back the undo. */
function installGlobals(
	dom: DOMModule,
	engineWindow: DOM.Window,
	document: Document,
): HarnessGlobals {
	const scope = globalThis as unknown as Record<string, unknown>;
	const saved = new Map<string, {had: boolean; value: unknown}>();
	const win = engineWindow as unknown as {
		addEventListener: (...args: unknown[]) => void;
		removeEventListener: (...args: unknown[]) => void;
		dispatchEvent: (event: object) => boolean;
		getSelection: () => unknown;
		getComputedStyle: (...args: unknown[]) => unknown;
		customElements: unknown;
		requestAnimationFrame: (callback: (time: number) => void) => number;
		cancelAnimationFrame: (handle: number) => void;
		location: unknown;
	};
	const windowShim = {
		addEventListener: win.addEventListener.bind(win),
		removeEventListener: win.removeEventListener.bind(win),
		dispatchEvent: win.dispatchEvent.bind(win),
		getSelection: win.getSelection.bind(win),
	};
	const values: Record<string, unknown> = {
		...domGlobals(dom, engineWindow),
		document,
		// The registry is the window's, not the module's: a bare
		// `customElements.define` in a test file has to reach the one the
		// document upgrades through.
		customElements: win.customElements,
		getComputedStyle: win.getComputedStyle.bind(win),
		requestAnimationFrame: win.requestAnimationFrame.bind(win),
		cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
		setTimeout: (callback: () => void, delay?: number, ...args: unknown[]) => {
			const timer = runtimeSetTimeout(() => {
				fileTimers.delete(timer);
				callback(...(args as []));
			}, delay);
			fileTimers.add(timer);
			return timer;
		},
		setInterval: (callback: () => void, delay?: number, ...args: unknown[]) => {
			const timer = runtimeSetInterval(() => callback(...(args as [])), delay);
			fileTimers.add(timer);
			return timer;
		},
		location: win.location,
		...windowShim,
	};
	const names = [
		...Object.keys(values),
		"self",
		"window",
		"parent",
		"top",
		"frames",
	];
	// Everything is read before anything is written. Several of the runtime's
	// own globals are built on first read out of a module that reads other
	// globals as it loads, so a name saved after its neighbours were replaced
	// would be built against this DOM's classes instead of the runtime's.
	for (const name of names) {
		saved.set(name, {
			had: Object.prototype.hasOwnProperty.call(scope, name),
			value: scope[name],
		});
	}
	for (const [name, value] of Object.entries(values)) {
		scope[name] = value;
	}
	for (const name of ["self", "window", "parent", "top", "frames"]) {
		scope[name] = scope;
	}
	// `window.onerror = ...` and the other window handler attributes land on
	// the engine window, whose dispatch is what fires them. The harness
	// window is this realm's global, so each name is an accessor here.
	const handlerNames: string[] = [];
	for (
		let level = Object.getPrototypeOf(engineWindow) as object | null;
		level !== null;
		level = Object.getPrototypeOf(level) as object | null
	) {
		for (const name of Object.getOwnPropertyNames(level)) {
			if (/^on[a-z]/.test(name) && !handlerNames.includes(name)) {
				handlerNames.push(name);
			}
		}
	}
	const engineHandlers = engineWindow as unknown as Record<string, unknown>;
	const accessors = new Set(handlerNames);
	for (const name of handlerNames) {
		saved.set(name, {
			had: Object.prototype.hasOwnProperty.call(scope, name),
			value: scope[name],
		});
		Object.defineProperty(scope, name, {
			get: () => engineHandlers[name],
			set: (value: unknown) => {
				engineHandlers[name] = value;
			},
			configurable: true,
		});
	}
	return {
		restore(): void {
			for (const [name, entry] of saved) {
				if (accessors.has(name)) {
					delete scope[name];
				}
				if (entry.had) {
					scope[name] = entry.value;
				} else if (!accessors.has(name)) {
					delete scope[name];
				}
			}
		},
	};
}

// An error no script caught goes where a browser sends it: an error or
// unhandledrejection event at the running file's window, which testharness
// listens for. One from a file already finished, an async test whose timer
// fired after its globals were gone, is logged and does not stop the run.
let reportUncaught:
	((type: "error" | "unhandledrejection", reason: unknown) => void) | null =
		null;

function onUncaught(
	type: "error" | "unhandledrejection",
	reason: unknown,
): void {
	if (reportUncaught !== null) {
		reportUncaught(type, reason);
	} else {
		console.error(`uncaught after its file finished (${type}):`, reason);
	}
}

process.on("uncaughtException", (error) => onUncaught("error", error));
process.on("unhandledRejection", (reason) =>
	onUncaught("unhandledrejection", reason));

async function runFile(file: string): Promise<Outcome> {
	const reason = EXCLUSIONS[file] ?? excludedDirectory(file);
	if (reason != null) {
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

	const {dom, termdom} = await freshRealm();
	const transport = mockTransport();
	let engine: InstanceType<EngineModule["TermDOM"]>;
	try {
		engine = new termdom.TermDOM({transport, html, url});
	} catch (error) {
		return {
			file,
			harness: "ERROR",
			subtests: [],
			error: `parse: ${(error as Error).message}`,
		};
	}
	await engine.attach();
	try {
		return await runMountedFile(dom, engine, transport, file, html);
	} finally {
		engine.dispose();
	}
}

/** Run one test file against its attached engine; the caller disposes. */
async function runMountedFile(
	dom: DOMModule,
	engine: InstanceType<EngineModule["TermDOM"]>,
	transport: MockTransport,
	file: string,
	html: string,
): Promise<Outcome> {
	const document = engine.document as unknown as Document;

	const sources: string[] = [];
	let harnessLoaded = false;
	for (const script of document.getElementsByTagName("script")) {
		const src = script.getAttribute("src");
		if (src !== null) {
			if (/testharnessreport\.js$/.test(src)) {
				continue;
			}
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
				sources.push("setup({output: false, explicit_timeout: true});");
				continue;
			}
			if (/testdriver-vendor\.js$/.test(src)) {
				sources.push(TESTDRIVER_VENDOR);
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
			return {file, harness: "SKIPPED", subtests: [], error: "module script"};
		} else {
			sources.push(script.textContent ?? "");
		}
	}

	if (!harnessLoaded) {
		return {file, harness: "REFTEST", subtests: []};
	}

	const outcome: Outcome = {file, harness: "TIMEOUT", subtests: []};
	const globals = installGlobals(dom, engine.window, document);
	const scopeForDriver = globalThis as unknown as Record<string, unknown>;
	const hadDriverInput = Object.prototype.hasOwnProperty.call(
		scopeForDriver,
		"__termdomDriverInput",
	);
	scopeForDriver.__termdomDriverInput = (text: string) =>
		transport.pushInput(text);
	const scope = globalThis as unknown as Record<string, unknown>;
	// The names the realm had before the file ran. A classic script's `var` and
	// function declarations become properties of the global, and the file's are
	// dropped once it is done so the next file starts from a bare realm.
	const before = new Set(Object.keys(scope));
	const engineWindow = engine.window as unknown as {
		dispatchEvent(event: object): boolean;
		ErrorEvent: new (type: string, init: object) => object;
		Event: new (type: string) => object;
	};
	reportUncaught = (type, reason) => {
		if (type === "error") {
			engineWindow.dispatchEvent(
				new engineWindow.ErrorEvent("error", {
					error: reason,
					message: (reason as Error)?.message ?? String(reason),
				}),
			);
			return;
		}
		const event = new engineWindow.Event("unhandledrejection");
		Object.defineProperty(event, "reason", {value: reason});
		engineWindow.dispatchEvent(event);
	};
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
		// Registered as soon as the harness exists, as testharnessreport.js
		// is in a browser: an uncaught error while a later script still runs
		// completes the harness at once, and a callback registered after the
		// last script would never hear it.
		const harnessIndex = sources.findIndex((source) =>
			source.includes("function add_completion_callback"),
		);
		const body = sources
			.map((source, index) =>
				index === harnessIndex
					? `${source}\n;\nadd_completion_callback(__complete);`
					: source,
			)
			.join("\n;\n");
		try {
			// One block at global scope for the whole file: the harness and the
			// test share it exactly as they share a document's script scope. The
			// block is what a browser gives a classic script -- `var` and
			// function declarations land on the global, where a test that evals
			// a name (`params.map(eval)`) finds them, while `let` and `const`
			// stay in the file's own scope rather than the realm's. A browser's
			// global is the window, so a bare name the file's own globals do not
			// hold resolves through the engine window: its members, then its
			// named properties.
			scope.__termdomWindow = windowScope(scope, engine.window);
			(0, eval)(`with (__termdomWindow) {\n${body}\n}`);
			// The engine runs no page scripts, so this harness runs them in the
			// parser's place, and ends the parse as HTML does once they have
			// run: DOMContentLoaded at the document, then load at the window.
			document.dispatchEvent(
				new dom.Event("DOMContentLoaded", {bubbles: true}),
			);
			(scope.dispatchEvent as (event: object) => boolean)(
				new dom.Event("load"),
			);
		} catch (error) {
			return {
				file,
				harness: "ERROR",
				subtests: [],
				error: (error as Error).message,
			};
		}
		let grace: ReturnType<typeof setTimeout> | null = null;
		const timer = runtimeSetTimeout(() => {
			const timeout = scope.timeout;
			if (typeof timeout === "function") {
				try {
					timeout();
				} catch (_err) {
					// A harness that throws here reports nothing; the grace ends it.
				}
			}
			grace = runtimeSetTimeout(settle, REPORT_GRACE_MS);
		}, /<meta\s+name=["']?timeout["']?\s+content=["']?long/i.test(html)
			? LONG_TIMEOUT_MS
			: TIMEOUT_MS);
		await done;
		clearTimeout(timer);
		if (grace !== null) {
			clearTimeout(grace);
		}
	} finally {
		reportUncaught = null;
		for (const timer of fileTimers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		fileTimers.clear();
		delete scope.__complete;
		delete scope.__termdomWindow;
		if (!hadDriverInput) {
			delete scopeForDriver.__termdomDriverInput;
		}
		globals.restore();
		for (const name of Object.keys(scope)) {
			if (!before.has(name)) {
				delete scope[name];
			}
		}
	}
	return outcome;
}

// Each fresh evaluation of the engine graph is pinned in the module
// registry forever, so one process running every file holds O(files)
// graphs and dies near two gigabytes -- and an engine graph is heavy
// enough that even one suite's 300 files cross that line. A worker
// process per bounded slice of a suite hands its memory back on exit;
// the orchestrator only aggregates.
const WORKER_FILE_LIMIT = 50;
const workerSuite = process.argv[2] === "--suite" ? process.argv[3] : null;
const workerStart = workerSuite !== null && process.argv[4] === "--start"
	? Number(process.argv[5])
	: null;

function filterArgument(): string | undefined {
	if (workerSuite === null) {
		return process.argv[2];
	}
	return workerStart === null ? process.argv[4] : process.argv[6];
}

const filter = filterArgument();

async function runSuite(suite: string): Promise<Outcome[]> {
	let files = (await suiteFiles(suite)).filter(
		(file) => !filter || file.includes(filter),
	);
	if (workerStart !== null) {
		files = files.slice(workerStart, workerStart + WORKER_FILE_LIMIT);
	}
	const outcomes: Outcome[] = [];
	for (const file of files) {
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
		console.error(
			`${last.harness.padEnd(8)} ${passed}/${last.subtests.length} ${file}${
				last.error ? ` -- ${last.error}` : ""
			}`,
		);
	}
	return outcomes;
}

if (workerSuite !== null) {
	const outcomes = await runSuite(workerSuite);
	// A pipe write is asynchronous and process.exit abandons what has not
	// flushed, so the exit rides the write's completion callback. The hard
	// exit itself is required: abandoned TIMEOUT tests leave live timers
	// that would keep the worker alive forever.
	process.stdout.write(JSON.stringify(outcomes), () => {
		process.exit(0);
	});
	await new Promise(() => {});
}

const {spawnSync} = await import("node:child_process");
const outcomes: Outcome[] = [];
for (const suite of SUITES) {
	const suiteSize = (await suiteFiles(suite)).filter(
		(file) => !filter || file.includes(filter),
	).length;
	for (let start = 0;
		start === 0 || start < suiteSize;
		start += WORKER_FILE_LIMIT) {
		const result = spawnSync(
			process.execPath,
			[
				process.argv[1],
				"--suite",
				suite,
				"--start",
				String(start),
				...(filter ? [filter] : []),
			],
			{stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024},
		);
		const slice = `${suite}[${start}..]`;
		if (result.status !== 0) {
			console.error(`worker ${slice} exited ${result.status}/${result.signal}`);
			process.exit(1);
		}
		try {
			outcomes.push(...(JSON.parse(result.stdout.toString()) as Outcome[]));
		} catch (error) {
			console.error(
				`worker ${slice} emitted unparseable output ` +
				`(${result.stdout.length} bytes): ${(error as Error).message}`,
			);
			process.exit(1);
		}
	}
}

const all = outcomes.flatMap((outcome) => outcome.subtests);
// A subtest ending PRECONDITION_FAILED (4) declared an optional feature
// unsupported; testharness scores it apart from failure, and so does this.
const passed = all.filter((test) => test.status === 0);
const optional = all.filter((test) => test.status === 4);
const failed = all.filter((test) => test.status !== 0 && test.status !== 4);
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
	"Every test file is attached as the initial document of a full TermDOM",
	"engine over a mock 80x24 transport: the tree, the cascade, layout, focus",
	"and the CSSOM are all live under the test, and `document`, `Node`,",
	"`Element` and the rest of the realm's DOM globals are the engine's own",
	"classes. Each file gets its own evaluation of the whole engine graph, so",
	"a test that tampers with a prototype cannot reach the next file.",
	"",
	"The engine runs no page scripts, so the harness runs each file's",
	"scripts in the parser's place, with bare names resolving through the",
	"engine window as a browser's global does, and then fires",
	"DOMContentLoaded and load, as HTML does at the end of a parse. It sends",
	"uncaught errors to the window as error and unhandledrejection events.",
	"It supplies no behavior of its own, and no frame documents, so tests",
	"that need them fail.",
	"",
	`- Test files in the suites: ${outcomes.length}`,
	`- Reference tests (no testharness, scored by pixels): ${reftests.length}`,
	`- Excluded, each with its reason below: ${excluded.length}`,
	`- Optional-feature subtests reporting unsupported: ${optional.length}`,
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
	"above rather than excluded.",
	"",
	...DEVIATIONS.flatMap(([file, reason]) => [`### ${file}`, "", reason, ""]),
	"## Files",
	"",
	"| File | Harness | Passed | Failed |",
	"| --- | --- | ---: | ---: |",
];
for (const outcome of outcomes) {
	const filePassed = outcome.subtests.filter((test) => test.status === 0);
	const fileFailed = outcome.subtests.filter(
		(test) => test.status !== 0 && test.status !== 4,
	);
	lines.push(
		`| ${outcome.file} | ${outcome.harness}${
			outcome.error ? ` (${outcome.error})` : ""
		} | ${filePassed.length} | ${fileFailed.length} |`,
	);
}

lines.push("", "## Failing subtests", "");
for (const outcome of outcomes) {
	const fails = outcome.subtests.filter(
		(test) => test.status !== 0 && test.status !== 4,
	);
	if (fails.length === 0) {
		continue;
	}
	lines.push(`### ${outcome.file}`, "");
	for (const test of fails) {
		lines.push(`- ${test.name}: ${(test.message ?? "").split("\n")[0]}`);
	}
	lines.push("");
}

if (filter) {
	for (const outcome of outcomes) {
		for (const test of outcome.subtests) {
			if (test.status === 0) {
				continue;
			}
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
