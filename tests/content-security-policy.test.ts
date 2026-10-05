/**
 * The policy a document's loads are checked against: CSP3's directives,
 * source lists and matching, as a program and a page's own meta tags set
 * it.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	getBlockingDirective,
	parseContentSecurityPolicies,
} from "../src/internal/resources.ts";

function allows(
	policy: string,
	url: string,
	self = "https://mail.example/inbox",
	destination: RequestDestination = "image",
): boolean {
	return getBlockingDirective(
		parseContentSecurityPolicies(policy),
		new URL(url),
		destination,
		new URL(self),
	) === null;
}

test("img-src governs an image, and default-src stands in for it", () => {
	expect(allows("img-src https:", "https://cdn.example/a.png")).toBe(true);
	expect(allows("img-src https:", "http://cdn.example/a.png")).toBe(false);
	expect(allows("default-src data:", "data:image/png;base64,AAAA")).toBe(true);
	expect(allows("default-src data:", "https://cdn.example/a.png")).toBe(false);
	// img-src replaces default-src for images; it does not add to it.
	expect(allows("default-src *; img-src cid:", "https://cdn.example/a.png"))
		.toBe(false);
	// A policy that names neither governs nothing an image does.
	expect(allows("style-src 'none'", "https://cdn.example/a.png")).toBe(true);
});

test("'none', an empty list and keywords match nothing", () => {
	expect(allows("img-src 'none'", "data:image/png;base64,AAAA")).toBe(false);
	expect(allows("img-src", "https://cdn.example/a.png")).toBe(false);
	expect(
		allows("img-src 'unsafe-inline' 'nonce-abc'", "https://cdn.example/a.png"),
	)
		.toBe(false);
});

test("* matches the network schemes and the document's own, not data: or cid:", () => {
	expect(allows("img-src *", "https://cdn.example/a.png")).toBe(true);
	expect(allows("img-src *", "http://cdn.example/a.png")).toBe(true);
	expect(allows("img-src *", "data:image/png;base64,AAAA")).toBe(false);
	expect(allows("img-src *", "cid:logo@example.com")).toBe(false);
	expect(allows("img-src *", "file:///a.png", "file:///home/me/")).toBe(true);
});

test("a scheme matches itself and its secure counterpart", () => {
	expect(allows("img-src cid:", "cid:logo@example.com")).toBe(true);
	expect(allows("img-src CID:", "cid:logo@example.com")).toBe(true);
	expect(allows("img-src http:", "https://cdn.example/a.png")).toBe(true);
	expect(allows("img-src https:", "http://cdn.example/a.png")).toBe(false);
	// ws also matches the http schemes.
	expect(allows("img-src ws:", "http://cdn.example/a.png")).toBe(true);
	expect(allows("img-src ws:", "https://cdn.example/a.png")).toBe(true);
	expect(allows("img-src wss:", "http://cdn.example/a.png")).toBe(false);
});

test("a path is compared piece by piece, each piece percent-decoded", () => {
	expect(
		allows(
			"img-src https://cdn.example/a%20b/",
			"https://cdn.example/a b/c.png",
		),
	)
		.toBe(true);
	// An encoded slash is part of a piece, not a separator.
	expect(allows("img-src https://c.example/a/b", "https://c.example/a%2Fb"))
		.toBe(false);
	// A malformed escape compares as itself rather than failing.
	expect(
		allows(
			"img-src https://cdn.example/images/",
			"https://cdn.example/images/%E0.png",
		),
	)
		.toBe(true);
	expect(allows("img-src https://cdn.example/%E0", "https://cdn.example/%E0"))
		.toBe(true);
	expect(allows("img-src https://cdn.example/", "https://cdn.example/a/b.png"))
		.toBe(true);
});

test("a redirect's target is matched without its path", () => {
	const policies =
		parseContentSecurityPolicies("img-src https://cdn.example/img/");
	const self = new URL("https://mail.example/");
	const elsewhere = new URL("https://cdn.example/other/a.png");
	expect(getBlockingDirective(policies, elsewhere, "image", self, 0))
		.not.toBeNull();
	expect(getBlockingDirective(policies, elsewhere, "image", self, 1))
		.toBeNull();
	expect(
		getBlockingDirective(
			policies,
			new URL("https://evil.example/img/a.png"),
			"image",
			self,
			1,
		),
	)
		.not.toBeNull();
});

test("a host matches itself, a wildcard its subdomains, and a port or path narrows it", () => {
	expect(allows("img-src https://cdn.example", "https://cdn.example/a.png"))
		.toBe(true);
	expect(allows("img-src https://CDN.example", "https://cdn.example/a.png"))
		.toBe(true);
	expect(allows("img-src https://*.example", "https://cdn.example/a.png"))
		.toBe(true);
	expect(allows("img-src https://*.example", "https://example/a.png"))
		.toBe(false);
	expect(
		allows("img-src https://cdn.example", "https://cdn.example:8443/a.png"),
	)
		.toBe(false);
	expect(
		allows("img-src https://cdn.example:*", "https://cdn.example:8443/a.png"),
	)
		.toBe(true);
	expect(
		allows("img-src https://cdn.example/img/", "https://cdn.example/img/a.png"),
	)
		.toBe(true);
	expect(
		allows("img-src https://cdn.example/img/", "https://cdn.example/css/a.png"),
	)
		.toBe(false);
	expect(
		allows(
			"img-src https://cdn.example/img/a.png",
			"https://cdn.example/img/a.png",
		),
	)
		.toBe(true);
	expect(
		allows(
			"img-src https://cdn.example/img/a.png",
			"https://cdn.example/img/b.png",
		),
	)
		.toBe(false);
});

test("a host without a scheme takes the document's, and the network's for a document not served from it", () => {
	expect(allows("img-src cdn.example", "https://cdn.example/a.png")).toBe(true);
	expect(
		allows("img-src cdn.example", "https://cdn.example/a.png", "about:blank"),
	)
		.toBe(true);
	expect(
		allows(
			"img-src cdn.example",
			"http://cdn.example/a.png",
			"https://mail.example/",
		),
	)
		.toBe(false);
});

test("'self' matches the document's origin and its upgrade, and nothing for an opaque one", () => {
	expect(allows("img-src 'self'", "https://mail.example/logo.png")).toBe(true);
	expect(allows("img-src 'self'", "https://cdn.example/logo.png")).toBe(false);
	expect(
		allows(
			"img-src 'self'",
			"https://mail.example/a.png",
			"http://mail.example/",
		),
	)
		.toBe(true);
	expect(allows("img-src 'self'", "file:///a.png", "file:///home/me/")).toBe(
		false,
	);
	// The same host over wss, and the port must agree.
	expect(
		allows("img-src 'self'", "wss://mail.example/a", "https://mail.example/"),
	)
		.toBe(true);
	expect(
		allows(
			"img-src 'self'",
			"https://mail.example/a.png",
			"http://mail.example:8080/",
		),
	)
		.toBe(false);
	expect(
		allows(
			"img-src 'self'",
			"https://mail.example:8080/a.png",
			"http://mail.example:8080/",
		),
	)
		.toBe(true);
	// An https document does not allow http from its own host.
	expect(allows("img-src 'self'", "http://mail.example/a.png")).toBe(false);
});

test("every policy in a list must allow a load", () => {
	expect(
		allows(
			"img-src https:, img-src https://cdn.example",
			"https://cdn.example/a.png",
		),
	)
		.toBe(true);
	expect(
		allows(
			"img-src https:, img-src https://cdn.example",
			"https://other.example/a.png",
		),
	)
		.toBe(false);
	const blocked = getBlockingDirective(
		parseContentSecurityPolicies("img-src *, default-src 'self'"),
		new URL("https://cdn.example/a.png"),
		"image",
		new URL("https://mail.example/"),
	);
	expect([blocked?.directive, blocked?.policy.text])
		.toEqual(["default-src", "default-src 'self'"]);
});
