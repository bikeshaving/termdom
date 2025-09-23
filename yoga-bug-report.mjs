// YOGA WASM BUG: insertChild() breaks object identity
// 
// Expected: child.getParent() === parent after insertChild()
// Actual: child.getParent() !== parent (returns phantom object)

import Yoga from 'yoga-layout';

const config = Yoga.Config.create();
const parent = Yoga.Node.createWithConfig(config);
const child = Yoga.Node.createWithConfig(config);

parent.insertChild(child, 0);

console.log('insertChild() succeeded:', parent.getChildCount() === 1);
console.log('child.getParent() === parent:', child.getParent() === parent); // BUG: returns false
console.log('parent.getChild(0) === child:', parent.getChild(0) === child); // BUG: returns false

// This breaks any code that relies on object identity for parent-child relationships