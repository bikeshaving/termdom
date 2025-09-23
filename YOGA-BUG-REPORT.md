# Yoga WASM Bug Report: insertChild() breaks object identity

## Summary
`insertChild()` succeeds but breaks JavaScript object identity relationships in `yoga-layout` 3.2.1. After calling `parent.insertChild(child, 0)`, both `child.getParent() === parent` and `parent.getChild(0) === child` return `false`, even though the operation appears successful.

## Environment
- Package: `yoga-layout@3.2.1`
- Runtime: Node.js v24.4.1, Bun v1.2.21
- Platform: macOS arm64

## Minimal Reproduction

```javascript
import Yoga from 'yoga-layout';

const config = Yoga.Config.create();
const parent = Yoga.Node.createWithConfig(config);
const child = Yoga.Node.createWithConfig(config);

// Call insertChild
parent.insertChild(child, 0);

// BUG: These should be true but are false
console.log('child.getParent() === parent:', child.getParent() === parent);           // ❌ false
console.log('parent.getChild(0) === child:', parent.getChild(0) === child);           // ❌ false

// Evidence insertChild() "worked"
console.log('Parent child count:', parent.getChildCount());                           // ✅ 1
console.log('Child has parent:', !!child.getParent());                               // ✅ true
```

## Expected Behavior
After `parent.insertChild(child, 0)`:
- `child.getParent() === parent` should return `true`
- `parent.getChild(0) === child` should return `true`

## Actual Behavior
- `child.getParent() === parent` returns `false`
- `parent.getChild(0) === child` returns `false`
- `parent.getChildCount()` correctly returns `1`
- `child.getParent()` returns a truthy object (but not the same object reference)

## Analysis
The WASM bindings appear to create phantom/duplicate JavaScript wrapper objects instead of maintaining proper object identity. The underlying layout tree is established correctly (evidenced by correct child counts and layout calculations), but the JavaScript object relationships are broken.

## Impact
This breaks any code that relies on object identity for parent-child relationships, making it impossible to:
- Traverse the tree using object identity
- Implement proper tree manipulation algorithms
- Build higher-level abstractions that depend on consistent parent-child references

## Test Results
Tested on multiple runtimes with identical results:
- ✅ Node.js v24.4.1: Bug reproduces
- ✅ Bun v1.2.21: Bug reproduces
- ✅ Both ESM and CommonJS: Bug reproduces

## Workaround
None found. Object identity is fundamental to tree data structures.

## Root Cause Hypothesis
The WASM bindings likely create new JavaScript wrapper objects for each `getParent()`/`getChild()` call instead of maintaining a consistent object identity mapping between WASM pointers and JavaScript objects.