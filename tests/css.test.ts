/**
 * Unit tests for Terminal CSS Resolution
 */

import { test, expect } from "bun:test";
import { JSDOM } from "jsdom";
import { getResolvedStyle, isInheritedProperty, getTerminalElementDefaults } from "../src/css.js";

// Helper to create a clean DOM for each test
function createDOM() {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body></body></html>`);
  return { dom, document: dom.window.document, window: dom.window };
}

test("getResolvedStyle returns inline style values", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  
  div.style.marginLeft = "10ch";
  div.style.backgroundColor = "red";
  
  expect(getResolvedStyle(div, "margin-left")).toBe("10ch");
  expect(getResolvedStyle(div, "background-color")).toBe("red");
});

test("getResolvedStyle preserves semantic units", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  
  div.style.width = "50%";
  div.style.fontSize = "2em";
  div.style.height = "10ch";
  
  expect(getResolvedStyle(div, "width")).toBe("50%");
  expect(getResolvedStyle(div, "font-size")).toBe("2em");
  expect(getResolvedStyle(div, "height")).toBe("10ch");
});

test("getResolvedStyle handles 'inherit' keyword for visual properties", () => {
  const { document } = createDOM();
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  parent.style.color = "blue";
  parent.appendChild(child);
  
  child.style.color = "inherit";
  
  expect(getResolvedStyle(child, "color")).toBe("blue");
});

test("getResolvedStyle resolves layout property keywords to defaults", () => {
  const { document } = createDOM();
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  parent.style.marginLeft = "20px";
  parent.appendChild(child);
  
  // Layout properties ignore inheritance and resolve to defaults
  child.style.marginLeft = "inherit";
  child.style.display = "initial"; 
  child.style.padding = "unset";
  
  expect(getResolvedStyle(child, "margin-left")).toBe("0"); // Terminal default
  expect(getResolvedStyle(child, "display")).toBe("block"); // Div default 
  expect(getResolvedStyle(child, "padding")).toBe("0"); // Terminal default
});

test("getResolvedStyle handles 'initial' keyword for visual properties", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  
  div.style.color = "initial";
  div.style.backgroundColor = "initial";
  
  expect(getResolvedStyle(div, "color")).toBe("#000000");  // CSS spec default
  expect(getResolvedStyle(div, "background-color")).toBe("transparent");  // CSS spec default
});

test("getResolvedStyle handles 'unset' keyword for visual properties", () => {
  const { document } = createDOM();
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  parent.style.color = "green";        // Inherited property
  parent.style.backgroundColor = "red"; // Non-inherited property  
  parent.appendChild(child);
  
  child.style.color = "unset";           // Should inherit (color inherits)
  child.style.backgroundColor = "unset"; // Should be initial (background-color doesn't inherit)
  
  expect(getResolvedStyle(child, "color")).toBe("green");  // Inherited
  expect(getResolvedStyle(child, "background-color")).toBe("transparent"); // Initial (CSS spec default)
});

test("getResolvedStyle applies automatic inheritance", () => {
  const { document } = createDOM();
  const grandparent = document.createElement("div");
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  grandparent.style.color = "purple";
  grandparent.style.fontWeight = "bold";
  
  grandparent.appendChild(parent);
  parent.appendChild(child);
  
  // Child should inherit color and font-weight (inherited properties)
  // but not margin-left (non-inherited property)
  expect(getResolvedStyle(child, "color")).toBe("purple");
  expect(getResolvedStyle(child, "font-weight")).toBe("bold");
  expect(getResolvedStyle(child, "margin-left")).toBe("0"); // Terminal default, not inherited
});

test("getResolvedStyle uses element-specific defaults", () => {
  const { document } = createDOM();
  
  const div = document.createElement("div");
  const button = document.createElement("button");
  const span = document.createElement("span");
  const pre = document.createElement("pre");
  
  expect(getResolvedStyle(div, "display")).toBe("block");
  expect(getResolvedStyle(button, "display")).toBe("inline-block");
  expect(getResolvedStyle(button, "border")).toBe("1px solid");
  expect(getResolvedStyle(span, "display")).toBe("inline");
  expect(getResolvedStyle(pre, "white-space")).toBe("pre");
});

test("getResolvedStyle falls back to CSS spec defaults", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  
  // Properties not in terminal defaults should use CSS spec defaults
  expect(getResolvedStyle(div, "position")).toBe("static");
  expect(getResolvedStyle(div, "overflow")).toBe("visible");
  expect(getResolvedStyle(div, "font-weight")).toBe("normal");
});

test("inheritance works through multiple levels", () => {
  const { document } = createDOM();
  const level1 = document.createElement("div");
  const level2 = document.createElement("div");  
  const level3 = document.createElement("div");
  
  level1.style.color = "orange";
  level1.appendChild(level2);
  level2.appendChild(level3);
  
  expect(getResolvedStyle(level3, "color")).toBe("orange");
});

test("inheritance stops at root when no parent", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  
  div.style.color = "inherit"; // No parent, should get initial
  
  expect(getResolvedStyle(div, "color")).toBe("#000000"); // CSS spec default
});

test("isInheritedProperty correctly identifies inherited properties", () => {
  expect(isInheritedProperty("color")).toBe(true);
  expect(isInheritedProperty("font-size")).toBe(true);
  expect(isInheritedProperty("text-align")).toBe(true);
  
  expect(isInheritedProperty("margin")).toBe(false);
  expect(isInheritedProperty("padding")).toBe(false);
  expect(isInheritedProperty("border")).toBe(false);
  expect(isInheritedProperty("display")).toBe(false);
});

test("terminal defaults override CSS spec defaults", () => {
  const { document } = createDOM();
  const div = document.createElement("div");
  const ul = document.createElement("ul");
  
  // CSS spec says margin: 0 for div, but our terminal defaults also say 0
  expect(getResolvedStyle(div, "margin")).toBe("0");
  
  // CSS spec says no padding-left for ul, but our terminal defaults add some  
  expect(getResolvedStyle(ul, "padding-left")).toBe("2ch");
});

test("inline styles override defaults and inheritance", () => {
  const { document } = createDOM();
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  parent.style.color = "red";
  parent.appendChild(child);
  
  child.style.color = "blue"; // Override inherited color
  
  expect(getResolvedStyle(child, "color")).toBe("blue"); // Inline wins
});

test("empty string properties are treated as unset", () => {
  const { document } = createDOM();
  const parent = document.createElement("div");
  const child = document.createElement("div");
  
  parent.style.color = "yellow";
  parent.appendChild(child);
  
  child.style.color = ""; // Empty string, should inherit
  
  expect(getResolvedStyle(child, "color")).toBe("yellow");
});

test("getTerminalElementDefaults exports defaults for inspection", () => {
  const defaults = getTerminalElementDefaults();
  
  expect(defaults.div.display).toBe("block");
  expect(defaults.button.display).toBe("inline-block");
  expect(defaults["*"].margin).toBe("0");
  expect(defaults.pre["white-space"]).toBe("pre");
});