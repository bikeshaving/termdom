# insertChild() breaks object identity in JavaScript bindings

## Summary

After calling `parent.insertChild(child, 0)`, both `child.getParent() === parent` and `parent.getChild(0) === child` return `false`, even though the operation appears successful.

## Environment

- Package: yoga-layout@3.2.1
- Runtime: Node.js v24.4.1, Bun v1.2.21
- Platform: macOS arm64

## Reproduction

```javascript
import Yoga from 'yoga-layout';

const config = Yoga.Config.create();
const parent = Yoga.Node.createWithConfig(config);
const child = Yoga.Node.createWithConfig(config);

parent.insertChild(child, 0);

console.log('child.getParent() === parent:', child.getParent() === parent);   // false
console.log('parent.getChild(0) === child:', parent.getChild(0) === child);   // false
console.log('Parent child count:', parent.getChildCount());                   // 1
```

## Expected Behavior

After `insertChild()`:
- `child.getParent() === parent` should return `true`
- `parent.getChild(0) === child` should return `true`

## Actual Behavior

- `child.getParent() === parent` returns `false`
- `parent.getChild(0) === child` returns `false`
- `parent.getChildCount()` correctly returns `1`
- `child.getParent()` returns a truthy object but not the same reference

## Impact

This breaks any code that relies on object identity for tree traversal or manipulation. Layout calculations work correctly, but tree structure algorithms fail.

## Analysis

The WASM bindings appear to create new JavaScript wrapper objects for each `getParent()`/`getChild()` call instead of maintaining consistent object identity mapping.