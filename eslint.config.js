import b9g from "@b9g/eslint-config";

import termdom from "./eslint.rules.js";

const indentOptions = b9g.find((config) => config.rules?.["@stylistic/indent"])
	.rules["@stylistic/indent"][2];

export default [
	...b9g,
	{
		// The website is its own package with its own conventions; .wpt is a
		// cache of fetched web-platform-tests.
		ignores: ["website/**", ".wpt/**"],
	},
	{
		plugins: {termdom},
		rules: {
			// An engine that parses and emits terminal escape sequences writes
			// regexes about control characters on purpose.
			"no-control-regex": "off",
			// A class reads top to bottom: what it holds, how it is built, what
			// it derives, then what it does.
			"@typescript-eslint/member-ordering": [
				"error",
				{
					classes: [
						"signature",
						"field",
						"constructor",
						["get", "set"],
						"method",
					],
					interfaces: "never",
					typeLiterals: "never",
				},
			],
			// Inside each group, statics first and public before symbol-keyed; a
			// symbol is declared before its first use.
			"termdom/member-visibility-order": "error",
			"termdom/symbol-before-use": "error",
			"termdom/import-order": "error",
			// The names inside one import's braces read in a fixed order; the
			// imports themselves stay in the order they were written.
			"sort-imports": [
				"error",
				{ignoreCase: true, ignoreDeclarationSort: true},
			],
		},
	},
	{
		// Scripts and examples print to the terminal as their job. URL is a
		// runtime global everywhere the scripts run.
		files: ["scripts/**", "examples/**"],
		languageOptions: {globals: {URL: "readonly"}},
		rules: {"no-console": "off"},
	},
	{
		// The examples are shown in the website's playground, where a tab is
		// as wide as the browser says, so they are indented with two spaces.
		files: ["examples/**"],
		rules: {
			"@stylistic/indent": ["error", 2, indentOptions],
			"@stylistic/indent-binary-ops": ["error", 2],
			"@stylistic/no-tabs": "error",
		},
	},
];
