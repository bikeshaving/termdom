/**
 * Tests for CSSOM integration in TTYOM
 */

import { test, expect } from "bun:test";
import { createTTYWindow } from '../src/index.js';
import { Node } from 'happy-dom';

test("TTYElement should have CSSStyleDeclaration", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  expect(element.style).toBeDefined();
  expect(typeof element.style.setProperty).toBe('function');
  expect(typeof element.style.getPropertyValue).toBe('function');
  expect(typeof element.style.removeProperty).toBe('function');
  
  tty[Symbol.dispose]();
});

test("setProperty and getPropertyValue should work", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  element.style.setProperty('color', 'red');
  element.style.setProperty('background-color', 'blue');
  
  expect(element.style.getPropertyValue('color')).toBe('red');
  expect(element.style.getPropertyValue('background-color')).toBe('blue');
  expect(element.style.getPropertyValue('font-size')).toBe(''); // not set
  
  tty[Symbol.dispose]();
});

test("removeProperty should work", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  element.style.setProperty('color', 'red');
  expect(element.style.getPropertyValue('color')).toBe('red');
  
  const oldValue = element.style.removeProperty('color');
  expect(oldValue).toBe('red');
  expect(element.style.getPropertyValue('color')).toBe('');
  
  tty[Symbol.dispose]();
});

test("window.getComputedStyle should work", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  element.style.setProperty('color', 'red');
  element.style.setProperty('display', 'block');
  tty.document.body.appendChild(element);
  
  const computedStyle = tty.getComputedStyle(element);
  
  expect(computedStyle).toBeDefined();
  expect(typeof computedStyle.getPropertyValue).toBe('function');
  expect(computedStyle.getPropertyValue('color')).toBe('red');
  expect(computedStyle.getPropertyValue('display')).toBe('block');
  
  tty[Symbol.dispose]();
});

test("CSS property names should be kebab-case", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  // Use kebab-case property names
  element.style.setProperty('background-color', 'blue');
  element.style.setProperty('font-weight', 'bold');
  element.style.setProperty('flex-direction', 'column');
  
  expect(element.style.getPropertyValue('background-color')).toBe('blue');
  expect(element.style.getPropertyValue('font-weight')).toBe('bold');
  expect(element.style.getPropertyValue('flex-direction')).toBe('column');
  
  tty[Symbol.dispose]();
});

test("TTY-specific properties should work", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div');
  
  // TTY-specific properties
  element.style.setProperty('--tty-cursor-style', 'block');
  element.style.setProperty('--tty-border-char', '─');
  
  expect(element.style.getPropertyValue('--tty-cursor-style')).toBe('block');
  expect(element.style.getPropertyValue('--tty-border-char')).toBe('─');
  
  tty[Symbol.dispose]();
});

test("style changes should trigger re-render", () => {
  const tty = createTTYWindow();
  const element = tty.document.createElement('div') as any;
  
  let renderCalled = false;
  const originalMarkForRender = element.markForRender;
  element.markForRender = () => {
    renderCalled = true;
    originalMarkForRender?.call(element);
  };
  
  element.style.setProperty('color', 'red');
  
  // Should trigger re-render
  expect(renderCalled).toBe(true);
  
  tty[Symbol.dispose]();
});

test("createElementNS should work with bikeshaving.org namespace", () => {
  const tty = createTTYWindow();
  
  const element = tty.document.createElementNS('https://bikeshaving.org/ttyom', 'custom-element');
  
  expect(element).toBeDefined();
  expect(element.tagName).toBe('CUSTOM-ELEMENT');
  expect(element.style).toBeDefined();
  expect(typeof element.style.setProperty).toBe('function');
  
  tty[Symbol.dispose]();
});

test("standard DOM traversal should work", () => {
  const tty = createTTYWindow();
  const parent = tty.document.createElement('div');
  const child1 = tty.document.createElement('span');
  const child2 = tty.document.createElement('text');
  
  parent.appendChild(child1);
  parent.appendChild(child2);
  
  // Test childNodes (includes all node types)
  expect(parent.childNodes.length).toBe(2);
  expect(parent.childNodes[0]).toBe(child1);
  expect(parent.childNodes[1]).toBe(child2);
  
  // Test children (elements only)
  expect(parent.children.length).toBe(2);
  expect(parent.children[0]).toBe(child1);
  expect(parent.children[1]).toBe(child2);
  
  // Test Node type constants
  expect(child1.nodeType).toBe(Node.ELEMENT_NODE);
  expect(child2.nodeType).toBe(Node.ELEMENT_NODE);
  
  tty[Symbol.dispose]();
});