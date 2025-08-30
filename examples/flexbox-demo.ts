/**
 * Flexbox Layout Demo - Showcasing TOM's flexbox capabilities
 *
 * This demo creates a sophisticated layout with multiple containers,
 * demonstrating various flexbox properties and nested layouts.
 */

import {TermDOM} from "../src/index.js";

async function flexboxDemo() {
	//console.log('🎯 Starting TTY Flexbox Layout Demo...\n');

	// Create TTY document

	const dom = new TermDOM();
	const {document} = dom;

	// Create main container with column layout
	const mainContainer = document.createElement("div");
	mainContainer.style.display = "flex";
	mainContainer.style.flexDirection = "column";
	mainContainer.style.padding = "1px 2px 1px 2px"; // top, right, bottom, left
	mainContainer.style.backgroundColor = "darkblue";
	document.body.appendChild(mainContainer);

	// Header section
	const header = document.createElement("div");
	header.style.display = "flex";
	header.style.flexDirection = "row";
	header.style.backgroundColor = "magenta";
	header.style.padding = "1px 1px 1px 1px";
	mainContainer.appendChild(header);

	const headerTitle = document.createElement("span");
	headerTitle.textContent = "🚀 TTY Flexbox Demo";
	headerTitle.style.textAlign = "center";
	headerTitle.style.color = "white";
	header.appendChild(headerTitle);

	const headerSubtitle = document.createElement("span");
	headerSubtitle.textContent = "Terminal Object Model";
	headerSubtitle.style.textAlign = "right";
	headerSubtitle.style.color = "white";
	header.appendChild(headerSubtitle);

	// Content area with horizontal layout
	const contentArea = document.createElement("div");
	contentArea.style.display = "flex";
	contentArea.style.flexDirection = "row";
	contentArea.style.padding = "1px 0px 0px 0px";
	mainContainer.appendChild(contentArea);

	// Left sidebar
	const sidebar = document.createElement("div");
	sidebar.style.display = "flex";
	sidebar.style.flexDirection = "column";
	sidebar.style.backgroundColor = "darkgreen";
	sidebar.style.padding = "1px 1px 1px 1px";
	contentArea.appendChild(sidebar);

	const sidebarTitle = document.createElement("span");
	sidebarTitle.textContent = "📋 Navigation";
	sidebarTitle.style.color = "white";
	sidebarTitle.style.textAlign = "center";
	sidebar.appendChild(sidebarTitle);

	const menuItems = ["• Home", "• About", "• Services", "• Contact"];
	for (const item of menuItems) {
		const menuItem = document.createElement("span");
		menuItem.textContent = item;
		menuItem.style.color = "white";
		menuItem.style.padding = "0px 1px 0px 1px";
		sidebar.appendChild(menuItem);
	}

	// Main content area
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
	contentText.style.padding = "1px 0px 1px 0px";
	mainContent.appendChild(contentText);

	// Feature showcase area
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
		featureCard.style.flex = "1"; // Make cards flexible to share available width equally
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

	// Footer with reverse row layout
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

	// Trigger layout calculation
	document.body.getBoundingClientRect();

	// Log layout structure
	//console.log('📐 Layout Structure:');
	//console.log('├── Main Container (column)');
	//console.log('│   ├── Header (row)');
	//console.log('│   │   ├── Title + Subtitle');
	//console.log('│   ├── Content Area (row)');
	//console.log('│   │   ├── Sidebar (column)');
	//console.log('│   │   │   ├── Navigation items');
	//console.log('│   │   ├── Main Content (column)');
	//console.log('│   │   │   ├── Features (row)');
	//console.log('│   │   │   │   ├── Feature cards (column)');
	//console.log('│   ├── Footer (row-reverse)');
	//console.log('');
	//
	// Layout renders automatically via MutationObserver!
	//console.log('🎨 Flexbox layout rendered automatically!\n');
	//
	//console.log('\n✨ Flexbox demo complete!');
	//console.log('🔍 Notice how elements are automatically positioned using flexbox rules:');
	//console.log('   • Column layout stacks vertically');
	//console.log('   • Row layout arranges horizontally');
	//console.log('   • Row-reverse layout arranges horizontally in reverse order');
	//console.log('   • Nested containers create complex layouts');

	// Clean up
	dom.dispose();
}

flexboxDemo();
