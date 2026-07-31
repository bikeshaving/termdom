// rrweb-cssom is the CSSOM parser jsdom itself uses; it ships no types.
// Only parse() is consumed, and its output is shaped like a CSSStyleSheet
// (cssRules with selectorText/style/media), which #parseStyleSheet already
// speaks.
declare module "rrweb-cssom" {
	export function parse(cssText: string): {cssRules: CSSRuleList};
}
