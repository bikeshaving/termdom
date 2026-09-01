/**
 * Event dispatch across shadow boundaries.
 *
 * Retargeting is the mechanism the whole shadow relatedTarget family runs on:
 * every struct of the path carries a related target retargeted against its own
 * invocation target, so a listener never sees a node from a tree it cannot
 * reach into. The question retargeting asks is whether a tree is one the other
 * object can see, and the answer is shadow-including: a tree reached through a
 * host of one's own is a tree one is inside.
 */
import {test, expect} from "@b9g/libuild/test";
import {
	FocusEvent,
	type Document,
	parseHTMLDocument,
} from "../src/internal/dom.js";

// The door a test document comes through. The parser is the one that hands
// a document the realm's custom element registry, as it does the engine's.
function createHTMLDocument(title?: string): Document {
	return parseHTMLDocument(
		title === undefined
			? "<!doctype html>"
			: `<!doctype html><title>${title}</title>`,
	);
}

/**
 * A host in a document, a shadow tree on it holding a sibling and a second
 * host, and a node in that second host's tree.
 *
 *   document > host #shadow-root > [sibling, inner #shadow-root > deep]
 */
interface NestedTrees {
	document: any;
	host: any;
	outer: any;
	sibling: any;
	inner: any;
	innerShadow: any;
	deep: any;
}

function nestedTrees(mode: "open" | "closed" = "open"): NestedTrees {
	const document = createHTMLDocument("") as any;
	const host = document.createElement("div");
	document.body.append(host);
	const outer = host.attachShadow({mode});
	const sibling = document.createElement("span");
	const inner = document.createElement("div");
	outer.append(sibling, inner);
	const innerShadow = inner.attachShadow({mode});
	const deep = document.createElement("b");
	innerShadow.append(deep);
	return {document, host, outer, sibling, inner, innerShadow, deep};
}

test("a related target stays itself for a target in a tree below it", () => {
	// The outer tree is a shadow-including inclusive ancestor of the deep
	// node, so the deep node can see the sibling and gets it unchanged.
	for (const mode of ["open", "closed"] as const) {
		const {sibling, deep} = nestedTrees(mode);
		let seen: unknown = null;
		deep.addEventListener("demo", (event: any) => {
			seen = event.relatedTarget;
		});
		deep.dispatchEvent(new FocusEvent("demo", {relatedTarget: sibling}));
		expect(`${mode}: ${seen === sibling}`).toBe(`${mode}: true`);
	}
});

test("a related target in a tree below is retargeted to the host", () => {
	// The other direction: the deep node's tree is not one the sibling can
	// reach into, so the sibling sees the host that stands for it.
	const {sibling, inner, deep} = nestedTrees();
	let seen: unknown = null;
	sibling.addEventListener("demo", (event: any) => {
		seen = event.relatedTarget;
	});
	sibling.dispatchEvent(new FocusEvent("demo", {relatedTarget: deep}));
	expect(seen === inner).toBe(true);
});

test("every struct of the path carries its own retargeted related target", () => {
	// One dispatch, three trees. Every tree between the deep node and the
	// outer tree can reach the sibling, so every listener there sees it -- and
	// the walk ends at the host, because retargeting the sibling against the
	// host gives the host itself, which is where a path stops.
	const {document, host, outer, sibling, inner, deep} = nestedTrees();
	const seen: unknown[] = [];
	for (const target of [deep, inner, outer, host, document.body]) {
		target.addEventListener("demo", (event: any) => {
			seen.push(event.relatedTarget ?? "no related target");
		});
	}
	deep.dispatchEvent(
		new FocusEvent("demo", {
			relatedTarget: sibling,
			bubbles: true,
			composed: true,
		}),
	);
	expect(seen).toEqual([sibling, sibling, sibling]);
});

test("a detached checkbox flips without announcing it", () => {
	const document = createHTMLDocument("") as any;
	const box = document.createElement("input");
	box.type = "checkbox";
	const fired: string[] = [];
	box.addEventListener("input", () => fired.push("input"));
	box.addEventListener("change", () => fired.push("change"));

	box.click();
	// The checkedness is the legacy-pre-activation behavior's, which runs for
	// a detached element too; only the events are held back.
	expect(`${box.checked} ${fired.join(",")}`).toBe("true ");

	document.body.append(box);
	box.click();
	expect(`${box.checked} ${fired.join(",")}`).toBe("false input,change");
});

test("a disconnected form does not submit", () => {
	const document = createHTMLDocument("") as any;
	const form = document.createElement("form");
	const button = document.createElement("button");
	button.type = "submit";
	form.append(button);
	let submits = 0;
	form.addEventListener("submit", () => submits++);

	form.requestSubmit();
	button.click();
	expect(submits).toBe(0);

	document.body.append(form);
	form.requestSubmit();
	expect(submits).toBe(1);
	button.click();
	expect(submits).toBe(2);
});

test("a canceled click puts back the state the type it has now keeps", () => {
	const document = createHTMLDocument("") as any;
	// A radio button whose group already has a checked member: canceling the
	// click restores that member, and only while it is still in the group.
	document.body.innerHTML = `
		<form>
			<input type="radio" name="g" id="one" checked>
			<input type="radio" name="g" id="two">
		</form>
	`;
	const one = document.getElementById("one");
	const two = document.getElementById("two");
	two.addEventListener("click", (event: any) => event.preventDefault());
	two.click();
	expect(`${one.checked} ${two.checked}`).toBe("true false");

	// A checkbox that a listener turns into a radio button mid-click: the
	// state to put back is the state a radio button keeps, and this click took
	// no reference to a previously checked one.
	const box = document.createElement("input");
	box.type = "checkbox";
	document.body.append(box);
	box.addEventListener("click", (event: any) => {
		box.type = "radio";
		event.preventDefault();
	});
	box.click();
	expect(box.checked).toBe(false);
	// The radio button the earlier click referenced is not touched by it.
	expect(one.checked).toBe(true);
});
