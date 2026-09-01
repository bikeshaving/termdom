import {builtinModules} from "node:module";

/**
 * The orderings this codebase keeps that no shipped rule can state: inside
 * each class member group, static members before instance ones and public
 * members before symbol-keyed (private) ones; a helper function that only
 * one class uses below that class; a symbol constant above its first use.
 */

const GROUP = {
	TSIndexSignature: 0,
	PropertyDefinition: 1,
	TSAbstractPropertyDefinition: 1,
	AccessorProperty: 1,
};

function groupOf(member) {
	if (member.type in GROUP) {
		return GROUP[member.type];
	}
	if (member.kind === "constructor") {
		return 2;
	}
	if (member.kind === "get" || member.kind === "set") {
		return 3;
	}
	return 4;
}

function isSymbolKeyed(member) {
	return member.computed === true && member.key?.type === "Identifier";
}

const memberVisibilityOrder = {
	meta: {
		type: "layout",
		schema: [],
		messages: {
			staticFirst: "A static member goes before the instance members of its group.",
			publicFirst: "A symbol-keyed member goes after the public members of its group.",
		},
	},
	create(context) {
		return {
			ClassBody(body) {
				const groups = new Map();
				for (const member of body.body) {
					const group = groupOf(member);
					if (!groups.has(group)) {
						groups.set(group, []);
					}
					groups.get(group).push(member);
				}
				for (const members of groups.values()) {
					let seenInstance = false;
					let seenSymbol = false;
					for (const member of members) {
						if (member.static) {
							if (seenInstance) {
								context.report({node: member, messageId: "staticFirst"});
								break;
							}
						} else {
							seenInstance = true;
						}
					}
					for (const member of members) {
						if (isSymbolKeyed(member)) {
							seenSymbol = true;
						} else if (seenSymbol && member.key) {
							context.report({node: member, messageId: "publicFirst"});
							break;
						}
					}
				}
			},
		};
	},
};

const symbolBeforeUse = {
	meta: {
		type: "layout",
		schema: [],
		messages: {
			before: "{{name}} is used above its declaration: declare the symbol first.",
		},
	},
	create(context) {
		const source = context.sourceCode;
		return {
			"Program > VariableDeclaration > VariableDeclarator"(node) {
				if (
					node.id.type !== "Identifier" ||
					node.init?.type !== "CallExpression" ||
					node.init.callee.type !== "Identifier" ||
					node.init.callee.name !== "Symbol"
				) {
					return;
				}
				const [variable] = source.getDeclaredVariables(node);
				for (const reference of variable?.references ?? []) {
					if (reference.identifier.range[0] < node.range[0]) {
						context.report({
							node: node.id,
							messageId: "before",
							data: {name: node.id.name},
						});
						return;
					}
				}
			},
		};
	},
};

/**
 * Imports read the way Python sorts them: the side-effect imports first, in
 * the order written; then Node's own modules; then packages; then this
 * repository's own files -- a blank line between the groups, and each
 * group alphabetical by module, a value import ahead of a type import of
 * the same module.
 */
const BUILTINS = new Set(builtinModules);

function importGroup(node) {
	const source = node.source.value;
	if (node.specifiers.length === 0) {
		return 0;
	}
	if (source.startsWith("node:") || BUILTINS.has(source)) {
		return 1;
	}
	if (source.startsWith(".")) {
		return 3;
	}
	return 2;
}

function importShape(node) {
	const [first] = node.specifiers;
	if (!first) {
		return 0;
	}
	if (first.type === "ImportNamespaceSpecifier") {
		return 1;
	}
	if (first.type === "ImportDefaultSpecifier") {
		return 2;
	}
	return 3;
}

function importKey(node, index) {
	return [
		importGroup(node),
		importGroup(node) === 0 ? "" : node.source.value.toLowerCase(),
		importShape(node),
		node.importKind === "type" ? 1 : 0,
		index,
	];
}

function compareKeys(a, b) {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) {
			return -1;
		}
		if (a[i] > b[i]) {
			return 1;
		}
	}
	return 0;
}

const importOrder = {
	meta: {
		type: "layout",
		fixable: "code",
		schema: [],
		messages: {
			order: "Imports go side-effect, builtin, package, then relative -- each group alphabetical, a blank line between.",
		},
	},
	create(context) {
		const source = context.sourceCode;
		return {
			Program(program) {
				const block = [];
				for (const statement of program.body) {
					if (statement.type !== "ImportDeclaration") {
						break;
					}
					block.push(statement);
				}
				if (block.length < 2) {
					return;
				}
				const keyed = block.map((node, index) => ({
					node,
					index,
					key: importKey(node, index),
				}));
				const sorted = [...keyed].sort((a, b) => compareKeys(a.key, b.key));
				// Each import carries the comment written above it.
				const slice = (entry) => {
					const start = entry.index === 0
						? entry.node.range[0]
						: block[entry.index - 1].range[1];
					return source
						.text
						.slice(start, entry.node.range[1])
						.replace(/^\s*\n/, "");
				};
				let expected = "";
				let previousGroup = null;
				for (const entry of sorted) {
					const group = entry.key[0];
					if (previousGroup !== null) {
						expected += group === previousGroup ? "\n" : "\n\n";
					}
					expected += slice(entry);
					previousGroup = group;
				}
				const range = [block[0].range[0], block[block.length - 1].range[1]];
				if (source.text.slice(range[0], range[1]) === expected) {
					return;
				}
				context.report({
					node: block[0],
					messageId: "order",
					fix: (fixer) => fixer.replaceTextRange(range, expected),
				});
			},
		};
	},
};

export default {
	rules: {
		"import-order": importOrder,
		"member-visibility-order": memberVisibilityOrder,
		"symbol-before-use": symbolBeforeUse,
	},
};
