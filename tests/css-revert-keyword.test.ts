/**
 * Tests for CSS `revert` keyword behavior in JSDOM
 * 
 * This test investigates how JSDOM handles the CSS `revert` keyword,
 * specifically for the text-decoration property.
 */

import { test, expect, describe } from "bun:test";
import { TermDOM } from "../src/index.js";

describe("CSS revert keyword behavior", () => {
    test("JSDOM preserves 'revert' in style.getPropertyValue()", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        const element = document.createElement("div");
        element.style.setProperty("text-decoration", "revert");
        
        // JSDOM should preserve the literal 'revert' value
        expect(element.style.getPropertyValue("text-decoration")).toBe("revert");
        
        dom.dispose();
    });
    
    test("JSDOM does not resolve 'revert' in getComputedStyle()", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        const element = document.createElement("div");
        document.body.appendChild(element);
        element.style.setProperty("text-decoration", "revert");
        
        const computed = document.defaultView!.getComputedStyle(element);
        
        // JSDOM limitation: it returns 'revert' instead of resolving to actual computed value
        expect(computed.getPropertyValue("text-decoration")).toBe("revert");
        
        dom.dispose();
    });
    
    test("JSDOM handles other CSS keywords differently", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        const element = document.createElement("div");
        document.body.appendChild(element);
        
        // Test different CSS keywords
        const keywords = ['initial', 'inherit', 'unset', 'revert'];
        const results: Record<string, { style: string; computed: string }> = {};
        
        keywords.forEach(keyword => {
            element.style.setProperty("text-decoration", keyword);
            
            const styleValue = element.style.getPropertyValue("text-decoration");
            const computed = document.defaultView!.getComputedStyle(element);
            const computedValue = computed.getPropertyValue("text-decoration");
            
            results[keyword] = { style: styleValue, computed: computedValue };
        });
        
        // All keywords are preserved in style
        expect(results.initial.style).toBe("initial");
        expect(results.inherit.style).toBe("inherit");
        expect(results.unset.style).toBe("unset");
        expect(results.revert.style).toBe("revert");
        
        // But computed values differ - only unset gets resolved to empty string
        expect(results.initial.computed).toBe("initial");
        expect(results.inherit.computed).toBe("inherit");
        expect(results.unset.computed).toBe(""); // unset resolves to empty
        expect(results.revert.computed).toBe("revert"); // revert doesn't resolve
        
        dom.dispose();
    });
    
    test("JSDOM doesn't provide default user-agent styles for <a> elements", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        const linkElement = document.createElement("a");
        document.body.appendChild(linkElement);
        
        const computed = document.defaultView!.getComputedStyle(linkElement);
        
        // In a real browser, <a> elements would have text-decoration: underline by default
        // But JSDOM returns empty string, indicating no default styles are applied
        expect(computed.getPropertyValue("text-decoration")).toBe("");
        
        dom.dispose();
    });
    
    test("text-decoration inheritance behavior", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        const parent = document.createElement("div");
        const child = document.createElement("span");
        
        parent.style.setProperty("text-decoration", "underline");
        parent.appendChild(child);
        document.body.appendChild(parent);
        
        const parentComputed = document.defaultView!.getComputedStyle(parent);
        const childComputed = document.defaultView!.getComputedStyle(child);
        
        expect(parentComputed.getPropertyValue("text-decoration")).toBe("underline");
        
        // Test child with inherit keyword
        child.style.setProperty("text-decoration", "inherit");
        const childInheritComputed = document.defaultView!.getComputedStyle(child);
        expect(childInheritComputed.getPropertyValue("text-decoration")).toBe("inherit");
        
        // Test child with revert keyword
        child.style.setProperty("text-decoration", "revert");
        const childRevertComputed = document.defaultView!.getComputedStyle(child);
        expect(childRevertComputed.getPropertyValue("text-decoration")).toBe("revert");
        
        dom.dispose();
    });
    
    test("JSDOM environment characteristics", () => {
        const dom = new TermDOM();
        const { document } = dom;
        
        // Verify we're in JSDOM environment
        expect(document.constructor.name).toBe("Document");
        expect(typeof document.defaultView).toBe("object");
        expect(typeof document.defaultView!.getComputedStyle).toBe("function");
        
        // Test that various HTML elements can be created
        const elements = ['a', 'span', 'div', 'p'];
        elements.forEach(tagName => {
            const element = document.createElement(tagName);
            expect(element.tagName.toLowerCase()).toBe(tagName);
            
            const computed = document.defaultView!.getComputedStyle(element);
            expect(typeof computed.getPropertyValue).toBe("function");
        });
        
        dom.dispose();
    });
});