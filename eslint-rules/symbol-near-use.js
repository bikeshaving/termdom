/**
 * A top-level `const k... = Symbol(...)` must sit with what it serves.
 *
 * Symbols are this codebase's private state: a slot on a class, or a hook one
 * function reaches for. Piling their declarations in a file header puts them
 * hundreds of lines from the code that gives them meaning, and the pile is
 * what the file teaches -- the next declaration joins it.
 *
 * A declaration passes when either holds:
 *
 *   - the identifier is used again within NEAR lines, so the reader who
 *     reaches the declaration can see why it exists; or
 *   - the next top-level declaration that is not itself a symbol uses it,
 *     which is the class-slot case: however long the class, the run of
 *     symbols sits immediately above the class that declares their slots.
 *
 * NEAR is 40 -- a screenful and a half. It is what the re-homed files need:
 * a symbol reached by a function below it lands well inside, and a run of
 * slot symbols is carried by the second test rather than the first. A header
 * pile satisfies neither, since the declaration under each of its members is
 * another symbol.
 */
const NEAR = 40;

function symbolName(statement) {
	if (statement.type !== "VariableDeclaration" || statement.kind !== "const") {
		return null;
	}
	if (statement.declarations.length !== 1) {
		return null;
	}
	const declarator = statement.declarations[0];
	const init = declarator.init;
	if (
		declarator.id.type !== "Identifier" ||
		!init ||
		init.type !== "CallExpression" ||
		init.callee.type !== "Identifier" ||
		init.callee.name !== "Symbol"
	) {
		return null;
	}
	return declarator.id.name;
}

const rule = {
	meta: {
		type: "suggestion",
		schema: [],
		messages: {
			far:
				"`{{name}}` is declared {{lines}} lines from anything that uses " +
				"it. Move it above the declaration it serves.",
			unused: "`{{name}}` is declared and never used below.",
		},
	},
	create(context) {
		const sourceCode = context.sourceCode ?? context.getSourceCode();
		return {
			Program(program) {
				const body = program.body;
				for (let i = 0; i < body.length; i++) {
					const name = symbolName(body[i]);
					if (name === null) {
						continue;
					}
					const declared = body[i].loc.start.line;
					const uses = sourceCode
						.getDeclaredVariables(body[i])
						.flatMap((variable) => variable.references)
						.map((reference) => reference.identifier)
						.filter((identifier) => identifier.range[0] > body[i].range[1])
						.sort((one, other) => one.range[0] - other.range[0]);
					if (uses.length === 0) {
						context.report({node: body[i], messageId: "unused", data: {name}});
						continue;
					}
					const nearest = uses[0].loc.start.line;
					if (nearest - declared <= NEAR) {
						continue;
					}
					// The run of symbol declarations is one group: what must use
					// them is the declaration the group sits above.
					let next = i + 1;
					while (next < body.length && symbolName(body[next]) !== null) {
						next++;
					}
					const served = body[next];
					if (
						served &&
						uses.some(
							(use) =>
								use.range[0] >= served.range[0] &&
								use.range[1] <= served.range[1],
						)
					) {
						continue;
					}
					context.report({
						node: body[i],
						messageId: "far",
						data: {name, lines: String(nearest - declared)},
					});
				}
			},
		};
	},
};

export default {rules: {"symbol-near-use": rule}};
