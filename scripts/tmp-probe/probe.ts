import type * as E from "../../src/internal/dom.js";
declare const documentToLibv: {[K in Extract<keyof E.Document, keyof globalThis.Document>]: E.Document[K] extends globalThis.Document[K] ? never : K}[Extract<keyof E.Document, keyof globalThis.Document>];
export const documentToLib: "SHOW" = documentToLibv;
declare const elementToLibv: {[K in Extract<keyof E.Element, keyof globalThis.Element>]: E.Element[K] extends globalThis.Element[K] ? never : K}[Extract<keyof E.Element, keyof globalThis.Element>];
export const elementToLib: "SHOW" = elementToLibv;
declare const nodeToLibv: {[K in Extract<keyof E.Node, keyof globalThis.Node>]: E.Node[K] extends globalThis.Node[K] ? never : K}[Extract<keyof E.Node, keyof globalThis.Node>];
export const nodeToLib: "SHOW" = nodeToLibv;
declare const el: E.Element;
export const assign: globalThis.Element = el;
