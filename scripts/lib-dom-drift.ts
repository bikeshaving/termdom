// Resolves every Drift alias in tests/lib-dom-exact.ts and prints the members
// each names. Exits nonzero when any class drifts from lib.dom.
import ts from "typescript";

const cfg = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ".");
const program = ts.createProgram(["tests/lib-dom-exact.ts"], parsed.options);
const checker = program.getTypeChecker();
const sf = program.getSourceFile("tests/lib-dom-exact.ts")!;

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
process.exit(drifting === 0 ? 0 : 1);
