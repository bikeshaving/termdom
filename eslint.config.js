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
			// TODO(acrocase): re-enable once the SCREAMING_SNAKE substring fix
			// (VALID -> VALId) ships in eslint-plugin-acrocase.
			"acrocase/acrocase": "off",
		},
	},
];
