import ts from "typescript";
import {readFileSync, writeFileSync} from "node:fs";

const root = "/Users/brian/Projects/termdom";
const config = ts.readConfigFile(root + "/tsconfig.json", ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
const probe = root + "/scripts/tmp-probe/probe.ts";
const program = ts.createProgram([probe], parsed.options);
const checker = program.getTypeChecker();
const source = program.getSourceFile(probe);

const out = {};
ts.forEachChild(source, (node) => {
	if (!ts.isVariableStatement(node)) return;
	for (const decl of node.declarationList.declarations) {
		const name = decl.name.getText();
		if (!name.startsWith("pair_")) continue;
		const cls = name.slice(5);
		const type = checker.getTypeAtLocation(decl.name);
		const [platform, engine] = checker.getTypeArguments(type);
		const has = new Set(checker.getPropertiesOfType(engine).map((s) => s.getName()));
		out[cls] = checker
			.getPropertiesOfType(platform)
			.map((s) => s.getName())
			.filter((n) => !has.has(n));
	}
});
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
const counts = Object.entries(out).filter(([, m]) => m.length).sort((a, b) => b[1].length - a[1].length);
console.log("classes with missing members:", counts.length);
for (const [cls, m] of counts) console.log(String(m.length).padStart(4), cls);
