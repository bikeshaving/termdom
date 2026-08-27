import type * as E from "../../src/internal/dom.js";
type Bad<A, B> = Extract<keyof A, keyof B>;
declare const documentToLibv: {[K in Bad<E.Document, globalThis.Document>]: E.Document[K] extends globalThis.Document[K] ? never : K}[Bad<E.Document, globalThis.Document>];
export const documentToLib: "SHOW" = documentToLibv;
declare const elementToLibv: {[K in Bad<E.Element, globalThis.Element>]: E.Element[K] extends globalThis.Element[K] ? never : K}[Bad<E.Element, globalThis.Element>];
export const elementToLib: "SHOW" = elementToLibv;
declare const nodeToLibv: {[K in Bad<E.Node, globalThis.Node>]: E.Node[K] extends globalThis.Node[K] ? never : K}[Bad<E.Node, globalThis.Node>];
export const nodeToLib: "SHOW" = nodeToLibv;
