/**
 * List Elements with Shadow DOM
 * 
 * Extends the actual built-in HTMLULElement, HTMLOLElement, and HTMLLIElement
 * classes with Shadow DOM support for encapsulated list marker rendering.
 */

/**
 * Register list element extensions with Shadow DOM support
 */
export function registerListElements(window: any) {
	const HTMLElement = window.HTMLElement;
	
	// Extend UL prototype with Shadow DOM
	const originalULConstructor = window.HTMLUListElement || HTMLElement;
	if (!originalULConstructor.prototype._termdomEnhanced) {
		const originalConnectedCallback = originalULConstructor.prototype.connectedCallback;
		
		originalULConstructor.prototype.connectedCallback = function() {
			if (!this.shadowRoot) {
				const shadowRoot = this.attachShadow({ mode: 'closed' });
				
				// Create shadow DOM structure
				const style = window.document.createElement('style');
				style.textContent = `
					:host {
						display: block;
						padding-left: 2ch;
						margin: 0;
						list-style: none;
					}
				`;
				
				const slot = window.document.createElement('slot');
				
				shadowRoot.appendChild(style);
				shadowRoot.appendChild(slot);
			}
			
			if (originalConnectedCallback) {
				originalConnectedCallback.call(this);
			}
		};
		
		originalULConstructor.prototype._termdomEnhanced = true;
	}
	
	// Extend OL prototype with Shadow DOM
	const originalOLConstructor = window.HTMLOListElement || HTMLElement;
	if (!originalOLConstructor.prototype._termdomEnhanced) {
		const originalConnectedCallback = originalOLConstructor.prototype.connectedCallback;
		
		originalOLConstructor.prototype.connectedCallback = function() {
			if (!this.shadowRoot) {
				const shadowRoot = this.attachShadow({ mode: 'closed' });
				
				// Create shadow DOM structure with dynamic padding
				const style = window.document.createElement('style');
				
				// Calculate padding based on list length and start value
				const items = Array.from(this.children).filter((child: Element) => child.tagName === 'LI');
				const start = parseInt(this.getAttribute('start') || '1', 10);
				const maxNumber = start + items.length - 1;
				const markerWidth = maxNumber.toString().length + 1;
				
				style.textContent = `
					:host {
						display: block;
						padding-left: ${markerWidth}ch;
						margin: 0;
						list-style: none;
					}
				`;
				
				const slot = window.document.createElement('slot');
				
				shadowRoot.appendChild(style);
				shadowRoot.appendChild(slot);
			}
			
			if (originalConnectedCallback) {
				originalConnectedCallback.call(this);
			}
		};
		
		originalOLConstructor.prototype._termdomEnhanced = true;
	}
	
	// Extend LI prototype with Shadow DOM for markers
	const originalLIConstructor = window.HTMLLIElement || HTMLElement;
	if (!originalLIConstructor.prototype._termdomEnhanced) {
		const originalConnectedCallback = originalLIConstructor.prototype.connectedCallback;
		
		originalLIConstructor.prototype.connectedCallback = function() {
			if (!this.shadowRoot) {
				const shadowRoot = this.attachShadow({ mode: 'closed' });
				
				// Create shadow DOM structure with marker
				const style = window.document.createElement('style');
				style.textContent = `
					:host {
						display: block;
						position: relative;
					}
					
					.marker {
						position: absolute;
						left: -2ch;
						top: 0;
						width: 2ch;
						text-align: right;
					}
					
					.content {
						display: block;
					}
				`;
				
				// Create marker element
				const markerElement = window.document.createElement('span');
				markerElement.className = 'marker';
				
				// Generate marker content
				const parentList = this.parentElement;
				if (parentList) {
					if (parentList.tagName === 'UL') {
						markerElement.textContent = '•';
					} else if (parentList.tagName === 'OL') {
						const items = Array.from(parentList.children).filter((child: Element) => child.tagName === 'LI');
						const index = items.indexOf(this);
						if (index !== -1) {
							const start = parseInt(parentList.getAttribute('start') || '1', 10);
							const itemNumber = start + index;
							markerElement.textContent = `${itemNumber}.`;
							
							// Adjust positioning for ordered lists
							const maxNumber = start + items.length - 1;
							const markerWidth = maxNumber.toString().length + 1;
							markerElement.style.left = `-${markerWidth}ch`;
							markerElement.style.width = `${markerWidth}ch`;
						}
					}
				}
				
				// Create content wrapper with slot
				const contentWrapper = window.document.createElement('div');
				contentWrapper.className = 'content';
				const slot = window.document.createElement('slot');
				contentWrapper.appendChild(slot);
				
				// Add to shadow DOM
				shadowRoot.appendChild(style);
				shadowRoot.appendChild(markerElement);
				shadowRoot.appendChild(contentWrapper);
			}
			
			if (originalConnectedCallback) {
				originalConnectedCallback.call(this);
			}
		};
		
		originalLIConstructor.prototype._termdomEnhanced = true;
	}
	
	// Function to enhance a single list element
	function enhanceListElement(element: any) {
		if (element.tagName === 'UL' && !element.shadowRoot) {
			// Apply UL prototype methods
			element.connectedCallback = originalULConstructor.prototype.connectedCallback;
			element.connectedCallback();
		} else if (element.tagName === 'OL' && !element.shadowRoot) {
			// Apply OL prototype methods
			element.connectedCallback = originalOLConstructor.prototype.connectedCallback;
			element.connectedCallback();
		} else if (element.tagName === 'LI' && !element.shadowRoot) {
			// Apply LI prototype methods
			element.connectedCallback = originalLIConstructor.prototype.connectedCallback;
			element.connectedCallback();
		}
	}
	
	// Enhance any existing list elements
	window.document.querySelectorAll('ul, ol, li').forEach(enhanceListElement);
	
	// Return the enhancement function for manual use
	return { enhanceListElement };
}