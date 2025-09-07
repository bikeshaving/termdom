import {JSDOM} from "jsdom";
import {inspectElement, inspectDocument, setupInspectMethods} from "../src/inspector.js";

// Create a JSDOM instance
const dom = new JSDOM(`
<!DOCTYPE html>
<html>
<head>
	<title>Inspector Demo</title>
</head>
<body>
	<div id="app" class="container" style="display: flex; flex-direction: column; gap: 10px; padding: 20px;">
		<header style="background-color: blue; color: white; padding: 10px;">
			<h1>DOM Inspector Demo</h1>
		</header>
		
		<nav style="background-color: #333;">
			<ul style="display: flex; list-style: none; gap: 20px; padding: 10px;">
				<li><a href="#home" style="color: white;">Home</a></li>
				<li><a href="#about" style="color: white;">About</a></li>
				<li><a href="#services" style="color: white;">Services</a></li>
				<li><a href="#contact" style="color: white;">Contact</a></li>
			</ul>
		</nav>
		
		<main style="flex: 1; padding: 20px;">
			<article>
				<h2>Welcome to DOM Inspector</h2>
				<p>This demo shows the DOM inspection capabilities.</p>
				<button id="inspect-btn" style="padding: 5px 10px; background: green; color: white;">
					Click to Inspect
				</button>
			</article>
		</main>
		
		<footer style="background-color: #666; color: white; padding: 10px; text-align: center;">
			© 2024 DOM Inspector
		</footer>
	</div>
</body>
</html>
`);

// Setup inspect methods for util.inspect integration
setupInspectMethods(dom.window);

const {document} = dom.window;

console.log("\n=== DOM INSPECTOR DEMO ===\n");

// Get elements
const header = document.querySelector("header");
const button = document.getElementById("inspect-btn");
const nav = document.querySelector("nav");
const app = document.getElementById("app");
const main = document.querySelector("main");

// 1. Basic element inspection (no colors for clarity)
console.log("1️⃣  Basic Element Inspection (no styles):");
console.log(inspectElement(header!, { colorize: false, maxDepth: 1 }));

// 2. With ANSI colors
console.log("\n2️⃣  With ANSI Colors:");
console.log(inspectElement(header!, { colorize: true, maxDepth: 1 }));

// 3. Showing style attributes
console.log("\n3️⃣  Showing Style Attributes:");
console.log(inspectElement(button!, { colorize: true, showStyles: true }));

// 4. Compact mode
console.log("\n4️⃣  Compact Mode:");
console.log(inspectElement(nav!, { colorize: true, compact: true }));

// 5. Deep inspection
console.log("\n5️⃣  Deep Inspection (maxDepth: 3):");
console.log(inspectElement(app!, { colorize: true, maxDepth: 3, showStyles: false }));

// 6. Show all attributes
console.log("\n6️⃣  Show All Attributes:");
const link = document.querySelector("a");
link?.setAttribute("data-page", "home");
link?.setAttribute("aria-current", "page");
console.log(inspectElement(link!, { colorize: true, showAll: true }));

// 7. Document inspection
console.log("\n7️⃣  Document Inspection:");
console.log(inspectDocument(document, { colorize: true, maxDepth: 2 }));

// 8. Using Node.js util.inspect
const util = require("util");
console.log("\n8️⃣  Node.js util.inspect Integration:");
console.log(util.inspect(main, { colors: true, depth: 2 }));

console.log("\n💡 The inspector provides pure functions that work with any JSDOM instance!");
console.log("💡 Use inspectElement(), inspectDocument(), or inspectNode() directly.");