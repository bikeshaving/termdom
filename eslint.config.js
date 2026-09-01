import b9g from "@b9g/eslint-config";
import termdom from "./eslint.rules.js";

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
			// helper one class uses sits below it; a symbol is declared before
			// its first use.
			"termdom/member-visibility-order": "error",
			"termdom/helper-below-class": "error",
			"termdom/symbol-before-use": "error",
			// The names inside one import's braces read in a fixed order; the
			// imports themselves stay in the order they were written.
			"sort-imports": [
				"error",
				{
					ignoreCase: true,
					ignoreDeclarationSort: true,
				},
			],
		},
	},
	{
		// The DOM installs its constants and mixins on prototypes at load; the
		// interfaces beside those classes declare what was installed.
		files: ["src/internal/dom.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-declaration-merging": "off",
			"@typescript-eslint/no-empty-object-type": "off",
		},
	},
	{
		// Scripts and examples print to the terminal as their job. URL is a
		// runtime global everywhere the scripts run.
		files: ["scripts/**", "examples/**"],
		languageOptions: {globals: {URL: "readonly"}},
		rules: {"no-console": "off"},
	},
];
