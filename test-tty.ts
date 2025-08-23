#!/usr/bin/env bun

// Quick test to see if TTYWindow works
import { TTYWindow, MockTTYRuntime } from './src/index.js';

console.log('Testing TTYWindow...');

try {
  // Test with mock runtime
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  console.log('✅ TTYWindow created successfully with MockTTYRuntime');
  console.log('Window dimensions:', tty.innerWidth, 'x', tty.innerHeight);
  
  // Test auto-detection (should work in Bun)
  try {
    const autoTty = new TTYWindow();
    console.log('✅ TTYWindow auto-detection works');
    console.log('Auto-detected dimensions:', autoTty.innerWidth, 'x', autoTty.innerHeight);
    
    // Clean up
    autoTty.dispose();
  } catch (autoError) {
    console.log('❌ Auto-detection failed:', autoError.message);
  }
  
  // Clean up
  tty.dispose();
  
} catch (error) {
  console.error('❌ TTYWindow test failed:', error);
  process.exit(1);
}

console.log('🎉 TTYWindow basic functionality test passed!');