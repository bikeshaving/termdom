/**
 * Comprehensive tests for mouse and keyboard event handling
 */

import { test, expect } from "bun:test";
import { TOMDocument } from '../src/core/TOMDocument.js';
import { TOMContainer } from '../src/elements/TOMContainer.js';
import { TOMButton } from '../src/elements/TOMButton.js';
import { MockTerminal } from '../src/core/TerminalInterface.js';

// Helper to create test document with mock terminal
function createTestDocument() {
  const mockTerminal = new MockTerminal();
  const document = new TOMDocument({ terminal: mockTerminal });
  return { document, mockTerminal };
}

// Helper to create a simple button for testing
function createTestButton(document: TOMDocument, text: string = 'Test Button') {
  const button = document.createElement('button') as TOMButton;
  button.textContent = text;
  button.style = {
    width: '12',
    height: '3',
    'background-color': '#333'
  };
  
  // Position the button at known coordinates for hit testing
  button.bounds = { x: 5, y: 2, width: 12, height: 3 };
  
  return button;
}

test("Mouse handler setup and teardown", () => {
  const { document, mockTerminal } = createTestDocument();
  
  // Check that mouse handler is created
  expect(document.mouseHandler).toBeDefined();
  
  // Enable mouse tracking
  document.mouseHandler.enable();
  
  // Check that mouse tracking escape sequences were sent
  const output = mockTerminal.getOutput();
  expect(output).toContain('\x1b[?1002h'); // Button + drag tracking
  expect(output).toContain('\x1b[?1006h'); // SGR extended mode
  
  // Clear output and disable
  mockTerminal.clearOutput();
  document.mouseHandler.disable();
  
  const disableOutput = mockTerminal.getOutput();
  expect(disableOutput).toContain('\x1b[?1000l'); // Disable basic
  expect(disableOutput).toContain('\x1b[?1002l'); // Disable drag
  expect(disableOutput).toContain('\x1b[?1003l'); // Disable motion
  expect(disableOutput).toContain('\x1b[?1006l'); // Disable SGR
});

test("Mouse click event generation", () => {
  const { document, mockTerminal } = createTestDocument();
  const button = createTestButton(document);
  document.body.appendChild(button);
  
  let clickReceived = false;
  let mouseDownReceived = false;
  let mouseUpReceived = false;
  
  button.addEventListener('mousedown', (e) => {
    mouseDownReceived = true;
    expect(e.clientX).toBe(7); // Middle of button
    expect(e.clientY).toBe(3);
    expect(e.button).toBe(0); // Left button
  });
  
  button.addEventListener('mouseup', (e) => {
    mouseUpReceived = true;
    expect(e.clientX).toBe(7);
    expect(e.clientY).toBe(3);
  });
  
  button.addEventListener('click', (e) => {
    clickReceived = true;
    expect(e.clientX).toBe(7);
    expect(e.clientY).toBe(3);
  });
  
  document.mouseHandler.enable();
  
  // Simulate mouse click at button center (7, 3) - 1-based coords (8, 4)
  const mouseDownSequence = '\x1b[<0;8;4M';
  const mouseUpSequence = '\x1b[<0;8;4m';
  
  // Process mouse down
  const downHandled = document.mouseHandler.handleMouseInput(mouseDownSequence);
  expect(downHandled).toBe(true);
  expect(mouseDownReceived).toBe(true);
  
  // Process mouse up (should generate click)
  const upHandled = document.mouseHandler.handleMouseInput(mouseUpSequence);
  expect(upHandled).toBe(true);
  expect(mouseUpReceived).toBe(true);
  expect(clickReceived).toBe(true);
});

test("Mouse click only fires when mouseup on same element as mousedown", () => {
  const { document, mockTerminal } = createTestDocument();
  
  const button1 = createTestButton(document, 'Button 1');
  button1.bounds = { x: 0, y: 0, width: 10, height: 3 };
  
  const button2 = createTestButton(document, 'Button 2');  
  button2.bounds = { x: 15, y: 0, width: 10, height: 3 };
  
  document.body.appendChild(button1);
  document.body.appendChild(button2);
  
  let button1Clicked = false;
  let button2Clicked = false;
  
  button1.addEventListener('click', () => button1Clicked = true);
  button2.addEventListener('click', () => button2Clicked = true);
  
  document.mouseHandler.enable();
  
  // Mouse down on button1, mouse up on button2 - should not generate click
  document.mouseHandler.handleMouseInput('\x1b[<0;5;2M'); // Down on button1
  document.mouseHandler.handleMouseInput('\x1b[<0;20;2m'); // Up on button2
  
  expect(button1Clicked).toBe(false);
  expect(button2Clicked).toBe(false);
});

test("Mouse hover events", () => {
  const { document, mockTerminal } = createTestDocument();
  const button = createTestButton(document);
  document.body.appendChild(button);
  
  let mouseEntered = false;
  let mouseLeft = false;
  
  button.addEventListener('mouseenter', (e) => {
    mouseEntered = true;
    expect(e.type).toBe('mouseenter');
  });
  
  button.addEventListener('mouseleave', (e) => {
    mouseLeft = true;
    expect(e.type).toBe('mouseleave');
  });
  
  document.mouseHandler.enable();
  
  // Simulate mouse movement - first enable motion tracking manually for test
  mockTerminal.clearOutput();
  process.stdout.write('\x1b[?1003h'); // Enable motion tracking for test
  
  // Move mouse over button
  document.mouseHandler.handleMouseInput('\x1b[<32;8;4M'); // Motion over button
  expect(mouseEntered).toBe(true);
  
  // Move mouse away from button  
  document.mouseHandler.handleMouseInput('\x1b[<32;1;1M'); // Motion away
  expect(mouseLeft).toBe(true);
  
  // Cleanup
  process.stdout.write('\x1b[?1003l');
});

test("Mouse wheel events", () => {
  const { document, mockTerminal } = createTestDocument();
  const container = document.createElement('container') as TOMContainer;
  container.bounds = { x: 0, y: 0, width: 20, height: 10 };
  document.body.appendChild(container);
  
  let wheelReceived = false;
  let wheelDelta = 0;
  
  container.addEventListener('wheel', (e: any) => {
    wheelReceived = true;
    wheelDelta = e.deltaY;
  });
  
  document.mouseHandler.enable();
  
  // Simulate wheel up (button 64 + 0 = 64)
  document.mouseHandler.handleMouseInput('\x1b[<64;10;5M');
  expect(wheelReceived).toBe(true);
  expect(wheelDelta).toBe(-100); // Scroll up
  
  // Reset and test wheel down (button 64 + 1 = 65)
  wheelReceived = false;
  document.mouseHandler.handleMouseInput('\x1b[<65;10;5M');
  expect(wheelReceived).toBe(true);
  expect(wheelDelta).toBe(100); // Scroll down
});

test("Keyboard event parsing", () => {
  const { document, mockTerminal } = createTestDocument();
  const container = document.createElement('container') as TOMContainer;
  document.body.appendChild(container);
  
  const receivedKeys: string[] = [];
  const receivedCtrl: boolean[] = [];
  
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    receivedKeys.push(e.key);
    receivedCtrl.push(e.ctrlKey);
  });
  
  // Set the container as focused element
  document.keyboardHandler.setFocusedElement(container);
  
  // Test various keyboard inputs
  const testCases = [
    { input: 'a', expectedKey: 'a', expectedCtrl: false },
    { input: 'A', expectedKey: 'A', expectedCtrl: false }, 
    { input: '\x03', expectedKey: 'c', expectedCtrl: true }, // Ctrl+C
    { input: '\x1b', expectedKey: 'Escape', expectedCtrl: false },
    { input: '\r', expectedKey: 'Enter', expectedCtrl: false },
    { input: '\x7f', expectedKey: 'Backspace', expectedCtrl: false },
    { input: '\t', expectedKey: 'Tab', expectedCtrl: false },
    { input: '\x1b[A', expectedKey: 'ArrowUp', expectedCtrl: false },
    { input: '\x1b[B', expectedKey: 'ArrowDown', expectedCtrl: false },
    { input: '\x1b[C', expectedKey: 'ArrowRight', expectedCtrl: false },
    { input: '\x1b[D', expectedKey: 'ArrowLeft', expectedCtrl: false }
  ];
  
  // Simulate keyboard input processing
  for (const testCase of testCases) {
    document.keyboardHandler.handleKeyboardInput(testCase.input);
  }
  
  // Verify all keys were received correctly
  expect(receivedKeys.length).toBe(testCases.length);
  for (let i = 0; i < testCases.length; i++) {
    if (receivedKeys[i] !== testCases[i].expectedKey) {
      console.log(`Test case ${i}: expected "${testCases[i].expectedKey}" but got "${receivedKeys[i]}" for input ${JSON.stringify(testCases[i].input)}`);
    }
    expect(receivedKeys[i]).toBe(testCases[i].expectedKey);
    expect(receivedCtrl[i]).toBe(testCases[i].expectedCtrl);
  }
});

test("Focus management with keyboard events", () => {
  const { document, mockTerminal } = createTestDocument();
  
  const button1 = createTestButton(document, 'Button 1');
  const button2 = createTestButton(document, 'Button 2');
  
  document.body.appendChild(button1);
  document.body.appendChild(button2);
  
  let button1Focused = false;
  let button2Focused = false;
  let button1KeyReceived = false;
  
  button1.addEventListener('focus', () => button1Focused = true);
  button2.addEventListener('focus', () => button2Focused = true);
  button1.addEventListener('keydown', () => button1KeyReceived = true);
  
  // Focus button1 (programmatically for now)
  button1.focus();
  expect(button1Focused).toBe(true);
  
  // Set focused element in keyboard handler
  document.keyboardHandler.setFocusedElement(button1);
  
  // Send keyboard input - should go to focused element
  document.keyboardHandler.handleKeyboardInput('a');
  expect(button1KeyReceived).toBe(true);
});

test("Hit testing accuracy", () => {
  const { document, mockTerminal } = createTestDocument();
  
  // Create buttons at different positions
  const topButton = createTestButton(document, 'Top');
  topButton.bounds = { x: 5, y: 1, width: 8, height: 2 };
  
  const bottomButton = createTestButton(document, 'Bottom');
  bottomButton.bounds = { x: 5, y: 5, width: 8, height: 2 };
  
  document.body.appendChild(topButton);
  document.body.appendChild(bottomButton);
  
  let topClicked = false;
  let bottomClicked = false;
  
  topButton.addEventListener('click', () => topClicked = true);
  bottomButton.addEventListener('click', () => bottomClicked = true);
  
  document.mouseHandler.enable();
  
  // Click on top button
  document.mouseHandler.handleMouseInput('\x1b[<0;9;2M'); // Down
  document.mouseHandler.handleMouseInput('\x1b[<0;9;2m'); // Up
  
  expect(topClicked).toBe(true);
  expect(bottomClicked).toBe(false);
  
  // Reset and click on bottom button
  topClicked = false;
  document.mouseHandler.handleMouseInput('\x1b[<0;9;6M'); // Down  
  document.mouseHandler.handleMouseInput('\x1b[<0;9;6m'); // Up
  
  expect(topClicked).toBe(false);
  expect(bottomClicked).toBe(true);
});

test("Terminal resize event handling", () => {
  const { document, mockTerminal } = createTestDocument();
  
  let resizeReceived = false;
  let newColumns = 0;
  let newRows = 0;
  
  document.addEventListener('resize', (e: any) => {
    resizeReceived = true;
    newColumns = e.detail.columns;
    newRows = e.detail.rows;
  });
  
  // Simulate terminal resize
  mockTerminal.setDimensions(100, 30);
  mockTerminal.triggerResize();
  
  expect(resizeReceived).toBe(true);
  expect(newColumns).toBe(100);
  expect(newRows).toBe(30);
});

test("Mouse input parsing edge cases", () => {
  const { document, mockTerminal } = createTestDocument();
  
  // Test malformed input
  const malformedInputs = [
    'regular text',
    '\x1b[invalid',
    '\x1b[<invalidM',
    '\x1b[<0;invalid;5M',
    '\x1b[<0;5;invalidM'
  ];
  
  document.mouseHandler.enable();
  
  for (const input of malformedInputs) {
    const handled = document.mouseHandler.handleMouseInput(input);
    expect(handled).toBe(false);
  }
  
  // Test valid input mixed with text
  const mixedInput = 'some text\x1b[<0;5;5Mmore text';
  const handled = document.mouseHandler.handleMouseInput(mixedInput);
  expect(handled).toBe(true); // Should extract the mouse sequence
});

test("Keyboard input mixed with mouse input", () => {
  const { document, mockTerminal } = createTestDocument();
  const container = document.createElement('container') as TOMContainer;
  document.body.appendChild(container);
  
  let keyReceived = false;
  container.addEventListener('keydown', () => keyReceived = true);
  
  // Set focused element for keyboard events
  document.keyboardHandler.setFocusedElement(container);
  
  document.mouseHandler.enable();
  
  // Send mixed input that includes both keyboard and mouse data
  const mixedInput = 'a\x1b[<0;5;5M';
  
  // First handle potential mouse input
  const mouseHandled = document.mouseHandler.handleMouseInput(mixedInput);
  expect(mouseHandled).toBe(true);
  
  // Then handle keyboard part (would normally be split by input processor)
  document.keyboardHandler.handleKeyboardInput('a');
  expect(keyReceived).toBe(true);
});