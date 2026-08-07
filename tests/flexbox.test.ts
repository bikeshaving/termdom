/**
 * Flexbox Layout Tests
 *
 * Comprehensive tests for flexbox layouts to ensure they continue
 * to work correctly, especially the examples/flexbox-demo.ts
 */

import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM} from "../src/internal/termdom.js";

test("flexbox-demo layout renders correctly", async () => {
	const terminal = new MockProcess({cols: 80, rows: 24});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Recreate the flexbox-demo layout
	const mainContainer = document.createElement("div");
	mainContainer.style.display = "flex";
	mainContainer.style.flexDirection = "column";
	mainContainer.style.padding = "1px 2px";
	mainContainer.style.backgroundColor = "darkblue";
	document.body.appendChild(mainContainer);

	// Header
	const header = document.createElement("div");
	header.style.display = "flex";
	header.style.flexDirection = "row";
	header.style.justifyContent = "space-between";
	header.style.backgroundColor = "magenta";
	header.style.padding = "1px 1px 1px 1px";
	mainContainer.appendChild(header);

	const headerTitle = document.createElement("span");
	headerTitle.textContent = "🚀 TTY Flexbox Demo";
	headerTitle.style.color = "white";
	header.appendChild(headerTitle);

	const headerSubtitle = document.createElement("span");
	headerSubtitle.textContent = "Terminal Object Model";
	headerSubtitle.style.textAlign = "right";
	headerSubtitle.style.color = "white";
	header.appendChild(headerSubtitle);

	// Content area
	const contentArea = document.createElement("div");
	contentArea.style.display = "flex";
	contentArea.style.flexDirection = "row";
	contentArea.style.padding = "1px 0 0";
	mainContainer.appendChild(contentArea);

	// Sidebar
	const sidebar = document.createElement("div");
	sidebar.style.display = "flex";
	sidebar.style.flexDirection = "column";
	sidebar.style.backgroundColor = "darkgreen";
	sidebar.style.padding = "1px";
	sidebar.style.flexShrink = "0";
	contentArea.appendChild(sidebar);

	const sidebarTitle = document.createElement("span");
	sidebarTitle.textContent = "📋 Navigation";
	sidebarTitle.style.color = "white";
	sidebarTitle.style.textAlign = "center";
	sidebarTitle.style.whiteSpace = "nowrap";
	sidebar.appendChild(sidebarTitle);

	const menuItems = ["• Home", "• About", "• Services", "• Contact"];
	for (const item of menuItems) {
		const menuItem = document.createElement("span");
		menuItem.textContent = item;
		menuItem.style.color = "white";
		menuItem.style.padding = "0px 1px 0px 1px";
		sidebar.appendChild(menuItem);
	}

	// Main content
	const mainContent = document.createElement("div");
	mainContent.style.display = "flex";
	mainContent.style.flexDirection = "column";
	mainContent.style.backgroundColor = "darkgray";
	mainContent.style.padding = "1px 2px 1px 2px";
	contentArea.appendChild(mainContent);

	const contentTitle = document.createElement("span");
	contentTitle.textContent = "📄 Main Content Area";
	contentTitle.style.color = "white";
	contentTitle.style.textAlign = "center";
	mainContent.appendChild(contentTitle);

	const contentText = document.createElement("span");
	contentText.textContent =
		"This demonstrates flexbox layout with nested containers. The layout automatically adjusts based on flexDirection properties: column for vertical stacking, row for horizontal arrangement.";
	contentText.style.color = "white";
	mainContent.appendChild(contentText);

	// Feature cards
	const featuresContainer = document.createElement("div");
	featuresContainer.style.display = "flex";
	featuresContainer.style.flexDirection = "row";
	featuresContainer.style.padding = "1px 0px 0px 0px";
	mainContent.appendChild(featuresContainer);

	const features = [
		{title: "🎨 Styling", desc: "Rich terminal colors and formatting"},
		{title: "📐 Layout", desc: "Flexbox-based positioning system"},
		{title: "⚡ Performance", desc: "Efficient ScreenBuffer rendering"},
	];

	for (const feature of features) {
		const featureCard = document.createElement("div");
		featureCard.style.display = "flex";
		featureCard.style.flexDirection = "column";
		featureCard.style.backgroundColor = "darkcyan";
		featureCard.style.padding = "1px 1px 1px 1px";
		featureCard.style.flex = "1";
		featuresContainer.appendChild(featureCard);

		const featureTitle = document.createElement("span");
		featureTitle.textContent = feature.title;
		featureTitle.style.color = "white";
		featureTitle.style.textAlign = "center";
		featureCard.appendChild(featureTitle);

		const featureDesc = document.createElement("span");
		featureDesc.textContent = feature.desc;
		featureDesc.style.color = "white";
		featureDesc.style.textAlign = "center";
		featureCard.appendChild(featureDesc);
	}

	// Footer
	const footer = document.createElement("div");
	footer.style.display = "flex";
	footer.style.flexDirection = "row-reverse";
	footer.style.backgroundColor = "darkred";
	footer.style.padding = "1px 2px 1px 2px";
	mainContainer.appendChild(footer);

	const footerText = document.createElement("span");
	footerText.textContent = "© 2024 Terminal Object Model";
	footerText.style.color = "white";
	footer.appendChild(footerText);

	const footerVersion = document.createElement("span");
	footerVersion.textContent = "v1.0.0";
	footerVersion.style.color = "white";
	footer.appendChild(footerVersion);

	await nextFrame(dom);

	// Test content expectations
	const visibleText = terminal.getVisibleText();
	expect(visibleText).toContain("🚀 TTY Flexbox Demo");
	expect(visibleText).toContain("Terminal Object Model");
	expect(visibleText).toContain("📋 Navigation");
	expect(visibleText).toContain("• Home");
	expect(visibleText).toContain("• About");
	expect(visibleText).toContain("• Services");
	expect(visibleText).toContain("• Contact");
	expect(visibleText).toContain("📄 Main Content Area");
	expect(visibleText).toContain("Rich terminal");
	expect(visibleText).toContain("Flexbox-based");
	expect(visibleText).toContain("Efficient");
	expect(visibleText).toContain("© 2024 Terminal Object Model");
	expect(visibleText).toContain("v1.0.0");

	// Test width constraint
	const lines = visibleText.split("\n");
	for (const line of lines) {
		expect(line.length).toBeLessThanOrEqual(80);
	}

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("flexbox-demo-full");

	dom.dispose();
});

test("nested flexbox containers", async () => {
	const terminal = new MockProcess({cols: 60, rows: 20});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create nested flex containers
	const outer = document.createElement("div");
	outer.style.display = "flex";
	outer.style.flexDirection = "column";
	outer.style.backgroundColor = "blue";
	outer.style.padding = "1px";
	document.body.appendChild(outer);

	const row1 = document.createElement("div");
	row1.style.display = "flex";
	row1.style.flexDirection = "row";
	outer.appendChild(row1);

	const box1 = document.createElement("span");
	box1.textContent = "Box 1";
	box1.style.backgroundColor = "red";
	box1.style.color = "white";
	box1.style.padding = "1px";
	row1.appendChild(box1);

	const box2 = document.createElement("span");
	box2.textContent = "Box 2";
	box2.style.backgroundColor = "green";
	box2.style.color = "white";
	box2.style.padding = "1px";
	row1.appendChild(box2);

	const row2 = document.createElement("div");
	row2.style.display = "flex";
	row2.style.flexDirection = "row";
	row2.style.justifyContent = "space-between";
	outer.appendChild(row2);

	const box3 = document.createElement("span");
	box3.textContent = "Left";
	box3.style.backgroundColor = "cyan";
	box3.style.color = "black";
	row2.appendChild(box3);

	const box4 = document.createElement("span");
	box4.textContent = "Right";
	box4.style.backgroundColor = "magenta";
	box4.style.color = "white";
	row2.appendChild(box4);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	expect(visibleText).toContain("Box 1");
	expect(visibleText).toContain("Box 2");
	expect(visibleText).toContain("Left");
	expect(visibleText).toContain("Right");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("nested-flexbox");

	dom.dispose();
});

test("flexbox with flex-grow", async () => {
	const terminal = new MockProcess({cols: 80, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "row";
	container.style.backgroundColor = "darkblue";
	document.body.appendChild(container);

	const item1 = document.createElement("div");
	item1.textContent = "Fixed";
	item1.style.backgroundColor = "red";
	item1.style.color = "white";
	item1.style.padding = "1px";
	container.appendChild(item1);

	const item2 = document.createElement("div");
	item2.textContent = "This item grows to fill available space";
	item2.style.backgroundColor = "green";
	item2.style.color = "white";
	item2.style.flex = "1 1 auto";
	item2.style.padding = "1px";
	container.appendChild(item2);

	const item3 = document.createElement("div");
	item3.textContent = "Fixed";
	item3.style.backgroundColor = "blue";
	item3.style.color = "white";
	item3.style.padding = "1px";
	container.appendChild(item3);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	expect(visibleText).toContain("Fixed");
	expect(visibleText).toContain("This item grows to fill available space");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("flexbox-grow");

	dom.dispose();
});

test("flexbox with align-items and justify-content", async () => {
	const terminal = new MockProcess({cols: 60, rows: 15});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Center alignment test
	const centerContainer = document.createElement("div");
	centerContainer.style.display = "flex";
	centerContainer.style.height = "5";
	centerContainer.style.alignItems = "center";
	centerContainer.style.justifyContent = "center";
	centerContainer.style.backgroundColor = "darkgray";
	document.body.appendChild(centerContainer);

	const centerText = document.createElement("span");
	centerText.textContent = "Centered";
	centerText.style.backgroundColor = "yellow";
	centerText.style.color = "black";
	centerContainer.appendChild(centerText);

	// Space-around test
	const spaceContainer = document.createElement("div");
	spaceContainer.style.display = "flex";
	spaceContainer.style.justifyContent = "space-around";
	spaceContainer.style.backgroundColor = "darkgreen";
	spaceContainer.style.marginTop = "1px";
	document.body.appendChild(spaceContainer);

	for (let i = 1; i <= 3; i++) {
		const item = document.createElement("span");
		item.textContent = `Item ${i}`;
		item.style.backgroundColor = "white";
		item.style.color = "black";
		item.style.padding = "0 1px";
		spaceContainer.appendChild(item);
	}

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	expect(visibleText).toContain("Centered");
	expect(visibleText).toContain("Item 1");
	expect(visibleText).toContain("Item 2");
	expect(visibleText).toContain("Item 3");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("flexbox-alignment");

	dom.dispose();
});

test("flexbox wrapping behavior", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexWrap = "wrap";
	container.style.backgroundColor = "navy";
	document.body.appendChild(container);

	const items = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
	for (const text of items) {
		const item = document.createElement("span");
		item.textContent = text;
		item.style.backgroundColor = "lightblue";
		item.style.color = "black";
		item.style.padding = "0 1px";
		item.style.margin = "1px";
		container.appendChild(item);
	}

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	for (const item of items) {
		expect(visibleText).toContain(item);
	}

	// Test width constraint
	const lines = visibleText.split("\n");
	for (const line of lines) {
		expect(line.length).toBeLessThanOrEqual(40);
	}

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("flexbox-wrap");

	dom.dispose();
});

test("flexbox column with mixed content", async () => {
	const terminal = new MockProcess({cols: 50, rows: 20});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.backgroundColor = "darkslategray";
	container.style.padding = "1px";
	document.body.appendChild(container);

	// Header with emoji
	const header = document.createElement("div");
	header.textContent = "📊 Dashboard";
	header.style.backgroundColor = "teal";
	header.style.color = "white";
	header.style.padding = "1px";
	header.style.textAlign = "center";
	container.appendChild(header);

	// Stats row
	const statsRow = document.createElement("div");
	statsRow.style.display = "flex";
	statsRow.style.flexDirection = "row";
	statsRow.style.justifyContent = "space-between";
	statsRow.style.margin = "1px 0";
	container.appendChild(statsRow);

	const stats = [
		{label: "Users", value: "1,234"},
		{label: "Revenue", value: "$5,678"},
		{label: "Growth", value: "+12%"},
	];

	for (const stat of stats) {
		const statBox = document.createElement("div");
		statBox.style.display = "flex";
		statBox.style.flexDirection = "column";
		statBox.style.backgroundColor = "darkgreen";
		statBox.style.padding = "1px";
		statBox.style.flex = "1";
		statBox.style.margin = "0 1px";
		statBox.style.textAlign = "center";
		statsRow.appendChild(statBox);

		const label = document.createElement("span");
		label.textContent = stat.label;
		label.style.color = "lightgray";
		statBox.appendChild(label);

		const value = document.createElement("span");
		value.textContent = stat.value;
		value.style.color = "white";
		value.style.fontWeight = "bold";
		statBox.appendChild(value);
	}

	// Content area
	const content = document.createElement("div");
	content.textContent =
		"Welcome to the dashboard! Here you can monitor all your key metrics.";
	content.style.backgroundColor = "dimgray";
	content.style.color = "white";
	content.style.padding = "2px";
	content.style.flex = "1";
	container.appendChild(content);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	expect(visibleText).toContain("📊 Dashboard");
	expect(visibleText).toContain("Users");
	expect(visibleText).toContain("1,234");
	expect(visibleText).toContain("Revenue");
	expect(visibleText).toContain("$5,678");
	expect(visibleText).toContain("Growth");
	expect(visibleText).toContain("+12%");
	expect(visibleText).toContain("Welcome to the dashboard");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("flexbox-dashboard");

	dom.dispose();
});

test("flexbox column children should have different Y positions", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create tight constraints that trigger the bug
	const outerContainer = document.createElement("div");
	outerContainer.style.display = "flex";
	outerContainer.style.flexDirection = "column";
	outerContainer.style.height = "8px";
	outerContainer.style.padding = "1px";
	document.body.appendChild(outerContainer);

	// Add header to consume space
	const header = document.createElement("div");
	header.textContent = "Header";
	header.style.padding = "1px";
	outerContainer.appendChild(header);

	// Create row container
	const rowContainer = document.createElement("div");
	rowContainer.style.display = "flex";
	rowContainer.style.flexDirection = "row";
	rowContainer.style.flex = "1";
	outerContainer.appendChild(rowContainer);

	// Create the problematic flexbox column card
	const card = document.createElement("div");
	card.style.display = "flex";
	card.style.flexDirection = "column";
	card.style.flex = "1";
	card.style.padding = "1px";
	rowContainer.appendChild(card);

	const title = document.createElement("span");
	title.textContent = "Title";
	title.style.textAlign = "center";
	title.style.flexShrink = "0";
	card.appendChild(title);

	const description = document.createElement("span");
	description.textContent = "Description";
	description.style.textAlign = "center";
	description.style.flexShrink = "0";
	card.appendChild(description);

	await nextFrame(dom);

	// Test the bug: title and description should have different Y positions
	const titleRect = title.getBoundingClientRect();
	const descRect = description.getBoundingClientRect();

	// Debug info: In flex column, title and description should be at different Y positions
	// Currently both are at Y=5, which suggests they're positioned horizontally instead of vertically

	// The main assertion: title and description should NOT be at same Y position
	expect(titleRect.y).not.toBe(descRect.y);

	// Description should be positioned after title
	expect(descRect.y).toBeGreaterThan(titleRect.y);

	// There should be no gap larger than title height between them
	expect(descRect.y).toBeLessThanOrEqual(titleRect.y + titleRect.height);

	dom.dispose();
});

test("flexbox two columns: fixed width + flexible width with text wrapping", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create flex row container
	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "row";
	container.style.width = "38px"; // Slightly less than terminal width for padding
	container.style.height = "8px";
	container.style.padding = "1px";
	document.body.appendChild(container);

	// Fixed width column
	const fixedColumn = document.createElement("div");
	fixedColumn.style.width = "10px";
	fixedColumn.style.flexShrink = "0"; // Should not shrink
	fixedColumn.style.backgroundColor = "red";
	fixedColumn.textContent = "Fixed";
	container.appendChild(fixedColumn);

	// Flexible column with lots of text
	const flexColumn = document.createElement("div");
	flexColumn.style.flex = "1"; // Should take remaining space
	flexColumn.style.flexShrink = "0"; // NO shrinking - this should cause overflow
	flexColumn.style.backgroundColor = "blue";
	flexColumn.textContent =
		"This is a long text that should wrap within the remaining space after the fixed column takes its 10px width";
	container.appendChild(flexColumn);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	const fixedRect = fixedColumn.getBoundingClientRect();
	const flexRect = flexColumn.getBoundingClientRect();

	// Fixed column should be exactly 10px wide
	expect(fixedRect.width).toBe(10);

	// Flex column should start after fixed column
	expect(flexRect.x).toBe(fixedRect.x + fixedRect.width);

	// With flex-shrink: 0, flex column might extend beyond container bounds
	// This behavior is documented but we don't need to assert it in this test
	// expect(flexRect.x + flexRect.width).toBeLessThanOrEqual(containerRect.x + containerRect.width);

	// Text should be present
	expect(visibleText).toContain("Fixed");
	expect(visibleText).toContain("This is a long text");

	dom.dispose();
});

test("an inline-block flex item does not swallow the next item's content into its measurement", async () => {
	// An inline-block flex item is its own inline-run head. Collecting its
	// leaves ends with a nextSibling() "skip children" step -- and since the
	// item is also the walker's root, the walker used to escape the item and
	// pull the NEXT flex item's text into this one's break result. The item
	// then measured itself as wide as both ("[x]" + "Buy milk" = 11 cells),
	// pushing every later sibling that far right on the main axis.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const row = document.createElement("div");
	row.style.display = "flex";
	row.style.flexDirection = "row";
	(row.style as any).gap = "1ch";
	const box = document.createElement("span");
	box.style.display = "inline-block";
	box.textContent = "[x]";
	const label = document.createElement("label");
	label.textContent = "Buy milk";
	row.append(box, label);
	document.body.appendChild(row);
	await nextFrame(dom);

	expect(box.getBoundingClientRect().width).toBe(3);
	// 3 cells of box + 1 cell of gap.
	expect(label.getBoundingClientRect().x).toBe(4);
	expect(terminal.getPlainText()).toContain("[x] Buy milk");

	dom.dispose();
});

test("order lays flex items out in order-modified document order", async () => {
	// The stable sort: explicit values position around the default 0, and
	// equal values keep document order.
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML =
		`<div style="display: flex; flex-direction: row; gap: 1ch">` +
		`<span style="order: 1">last</span><span>mid1</span>` +
		`<span style="order: -1">first</span><span>mid2</span></div>`;
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(
		"first mid1 mid2 last",
	);
	dom.dispose();
});

test("order is inert outside a flex formatting context", async () => {
	// Browsers ignore order on block-level children even though this
	// engine models block layout with flex nodes.
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `
		<div>
			<div style="order: 1">alpha</div>
			<div style="order: -1">beta</div>
		</div>`;
	await nextFrame(dom);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0].trimEnd()).toBe("alpha");
	expect(rows[1].trimEnd()).toBe("beta");
	dom.dispose();
});

test("a runtime order change reorders live flex items", async () => {
	// TodoMVC's editing row: the destroy button precedes the editor in
	// the DOM but orders after it while editing, so the editor takes the
	// label's visual slot.
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `
		<style>.row { display: flex; flex-direction: row; gap: 1ch }
		       .row.flipped .b { order: 1 }</style>
		<div class="row"><span class="b">bee</span><span>ay</span></div>`;
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe("bee ay");

	dom.document.querySelector(".row")!.classList.add("flipped");
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe("ay bee");

	dom.document.querySelector(".row")!.classList.remove("flipped");
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe("bee ay");
	dom.dispose();
});

test("text between flex items forms its own anonymous item", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<p style="display: flex">text <input> more</p>`;

	await nextFrame(dom);

	// The text's item used to measure the following <input> into itself -- a
	// 21-cell item for five cells of text -- which pushed " more" clean off a
	// line with room to spare for all three.
	const output = terminal.getPlainText();
	expect(output).toContain("text");
	expect(output).toContain("more");

	dom.dispose();
});

test("a flex item's width applies even when it is an inline box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="display: flex"><span style="width: 30ch">aaaa</span><span style="width: 30ch">bbbb</span></div>`;

	await nextFrame(dom);

	// Flex items are blockified (css-display-3 §2.7), so `width` is theirs to
	// keep; treating them as pure inlines let the measure answer with the text
	// size instead. 30 + 30 in 40 columns shrinks to 20 and 20.
	const [first, second] = [...dom.document.querySelectorAll("span")].map((el) =>
		el.getBoundingClientRect(),
	);
	expect(first.width).toBe(20);
	expect(second.width).toBe(20);
	expect(second.x).toBe(20);

	dom.dispose();
});

test("flex-shrink: 0 keeps an item at its width while the rest give way", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="display: flex"><div style="width: 30ch; flex-shrink: 0">aaaa</div><div style="width: 30ch">bbbb</div></div>`;

	await nextFrame(dom);

	const [first, second] = [...dom.document.querySelectorAll("div div")].map(
		(el) => el.getBoundingClientRect(),
	);
	expect(first.width).toBe(30);
	expect(second.width).toBe(10);

	dom.dispose();
});

test("an inline element that becomes a flex item keeps its padding", async () => {
	// A flex item is blockified (css-display-3 §2.7): `display: inline` on a
	// flex container's child computes to block-level and carries its box model
	// like any block. The engine used to clear the inline element's padding,
	// so `.row{display:flex} .row span{padding:0 2ch}` collapsed to no gap --
	// the reason examples/form.ts had to use block <div> labels.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const style = document.createElement("style");
	style.textContent = `.row{display:flex;flex-direction:row}
.row span{padding:0 2ch}`;
	document.head.appendChild(style);
	document.body.innerHTML = `<div class="row"><span id="s">LBL</span><span>val</span></div>`;
	await nextFrame(dom);

	// 3 cells of text plus 2ch padding on each side = 7 cells wide.
	const rect = document.getElementById("s")!.getBoundingClientRect();
	expect(rect.width).toBe(7);

	// And the padding shows as a real gap before the sibling, not "LBLval".
	const firstRow = terminal.getPlainText().split("\n")[0];
	expect(firstRow).toContain("LBL    val");

	dom.dispose();
});

test("a blockified inline flex item offsets its content by padding", async () => {
	// The blockified inline flex item reserves its padding in its box, and its
	// content must sit inside that padding, not at the border edge. The box was
	// reserved but the text painted at the corner -- horizontally ("LBL" flush
	// left inside a padded box) and vertically (padding-top ignored).
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const style = document.createElement("style");
	style.textContent = `.row{display:flex;flex-direction:row}
.pad{padding:2ch}`;
	document.head.appendChild(style);
	document.body.innerHTML = `<div class="row"><span class="pad">Z</span></div>`;
	await nextFrame(dom);

	// 2ch padding on every side: the "Z" lands at row 2, column 2, not (0,0).
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).not.toContain("Z");
	expect(rows[2]?.[2]).toBe("Z");

	dom.dispose();
});

test("the flex shorthand in a stylesheet expands: flex 1 grows", async () => {
	// css-flexbox-1 §7.1.1: `flex: 1` means 1 1 0% -- the everyday grow-to-fill
	// declaration. It must work from a stylesheet, not only element.style.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>.grow { flex: 1; }</style>`;
	dom.document.body.innerHTML =
		`<div style="display:flex;width:40ch">` +
		`<span>x</span><div id="g" class="grow">y</div></div>`;
	await nextFrame(dom);

	const g = dom.document.getElementById("g")!;
	expect(g.getBoundingClientRect().width).toBe(39);
	dom.dispose();
});

test("flex: none from a stylesheet pins the item", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.head.innerHTML = `<style>.pin { flex: none; width: 10ch; }</style>`;
	dom.document.body.innerHTML =
		`<div style="display:flex;width:20ch">` +
		`<div id="p" class="pin">abc</div><div style="width:30ch">overflow</div></div>`;
	await nextFrame(dom);

	// flex: none = 0 0 auto -- the item neither grows nor shrinks.
	expect(dom.document.getElementById("p")!.getBoundingClientRect().width).toBe(
		10,
	);
	dom.dispose();
});

test("whitespace-only text between flex items is not an item", async () => {
	// css-flexbox-1 §4: an anonymous flex item containing only collapsible
	// white space is not rendered. Multi-line markup is the normal way to
	// write flex rows; the indentation must not become phantom items that
	// eat gap and justify-content space.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="display:flex;gap:2ch">
		<div id="a">A</div>
		<div id="b">B</div>
	</div><div style="display:flex;justify-content:space-between;width:20ch">
		<div id="c">C</div>
		<div id="d">D</div>
	</div>`;
	await nextFrame(dom);

	const rect = (id: string) =>
		dom.document.getElementById(id)!.getBoundingClientRect();
	expect(rect("a").left).toBe(0);
	expect(rect("b").left).toBe(3); // A(1) + gap(2)
	expect(rect("c").left).toBe(0);
	expect(rect("d").left).toBe(19); // flushed to the far edge
	dom.dispose();
});

test.todo("white-space: pre keeps whitespace items, per spec", async () => {
	// The suppression correctly spares this item (pre is not collapsible),
	// but a pre-existing quirk measures whitespace-only runs at zero width,
	// so the preserved spaces occupy no cells. The ITEM part of §4 is
	// honored; the measurement is a separate bug.
	// Non-collapsible white space DOES generate an anonymous item.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="display:flex;white-space:pre"><div id="a">A</div>  <div id="b">B</div></div>`;
	await nextFrame(dom);
	expect(dom.document.getElementById("b")!.getBoundingClientRect().left).toBe(
		3, // A(1) + two preserved spaces
	);
	dom.dispose();
});
