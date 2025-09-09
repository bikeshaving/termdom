import { test, expect } from "bun:test";
import { TermDOM } from "../src/termdom.js";

test("enhanced list elements have shadow DOM after connectedCallback", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	// Create list elements
	const ul = document.createElement('ul');
	const ol = document.createElement('ol');
	const li = document.createElement('li');
	
	// Elements should have connectedCallback method after enhancement
	expect(ul.connectedCallback).toBeFunction();
	expect(ol.connectedCallback).toBeFunction();
	expect(li.connectedCallback).toBeFunction();
	
	// Call connectedCallback to set up shadow DOM
	ul.connectedCallback();
	ol.connectedCallback();  
	li.connectedCallback();
	
	// Should now have shadow DOM (accessed via TermDOM's getShadowRoot since they're closed)
	expect(termdom.getShadowRoot(ul)).toBeTruthy();
	expect(termdom.getShadowRoot(ol)).toBeTruthy();
	expect(termdom.getShadowRoot(li)).toBeTruthy();
});

test("UL elements have shadow DOM with slot", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	const ul = document.createElement('ul');
	ul.connectedCallback();
	
	const shadowRoot = termdom.getShadowRoot(ul);
	
	// Should have style and slot elements
	expect(shadowRoot.childNodes.length).toBe(2);
	expect(shadowRoot.querySelector('style')).toBeTruthy();
	expect(shadowRoot.querySelector('slot')).toBeTruthy();
});

test("LI elements have shadow DOM with marker", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	// Create list structure
	const ul = document.createElement('ul');
	const li = document.createElement('li');
	ul.appendChild(li);
	document.body.appendChild(ul);
	
	// Set up shadow DOM
	ul.connectedCallback();
	li.connectedCallback();
	
	const shadowRoot = termdom.getShadowRoot(li);
	
	// Should have style, marker span, and content div with slot
	expect(shadowRoot.childNodes.length).toBe(3);
	expect(shadowRoot.querySelector('style')).toBeTruthy();
	expect(shadowRoot.querySelector('.marker')).toBeTruthy();
	expect(shadowRoot.querySelector('.content')).toBeTruthy();
});

test("list markers are generated correctly", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	// Create UL with LI
	const ul = document.createElement('ul');
	const li1 = document.createElement('li');
	ul.appendChild(li1);
	document.body.appendChild(ul);

	ul.connectedCallback();
	li1.connectedCallback();

	// LI should have bullet marker
	const shadowRoot1 = termdom.getShadowRoot(li1);
	const marker1 = shadowRoot1.querySelector('.marker');
	expect(marker1.textContent).toBe('•');

	// Create OL with LI 
	const ol = document.createElement('ol');
	const li2 = document.createElement('li');
	const li3 = document.createElement('li');
	ol.appendChild(li2);
	ol.appendChild(li3);
	document.body.appendChild(ol);

	ol.connectedCallback();
	li2.connectedCallback();
	li3.connectedCallback();

	// LI should have numbered markers
	const shadowRoot2 = termdom.getShadowRoot(li2);
	const shadowRoot3 = termdom.getShadowRoot(li3);
	const marker2 = shadowRoot2.querySelector('.marker');
	const marker3 = shadowRoot3.querySelector('.marker');
	expect(marker2.textContent).toBe('1.');
	expect(marker3.textContent).toBe('2.');
});

test("ordered list start attribute works", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	const ol = document.createElement('ol');
	ol.setAttribute('start', '5');
	const li1 = document.createElement('li');
	const li2 = document.createElement('li');
	ol.appendChild(li1);
	ol.appendChild(li2);
	document.body.appendChild(ol);

	ol.connectedCallback();
	li1.connectedCallback();
	li2.connectedCallback();

	// Should start from 5
	const shadowRoot1 = termdom.getShadowRoot(li1);
	const shadowRoot2 = termdom.getShadowRoot(li2);
	const marker1 = shadowRoot1.querySelector('.marker');
	const marker2 = shadowRoot2.querySelector('.marker');
	expect(marker1.textContent).toBe('5.');
	expect(marker2.textContent).toBe('6.');
});

test("existing lists can be enhanced manually", () => {
	const termdom = new TermDOM();
	const { document } = termdom;

	// Create existing DOM structure via innerHTML
	document.body.innerHTML = `
		<ul>
			<li>Item 1</li>
			<li>Item 2</li>
		</ul>
		<ol>
			<li>Item A</li>
			<li>Item B</li>
		</ol>
	`;

	// Manually enhance elements created via innerHTML
	const ul = document.querySelector('ul') as any;
	const ol = document.querySelector('ol') as any;
	const lis = document.querySelectorAll('li');

	// Apply enhancement manually (this would normally be done by TermDOM's rendering)
	(termdom as any).upgradeListElements(ul);
	(termdom as any).upgradeListElements(ol);
	lis.forEach(li => (termdom as any).upgradeListElements(li));

	expect(termdom.getShadowRoot(ul)).toBeTruthy();
	expect(termdom.getShadowRoot(ol)).toBeTruthy();
	
	for (const li of lis) {
		expect(termdom.getShadowRoot(li)).toBeTruthy();
	}
});