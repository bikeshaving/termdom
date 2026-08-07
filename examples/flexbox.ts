import {TermDOM} from "@b9g/termdom";
const term = new TermDOM();
term.attach();
const {document} = term;

// Create main container with column layout
const mainContainer = document.createElement("div");
mainContainer.style.display = "flex";
mainContainer.style.flexDirection = "column";
mainContainer.style.padding = "1px 2px"; // top, right, bottom, left
mainContainer.style.backgroundColor = "darkblue";
document.body.appendChild(mainContainer);

// Header section
const header = document.createElement("div");
header.style.display = "flex";
header.style.flexDirection = "row";
header.style.justifyContent = "space-between";
header.style.backgroundColor = "magenta";
header.style.padding = "1px 1px 1px 1px";
mainContainer.appendChild(header);

const headerTitle = document.createElement("span");
headerTitle.textContent = "🚀 TermDOM flexbox";
headerTitle.style.color = "white";
header.appendChild(headerTitle);

const headerSubtitle = document.createElement("span");
headerSubtitle.textContent = "HTML · CSS · DOM → cells";
headerSubtitle.style.textAlign = "right";
headerSubtitle.style.color = "white";
header.appendChild(headerSubtitle);

// Content area with horizontal layout
const contentArea = document.createElement("div");
contentArea.style.display = "flex";
contentArea.style.flexDirection = "row";
contentArea.style.padding = "1px 0 0";
mainContainer.appendChild(contentArea);

// Left sidebar
const sidebar = document.createElement("div");
sidebar.style.display = "flex";
sidebar.style.flexDirection = "column";
sidebar.style.backgroundColor = "darkgreen";
sidebar.style.padding = "1px";
sidebar.style.whiteSpace = "nowrap";
sidebar.style.flexShrink = "0"; // Prevent shrinking to preserve content
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
	"Flex rows and columns, gap, grow and shrink -- resolved by a spec flexbox engine and painted to whole cells. Multi-line markup lays out as in a browser: whitespace between items is not an item.";
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
	{title: "🎨 Styling", desc: "One cascade: sheets, inline, var(), :has()"},
	{title: "📐 Layout", desc: "Flex, tables, margin collapsing"},
	{title: "🧩 Widgets", desc: "Inputs and selects as UA shadow trees"},
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
footerText.textContent = "© 2026 TermDOM";
footerText.style.color = "white";
footer.appendChild(footerText);

const footerVersion = document.createElement("span");
footerVersion.textContent = "v0.1.0";
footerVersion.style.color = "white";
footer.appendChild(footerVersion);
