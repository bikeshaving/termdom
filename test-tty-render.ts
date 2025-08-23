#!/usr/bin/env bun

// Test TTYWindow rendering capabilities
import { TTYWindow, MockTTYRuntime } from './src/index.js';

console.log('Testing TTY rendering...');

try {
  // Test with mock runtime
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  console.log('✅ TTYWindow created');
  
  // Test document rendering
  await tty.document.render();
  
  console.log('✅ TTYDocument.render() called successfully');
  
  // Check if mock runtime captured the output
  const output = mockRuntime.getStdoutOutput();
  console.log('📝 Mock runtime captured output:', JSON.stringify(output));
  
  // Clean up
  tty.dispose();
  
  console.log('🎉 TTY rendering test passed!');
  
} catch (error) {
  console.error('❌ TTY rendering test failed:', error);
  process.exit(1);
}