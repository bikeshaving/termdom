/**
 * Snapshot Testing Utilities for TTYOM
 * 
 * Generates human-viewable .ansi snapshot files from TTY rendering output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TerminalEmulator } from './TerminalEmulator.js';
import { MockTTYRuntime } from '../runtime/MockTTYRuntime.js';

export interface SnapshotOptions {
  width?: number;
  height?: number;
  updateSnapshots?: boolean; // For updating snapshots (like Jest's -u flag)
}

/**
 * Generate a snapshot from MockTTYRuntime output
 */
export function generateSnapshot(
  mockRuntime: MockTTYRuntime,
  options: SnapshotOptions = {}
): string {
  const emulator = new TerminalEmulator(
    options.width || 80,
    options.height || 24
  );
  
  const ansiOutput = mockRuntime.getStdoutOutput();
  emulator.processAnsiOutput(ansiOutput);
  
  return emulator.generateStaticAnsi();
}

/**
 * Save snapshot to .ansi file
 */
export function saveSnapshot(
  snapshotName: string,
  content: string,
  snapshotDir: string = 'tests/snapshots'
): void {
  const snapshotPath = path.join(snapshotDir, `${snapshotName}.ansi`);
  
  // Ensure snapshot directory exists
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  
  // Save with newline at end for better file handling
  fs.writeFileSync(snapshotPath, content + '\n');
}

/**
 * Load existing snapshot
 */
export function loadSnapshot(
  snapshotName: string,
  snapshotDir: string = 'tests/snapshots'
): string | null {
  const snapshotPath = path.join(snapshotDir, `${snapshotName}.ansi`);
  
  try {
    return fs.readFileSync(snapshotPath, 'utf8').trimEnd();
  } catch (error) {
    return null;
  }
}

/**
 * Compare snapshot with expected content
 */
export function compareSnapshot(
  snapshotName: string,
  actualContent: string,
  options: SnapshotOptions = {}
): { matches: boolean; expectedPath?: string } {
  const existing = loadSnapshot(snapshotName);
  
  if (existing === null) {
    // No existing snapshot
    if (options.updateSnapshots) {
      saveSnapshot(snapshotName, actualContent);
      return { matches: true };
    } else {
      throw new Error(
        `Snapshot ${snapshotName}.ansi does not exist. ` +
        `Run with updateSnapshots: true to create it.`
      );
    }
  }
  
  if (existing !== actualContent) {
    if (options.updateSnapshots) {
      saveSnapshot(snapshotName, actualContent);
      return { matches: true };
    } else {
      return { 
        matches: false, 
        expectedPath: path.join('tests/snapshots', `${snapshotName}.ansi`)
      };
    }
  }
  
  return { matches: true };
}

/**
 * Convenient test helper for snapshot testing
 */
export function expectSnapshot(
  snapshotName: string,
  mockRuntime: MockTTYRuntime,
  options: SnapshotOptions = {}
): void {
  const actualContent = generateSnapshot(mockRuntime, options);
  const result = compareSnapshot(snapshotName, actualContent, options);
  
  if (!result.matches) {
    throw new Error(
      `Snapshot ${snapshotName} does not match.\n` +
      `View expected: cat ${result.expectedPath}\n` +
      `Actual content:\n${actualContent}`
    );
  }
}