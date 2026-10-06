// Resolves every Drift alias in scripts/lib-dom-exact.ts and prints the members
// each names. Exits nonzero when any class drifts from lib.dom.
import ts from "typescript";

const cfg = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ".");
const program = ts.createProgram(["scripts/lib-dom-exact.ts"], parsed.options);
const checker = program.getTypeChecker();
const sf = program.getSourceFile("scripts/lib-dom-exact.ts")!;

function members(t: ts.Type): string[] {
	if (t.flags & ts.TypeFlags.Never) {
		return [];
	}
	if (t.isUnion()) {
		return t.types.flatMap(members);
	}
	if (t.isStringLiteral()) {
		return [t.value];
	}
	const c = checker.getBaseConstraintOfType(t);
	if (c && c !== t) {
		return members(c);
	}
	return ["<" + checker.typeToString(t) + ">"];
}

let drifting = 0;
let exact = 0;
for (const st of sf.statements) {
	if (
		!ts.isTypeAliasDeclaration(st) ||
		!/Drift$/.test(st.name.text) ||
		st.typeParameters
	) {
		continue;
	}
	const m = members(checker.getTypeAtLocation(st.type));
	if (m.length === 0) {
		exact++;
		continue;
	}
	drifting++;
	console.log(
		st.name.text.replace(/Drift$/, "").padEnd(28),
		m.length + ": " + m.join(", "),
	);
}
console.log(`\n${exact} exact, ${drifting} drifting`);

// The ledger above checks the classes it names for every member lib.dom
// has. This checks every interface a page can reach for members lib.dom
// does not have: a name the engine made up, or an internal that leaked.
const globals = new Map<string, Set<string>>();
const scope = checker.getSymbolsInScope(
	sf,
	ts.SymbolFlags.Interface |
	ts.SymbolFlags.Variable |
		ts.SymbolFlags.Function |
	ts.SymbolFlags.Namespace,
);
const globalNames = new Set<string>();
for (const symbol of scope) {
	const fromLib = symbol.declarations?.some((declaration) =>
		program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
	);
	if (!fromLib) {
		continue;
	}
	if (
		symbol.flags &
		(ts.SymbolFlags.Variable |
			ts.SymbolFlags.Function |
			ts.SymbolFlags.Namespace)
	) {
		globalNames.add(symbol.name);
	}
	if (symbol.flags & ts.SymbolFlags.Interface) {
		const type = checker.getDeclaredTypeOfSymbol(symbol);
		globals.set(
			symbol.name,
			new Set(checker.getPropertiesOfType(type).map((p) => p.name)),
		);
	}
	if (symbol.flags & ts.SymbolFlags.Namespace) {
		const names = globals.get(symbol.name) ?? new Set<string>();
		for (const member of checker.getExportsOfModule(symbol)) {
			names.add(member.name);
		}
		globals.set(symbol.name, names);
	}
}

function statics(name: string): Set<string> {
	const symbol = scope.find((s) =>
		s.name === name && s.flags & ts.SymbolFlags.Variable,
	);
	if (symbol === undefined) {
		return new Set();
	}
	const type = checker.getTypeOfSymbol(symbol);
	return new Set(checker.getPropertiesOfType(type).map((p) => p.name));
}

// Members a current standard defines that this TypeScript's lib.dom does
// not have yet. Each names where it is defined.
const AHEAD_OF_LIB_DOM: Record<string, Record<string, string>> = {
	HTMLElement: {
		headingOffset: "https://html.spec.whatwg.org/#dom-headingoffset",
		headingReset: "https://html.spec.whatwg.org/#dom-headingreset",
	},
	HTMLInputElement: {alpha: "https://html.spec.whatwg.org/#dom-input-alpha"},
	HTMLImageElement: {
		controls: "https://html.spec.whatwg.org/#dom-img-controls",
	},
	HTMLAreaElement: {
		hreflang: "https://html.spec.whatwg.org/#dom-area-hreflang",
		type: "https://html.spec.whatwg.org/#dom-area-type",
	},
	Window: {
		trustedTypes: "https://w3c.github.io/trusted-types/dist/spec/#dom-windoworworkerglobalscope-trustedtypes",
		TrustedHTML: "https://w3c.github.io/trusted-types/dist/spec/#trustedhtml",
		TrustedScript: "https://w3c.github.io/trusted-types/dist/spec/#trustedscript",
		TrustedScriptURL: "https://w3c.github.io/trusted-types/dist/spec/#trustedscripturl",
		TrustedTypePolicy: "https://w3c.github.io/trusted-types/dist/spec/#trustedtypepolicy",
		TrustedTypePolicyFactory: "https://w3c.github.io/trusted-types/dist/spec/#trustedtypepolicyfactory",
	},
	CSSFontFeatureValuesRule: {
		annotation: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-annotation",
		ornaments: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-ornaments",
		stylistic: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-stylistic",
		swash: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-swash",
		characterVariant: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-charactervariant",
		styleset: "https://drafts.csswg.org/css-fonts-4/#dom-cssfontfeaturevaluesrule-styleset",
	},
};

// The runtime's own objects, handed to the page as they are. FormData
// extends the runtime's so that its fetch() takes one, and performance is
// the runtime's.
const FROM_THE_RUNTIME: Record<string, Set<string>> = {
	FormData: new Set(
		Object.getOwnPropertyNames(globalThis.FormData?.prototype ?? {}),
	),
	Performance: new Set(
		Object.getOwnPropertyNames(Object.getPrototypeOf(globalThis.performance)),
	),
};

// TermDOM's own, and the only names allowed to be.
const TERMDOM_OWN = new Set(["CanvasCharacterGridContext"]);

// CSSOM gives a declaration an attribute for every supported property,
// camel-cased, dashed and webkit-cased, which lib.dom lists only some of.
const {CSS_PROPERTIES} = await import("../src/generated/cssproperties.ts");
const CSS_PROPERTY_NAMES = new Set<string>();
for (const property of CSS_PROPERTIES) {
	const camel =
		property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
	CSS_PROPERTY_NAMES.add(property).add(camel);
	if (property.startsWith("-webkit-")) {
		CSS_PROPERTY_NAMES.add(camel[0].toUpperCase() + camel.slice(1));
		CSS_PROPERTY_NAMES.add("webkit" + camel.slice(6));
	}
}
const DECLARATIONS = new Set(["CSSStyleDeclaration", "CSSStyleProperties"]);

// Interfaces with a named getter: an instance's own properties are the
// names of what it holds, an id or a name, which no ledger can list.
const NAMED_GETTERS = new Set([
	"HTMLCollection",
	"HTMLAllCollection",
	"HTMLFormControlsCollection",
	"HTMLOptionsCollection",
	"NamedNodeMap",
	"DOMStringMap",
	"StyleSheetList",
]);

const {TermDOM} = await import("../src/index.ts");
const termDOM = new TermDOM({
	transport: {write() {}, columns: 80, rows: 24} as never,
	html: "<!doctype html>",
});
const window = termDOM.window as unknown as Record<string, unknown>;
const document = window.document as Document;
const extras: string[] = [];
const checked = new Map<object, Set<string>>();

function allowedOn(name: string): Set<string> {
	const allowed = new Set(globals.get(name));
	if (name === "Window") {
		for (const global of globalNames) {
			allowed.add(global);
		}
		for (const own of TERMDOM_OWN) {
			allowed.add(own);
		}
	}
	for (const member of Object.keys(AHEAD_OF_LIB_DOM[name] ?? {})) {
		allowed.add(member);
	}
	for (const member of FROM_THE_RUNTIME[name] ?? []) {
		allowed.add(member);
	}
	return allowed;
}

// The language's own prototypes. An interface whose chain reaches one
// is checked up to it: DOMException's reaches Error.prototype, as Web IDL
// says it does.
const INTRINSICS = new Set<object>([
	Object.prototype,
	Function.prototype,
	Array.prototype,
	Error.prototype,
]);

// Every own string-keyed member from the object up to the language's own
// prototypes. A member on the interface's parent is checked against the
// parent.
function check(name: string, object: object): void {
	const allowed = allowedOn(name);
	let proto: object | null = object;
	for (; proto !== null &&
		!INTRINSICS.has(proto); proto = Object.getPrototypeOf(proto)) {
		const owner = proto === object
			? name
			: (proto as {constructor?: {name?: string}}).constructor?.name ?? name;
		if (owner !== name && !globals.has(owner)) {
			extras.push(`${name} inherits from ${owner}`);
		}
		// A parent's prototype is checked once for each interface above it,
		// since what that interface may have differs.
		const seen = checked.get(proto) ?? new Set<string>();
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		checked.set(proto, seen);
		const own = owner === name ? allowed : allowedOn(owner);
		for (const key of Object.getOwnPropertyNames(proto)) {
			// An indexed property is the interface's indexed getter.
			if (/^(0|[1-9][0-9]*)$/.test(key)) {
				continue;
			}
			if (DECLARATIONS.has(name) && CSS_PROPERTY_NAMES.has(key)) {
				continue;
			}
			if (proto === object && NAMED_GETTERS.has(name)) {
				continue;
			}
			if (key !== "constructor" && !own.has(key) && !allowed.has(key)) {
				extras.push(`${owner}.${key}`);
			}
		}
	}
	if (
		proto !== null &&
		proto !== Object.prototype &&
		!(proto === Error.prototype && name === "DOMException")
	) {
		extras.push(`${name} inherits from ${proto.constructor.name}.prototype`);
	}
}

for (const key of Object.getOwnPropertyNames(window)) {
	const value = window[key];
	if (
		typeof value !== "function" ||
		!/^[A-Z]/.test(key) ||
		!(value as {prototype?: object}).prototype
	) {
		continue;
	}
	if (TERMDOM_OWN.has(key)) {
		continue;
	}
	if (!globals.has(key)) {
		if (!globalNames.has(key)) {
			extras.push(key);
		}
		continue;
	}
	const allowedStatics = statics(key);
	for (const member of Object.getOwnPropertyNames(value)) {
		if (
			![
				"length",
				"name",
				"prototype",
				"caller",
				"arguments",
			].includes(member) &&
			!allowedStatics.has(member)
		) {
			extras.push(`${key}.${member} (static)`);
		}
	}
	check(key, (value as {prototype: object}).prototype);
}

const canvas = document.createElement("canvas");
for (
	const [name, object] of [
		["Window", window],
		["Document", document],
		["Navigator", window.navigator],
		["Screen", window.screen],
		["Location", window.location],
		["History", window.history],
		["Performance", window.performance],
		["Storage", window.localStorage],
		["CSS", window.CSS],
		[
			"CSSStyleDeclaration",
			(termDOM.window as unknown as Window).getComputedStyle(document.body),
		],
		["CanvasRenderingContext2D", canvas.getContext("2d")],
	] as Array<[string, object | undefined]>
) {
	if (object != null) {
		check(name, object);
	}
}
// What a page gets back from a call is an instance of the interface
// itself, never of a subclass the engine made for its own use.
document.body.innerHTML =
	"<p class=x name=n>a</p><form><input name=i><select><option>o</select></form>";
const form = document.querySelector("form")!;
const page = termDOM.window as unknown as Window;
for (
	const [name, object] of [
		["HTMLCollection", document.getElementsByClassName("x")],
		["HTMLCollection", document.getElementsByTagName("p")],
		["HTMLCollection", document.body.children],
		["NodeList", document.querySelectorAll("p")],
		["NodeList", document.body.childNodes],
		["NodeList", document.getElementsByName("n")],
		["DOMTokenList", document.body.classList],
		["NamedNodeMap", document.body.attributes],
		["HTMLAllCollection", document.all],
		["HTMLFormControlsCollection", form.elements],
		["HTMLOptionsCollection", form.querySelector("select")!.options],
		["DOMStringMap", document.body.dataset],
		["ValidityState", form.querySelector("input")!.validity],
		["CSSStyleProperties", page.getComputedStyle(document.body)],
		["CSSStyleProperties", page.getComputedStyle(document.body, "::before")],
		["CSSStyleProperties", page.getComputedStyle(document.body, "::nonsense")],
		["CSSStyleProperties", document.body.style],
		["DOMRectList", document.body.getClientRects()],
		["DOMRect", document.body.getBoundingClientRect()],
		["StyleSheetList", document.styleSheets],
		["DOMImplementation", document.implementation],
		["TreeWalker", document.createTreeWalker(document.body)],
		["NodeIterator", document.createNodeIterator(document.body)],
		["Range", document.createRange()],
		["Selection", page.getSelection()],
	] as Array<[string, object | null]>
) {
	const expected = (window[name] as {prototype?: object} | undefined)
		?.prototype;
	if (object !== null && Object.getPrototypeOf(object) !== expected) {
		extras.push(
			`a page's ${name} is a ${
				(object as {constructor?: {name?: string}}).constructor?.name
			}`,
		);
	}
	if (object !== null) {
		check(name, object);
	}
}
termDOM.dispose();

for (const extra of extras) {
	console.log("extra".padEnd(28), extra);
}
console.log(`${extras.length} members lib.dom does not have`);
process.exit(drifting === 0 && extras.length === 0 ? 0 : 1);
