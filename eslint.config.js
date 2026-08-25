import b9g from "@b9g/eslint-config";
import house from "./eslint-rules/symbol-near-use.js";

export default [
	...b9g,
	{
		// Symbols are private state, and the house rule is that they sit with
		// what they serve. See eslint-rules/symbol-near-use.js.
		files: ["src/**/*.ts"],
		plugins: {house},
		rules: {"house/symbol-near-use": "error"},
	},
	{
		// The website is its own package with its own conventions; .wpt is a
		// cache of fetched web-platform-tests.
		ignores: ["website/**", ".wpt/**"],
	},
	{
		rules: {
			// An engine that parses and emits terminal escape sequences writes
			// regexes about control characters on purpose.
			"no-control-regex": "off",
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
