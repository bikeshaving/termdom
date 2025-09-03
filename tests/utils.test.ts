import {test, expect} from "bun:test";
import LRUCache from "../src/utils.js";

test("LRU cache basic functionality", () => {
	const cache = new LRUCache<string, number>(3);
	
	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3);
	
	expect(cache.get("a")).toBe(1);
	expect(cache.get("b")).toBe(2);
	expect(cache.get("c")).toBe(3);
});

test("LRU cache eviction", () => {
	const cache = new LRUCache<string, number>(2);
	
	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3); // Should evict "a"
	
	expect(cache.get("a")).toBeUndefined();
	expect(cache.get("b")).toBe(2);
	expect(cache.get("c")).toBe(3);
});

test("LRU cache recency update", () => {
	const cache = new LRUCache<string, number>(2);
	
	cache.set("a", 1);
	cache.set("b", 2);
	cache.get("a"); // Update recency of "a"
	cache.set("c", 3); // Should evict "b" since "a" was accessed recently
	
	expect(cache.get("a")).toBe(1);
	expect(cache.get("b")).toBeUndefined();
	expect(cache.get("c")).toBe(3);
});