/**
 * Test Utilities for TTYOM
 * 
 * Shared utilities for creating and comparing terminal snapshots
 */

import { createTTY } from '../src/index.js';
import { MockTTYRuntime } from '../src/runtime/MockTTYRuntime.js';
import { TerminalSnapshotter } from '../src/testing/TerminalSnapshotter.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Create a layout snapshot for testing
 */
export async function createLayoutSnapshot(
  name: string,
  setupFn: (document: Document) => void
): Promise<string> {
  const runtime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime });
  
  // Apply the test setup
  setupFn(document);
  
  // Wait for rendering
  await new Promise(resolve => setTimeout(resolve, 10));
  
  // Close the output stream
  runtime.closeStdout();
  
  // Create snapshotter and get snapshot
  const snapshotter = new TerminalSnapshotter(runtime.getStdoutStream());
  const snapshot = await snapshotter.getSnapshot();
  
  // Cleanup
  dispose();
  
  return snapshot;
}

/**
 * Save a snapshot to a file for visual inspection
 */
export function saveSnapshot(name: string, content: string): void {
  const snapshotsDir = join(process.cwd(), 'tests', 'snapshots');
  if (!existsSync(snapshotsDir)) {
    mkdirSync(snapshotsDir, { recursive: true });
  }
  
  const filename = join(snapshotsDir, `${name}.ansi`);
  writeFileSync(filename, content);
}

/**
 * Create a snapshot with specific terminal dimensions
 */
export async function createSizedSnapshot(
  name: string,
  width: number,
  height: number,
  setupFn: (document: Document) => void
): Promise<string> {
  const runtime = new MockTTYRuntime({ dimensions: { width, height } });
  const { document, dispose } = createTTY({ runtime, width, height });
  
  // Apply the test setup
  setupFn(document);
  
  // Wait for rendering
  await new Promise(resolve => setTimeout(resolve, 10));
  
  // Close the output stream
  runtime.closeStdout();
  
  // Create snapshotter and get snapshot
  const snapshotter = new TerminalSnapshotter(runtime.getStdoutStream());
  const snapshot = await snapshotter.getSnapshot();
  
  // Cleanup
  dispose();
  
  return snapshot;
}

/**
 * Strip ANSI codes from a string for easier testing
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Extract visible text from a snapshot
 */
export function getVisibleText(snapshot: string): string {
  return stripAnsi(snapshot).trim();
}

/**
 * Count occurrences of a specific ANSI code
 */
export function countAnsiCode(snapshot: string, code: string): number {
  return (snapshot.match(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}