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

function enclosingTopLevel(source, node) {
	let statement = node;
	while (statement.parent && statement.parent.type !== "Program") {
		statement = statement.parent;
	}
	return statement;
}

const helperBelowClass = {
	meta: {
		type: "layout",
		schema: [],
		messages: {
			below: "Only {{className}} uses {{name}}: define it after the class, not before.",
		},
	},
	create(context) {
		const source = context.sourceCode;
		return {
			"Program > FunctionDeclaration"(node) {
				if (!node.id) {
					return;
				}
				const [variable] = source.getDeclaredVariables(node);
				if (!variable) {
					return;
				}
				let owner = null;
				for (const reference of variable.references) {
					const statement = enclosingTopLevel(source, reference.identifier);
					if (statement === node) {
						continue;
					}
					if (statement.type !== "ClassDeclaration") {
						return;
					}
					if (owner !== null && owner !== statement) {
						return;
					}
					owner = statement;
				}
				if (owner !== null && node.range[0] < owner.range[0]) {
					context.report({
						node: node.id,
						messageId: "below",
						data: {
							name: node.id.name,
							className: owner.id?.name ?? "the class",
						},
					});
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

export default {
	rules: {
		"member-visibility-order": memberVisibilityOrder,
		"helper-below-class": helperBelowClass,
		"symbol-before-use": symbolBeforeUse,
	},
};
