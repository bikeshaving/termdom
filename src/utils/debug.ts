/**
 * Debug utilities for TOM
 * 
 * Since console.log interferes with terminal rendering,
 * we need alternative debugging methods.
 */

import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

const DEBUG_FILE = join(process.cwd(), 'tom-debug.log');

/**
 * Initialize debug file
 */
export function initDebug() {
  writeFileSync(DEBUG_FILE, `TOM Debug Log - ${new Date().toISOString()}\n\n`);
}

/**
 * Log to debug file instead of console
 */
export function debug(...args: any[]) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');
  
  appendFileSync(DEBUG_FILE, `[${timestamp}] ${message}\n`);
}

/**
 * Log with a category
 */
export function debugCat(category: string, ...args: any[]) {
  debug(`[${category}]`, ...args);
}

/**
 * Create a debug logger for a specific category
 */
export function createDebugger(category: string) {
  return (...args: any[]) => debugCat(category, ...args);
}

/**
 * Debug mouse events specifically
 */
export function debugMouse(event: string, data: any) {
  debugCat('MOUSE', event, data);
}

/**
 * Alternative: Use a separate terminal/tmux pane
 * This writes to stderr which can be redirected
 */
export function debugErr(...args: any[]) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  process.stderr.write(`[DEBUG] ${message}\n`);
}

/**
 * Alternative: Use an overlay debug panel in TOM itself
 */
export class DebugPanel {
  private messages: string[] = [];
  private maxMessages = 10;
  
  log(...args: any[]) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    
    this.messages.push(`[${new Date().toISOString().split('T')[1].slice(0, -5)}] ${message}`);
    
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }
  
  getMessages(): string[] {
    return [...this.messages];
  }
  
  clear() {
    this.messages = [];
  }
}