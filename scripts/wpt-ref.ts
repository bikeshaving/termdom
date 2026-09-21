/**
 * The web-platform-tests revision the conformance runs are against.
 *
 * A branch name would make the reports irreproducible: two runs a week apart
 * would grade different suites, and a report's numbers could move with no
 * change here. Bump this deliberately, and regenerate the reports with it.
 */
export const WPT_COMMIT = "16ddb735c5027ffc79f410c9a83f5766b810ca58";

export const WPT_RAW =
	`https://raw.githubusercontent.com/web-platform-tests/wpt/${WPT_COMMIT}`;
