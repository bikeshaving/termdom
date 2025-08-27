/**
 * Color Rendering Tests
 * 
 * Tests to ensure CSS colors are properly converted to ANSI escape sequences
 * and that background colors render correctly without bleeding.
 */

import { test, expect } from 'bun:test';
import { TermDOM } from '../src/index.js';
import { TestTerminal } from './test-utils.js';

test('foreground colors render correctly', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const colors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white'];
  
  for (const color of colors) {
    const div = document.createElement('div');
    div.textContent = `Text in ${color}`;
    div.style.color = color;
    document.body.appendChild(div);
  }
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Verify ANSI codes are present (either 16-color or 24-bit)
  expect(snapshot).toMatch(/\x1b\[(31|38;2;255;0;0)m/); // red
  expect(snapshot).toMatch(/\x1b\[(32|38;2;0;1\d+;0)m/); // green
  expect(snapshot).toMatch(/\x1b\[(34|38;2;0;0;255)m/); // blue
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('background colors fill full width', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div = document.createElement('div');
  div.textContent = 'Short text';
  div.style.backgroundColor = 'red';
  div.style.display = 'block';
  document.body.appendChild(div);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Background should fill the entire line (80 chars)
  const lines = snapshot.split('\n');
  const coloredLine = lines.find(line => line.includes('Short text'));
  
  // Count the background color codes - should extend beyond text
  expect(coloredLine).toMatch(/\x1b\[(41|48;2;255;0;0)m/); // red background (16-color or 24-bit)
  
  // The line should have spaces with background color filling to width
  const visibleContent = coloredLine?.replace(/\x1b\[[0-9;]*m/g, '') || '';
  expect(visibleContent.length).toBeGreaterThan('Short text'.length);
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('background colors do not bleed between lines', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  // First div with red background
  const div1 = document.createElement('div');
  div1.textContent = 'Red background';
  div1.style.backgroundColor = 'red';
  div1.style.display = 'block';
  document.body.appendChild(div1);
  
  // Second div with green background
  const div2 = document.createElement('div');
  div2.textContent = 'Green background';
  div2.style.backgroundColor = 'green';
  div2.style.display = 'block';
  document.body.appendChild(div2);
  
  // Third div with no background
  const div3 = document.createElement('div');
  div3.textContent = 'No background';
  document.body.appendChild(div3);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  const lines = snapshot.split('\n');
  
  // Each line should end with a reset before newline
  const redLine = lines.find(line => line.includes('Red background'));
  const greenLine = lines.find(line => line.includes('Green background'));
  
  // Lines should end with reset code
  expect(redLine).toMatch(/\x1b\[0m$/);
  expect(greenLine).toMatch(/\x1b\[0m$/);
  
  // No background line should not have any background color codes
  const noBackgroundLine = lines.find(line => line.includes('No background'));
  expect(noBackgroundLine).not.toContain('\x1b[48;');
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('mixed foreground and background colors', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div = document.createElement('div');
  div.textContent = 'Yellow text on blue background';
  div.style.color = 'yellow';
  div.style.backgroundColor = 'blue';
  div.style.display = 'block';
  document.body.appendChild(div);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Should have both foreground and background codes
  expect(snapshot).toMatch(/\x1b\[(33|38;2;255;255;0)m/); // yellow foreground
  expect(snapshot).toMatch(/\x1b\[(44|48;2;0;0;255)m/); // blue background
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('CSS color formats are handled correctly', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  // RGB format
  const div1 = document.createElement('div');
  div1.textContent = 'RGB color';
  div1.style.color = 'rgb(255, 0, 0)';
  document.body.appendChild(div1);
  
  // Hex format
  const div2 = document.createElement('div');
  div2.textContent = 'Hex color';
  div2.style.color = '#00ff00';
  document.body.appendChild(div2);
  
  // Named color
  const div3 = document.createElement('div');
  div3.textContent = 'Named color';
  div3.style.color = 'blue';
  document.body.appendChild(div3);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // All should produce color codes (16-color or 24-bit)
  expect(snapshot).toMatch(/\x1b\[(31|38;2;255;0;0)m/); // rgb(255, 0, 0)
  expect(snapshot).toMatch(/\x1b\[(32|38;2;0;255;0)m/); // #00ff00
  expect(snapshot).toMatch(/\x1b\[(34|38;2;0;0;255)m/); // blue
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('style combinations work correctly', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div = document.createElement('div');
  div.textContent = 'Bold red text on yellow background';
  div.style.color = 'red';
  div.style.backgroundColor = 'yellow';
  div.style.fontWeight = 'bold';
  div.style.display = 'block';
  document.body.appendChild(div);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Should have all three style codes
  expect(snapshot).toContain('\x1b[1m'); // bold
  expect(snapshot).toMatch(/\x1b\[(31|38;2;255;0;0)m/); // red foreground
  expect(snapshot).toMatch(/\x1b\[(43|48;2;255;255;0)m/); // yellow background
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('inline elements do not extend background', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const span = document.createElement('span');
  span.textContent = 'Inline text';
  span.style.backgroundColor = 'green';
  document.body.appendChild(span);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Inline elements should not fill the full width
  const lines = snapshot.split('\n');
  const coloredLine = lines.find(line => line.includes('Inline text'));
  const visibleContent = coloredLine?.replace(/\x1b\[[0-9;]*m/g, '') || '';
  
  // Should only be as wide as the text
  expect(visibleContent.trim()).toBe('Inline text');
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('nested centered elements with decreasing widths', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  // Create container with full width
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.alignItems = 'center';
  container.style.width = '100%';
  container.style.backgroundColor = 'red';
  document.body.appendChild(container);
  
  // First nested element - 60 chars wide
  const div1 = document.createElement('div');
  div1.textContent = 'First level - 60 chars';
  div1.style.width = '60ch';
  div1.style.backgroundColor = 'green';
  div1.style.textAlign = 'center';
  div1.style.display = 'block';
  container.appendChild(div1);
  
  // Second nested element - 40 chars wide
  const div2 = document.createElement('div');
  div2.textContent = 'Second - 40 chars';
  div2.style.width = '40ch';
  div2.style.backgroundColor = 'blue';
  div2.style.textAlign = 'center';
  div2.style.display = 'block';
  container.appendChild(div2);
  
  // Third nested element - 20 chars wide
  const div3 = document.createElement('div');
  div3.textContent = 'Third - 20';
  div3.style.width = '20ch';
  div3.style.backgroundColor = 'yellow';
  div3.style.textAlign = 'center';
  div3.style.display = 'block';
  container.appendChild(div3);
  
  // Fourth nested element - 10 chars wide
  const div4 = document.createElement('div');
  div4.textContent = 'Tiny';
  div4.style.width = '10ch';
  div4.style.backgroundColor = 'magenta';
  div4.style.textAlign = 'center';
  div4.style.display = 'block';
  container.appendChild(div4);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // Verify the structure shows centered elements with different widths
  const lines = snapshot.split('\n').filter(line => line.trim());
  
  // Each line should have different amounts of padding on left/right
  // The red background should show through on the sides
  expect(lines.length).toBeGreaterThanOrEqual(4); // At least 4 divs
  
  // Check that we have different background colors
  expect(snapshot).toMatch(/\x1b\[(41|48;2;255;0;0)m/); // red
  expect(snapshot).toMatch(/\x1b\[(42|48;2;0;1\d+;0)m/); // green
  expect(snapshot).toMatch(/\x1b\[(44|48;2;0;0;255)m/); // blue
  expect(snapshot).toMatch(/\x1b\[(43|48;2;255;255;0)m/); // yellow
  expect(snapshot).toMatch(/\x1b\[(45|48;2;255;0;255)m/); // magenta
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('concentric rectangles with different colors', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  // Create a series of nested divs with decreasing padding
  const outer = document.createElement('div');
  outer.style.backgroundColor = 'red';
  outer.style.padding = '2ch';
  outer.style.display = 'block';
  document.body.appendChild(outer);
  
  const middle1 = document.createElement('div');
  middle1.style.backgroundColor = 'green';
  middle1.style.padding = '2ch';
  outer.appendChild(middle1);
  
  const middle2 = document.createElement('div');
  middle2.style.backgroundColor = 'blue';
  middle2.style.padding = '2ch';
  middle1.appendChild(middle2);
  
  const inner = document.createElement('div');
  inner.textContent = 'Center';
  inner.style.backgroundColor = 'yellow';
  inner.style.padding = '1ch';
  inner.style.textAlign = 'center';
  middle2.appendChild(inner);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  // This should create a pattern like:
  // RRRRRRRRRRRRRRRRRRRRRRRRRRRR...
  // RRGGGGGGGGGGGGGGGGGGGGGGGGGGRR
  // RRGGBBBBBBBBBBBBBBBBBBBBBBBGGRR
  // RRGGBBYYYYYYYYYYYYYYYYYYYBBGGRR
  // RRGGBBBBBBBBBBBBBBBBBBBBBBBGGRR
  // RRGGGGGGGGGGGGGGGGGGGGGGGGGGRR
  // RRRRRRRRRRRRRRRRRRRRRRRRRRRR...
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});