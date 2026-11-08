// Each name becomes a boolean on `prototype`'s objects, held as one bit of
// their `flags`, in the order given. Every mask stays below 1 << 30, so
// `flags` is a small integer V8 keeps in the object, never a heap number.
export function defineFlags(prototype: object, names: readonly string[]): void {
	for (let bit = 0; bit < names.length; bit++) {
		Object.defineProperty(prototype, names[bit], getFlagAccessor(1 << bit));
	}
}

// The accessor is a property's definition, so it is a function of its own
// for each bit.
function getFlagAccessor(mask: number): PropertyDescriptor {
	return {
		get(this: {flags: number}): boolean {
			return (this.flags & mask) !== 0;
		},
		set(this: {flags: number}, on: boolean): void {
			this.flags = on ? this.flags | mask : this.flags & ~mask;
		},
		configurable: true,
	};
}
