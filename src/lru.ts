/**
 * Every other LRU cache in the JavaScript ecosystem is insane.
 */
export default class LRUCache<TKey, TValue> {
  declare limit: number;
  declare map: Map<TKey, TValue>;

  constructor(limit: number) {
    if (limit <= 0) throw new TypeError("limit must be positive");
    this.limit = limit;
    this.map = new Map();
  }

  get(key: TKey): TValue | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: TKey, val: TValue): void {
    if (this.map.has(key)) {
      this.map.delete(key); // refresh recency
    } else if (this.map.size >= this.limit) {
      // Evict oldest (first inserted)
      const oldestKey = this.map.keys().next().value as TKey;
      this.map.delete(oldestKey);
    }
    this.map.set(key, val);
  }

  has(key: TKey): boolean {
    return this.map.has(key);
  }

  delete(key: TKey): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<TKey> {
    return this.map.keys();
  }

  values(): IterableIterator<TValue> {
    return this.map.values();
  }

  entries(): IterableIterator<[TKey, TValue]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[TKey, TValue]> {
    return this.map[Symbol.iterator]();
  }
}
