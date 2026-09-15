import b9g from "@b9g/eslint-config";

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
