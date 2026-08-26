import b9g from "@b9g/eslint-config";

export default [
	...b9g,
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
