// What one terminal cell measures in CSS pixels, per document. Layout
// counts cells; everything a page writes or reads counts CSS pixels. At
// the default unit size the two are the same number.

export interface CellSize {
	width: number;
	height: number;
}

export const UNIT_CELL: Readonly<CellSize> = {width: 1, height: 1};

// Most terminal fonts run about twice as tall as wide.
export const TYPICAL_CELL: Readonly<CellSize> = {width: 8, height: 16};

const sources = new WeakMap<object, () => Readonly<CellSize>>();

export function setCellSizeSource(
	document: object,
	source: () => Readonly<CellSize>,
): void {
	sources.set(document, source);
}

export function getCellSize(node: Node | null | undefined): Readonly<CellSize> {
	if (!node) {
		return UNIT_CELL;
	}
	const document = node.ownerDocument ?? node;
	return sources.get(document)?.() ?? UNIT_CELL;
}

/**
 * CSS pixels along one axis as cells, fractions kept. Layout rounds the
 * edges of the boxes it places, not each length, so lengths that add up
 * still add up.
 */
export function pxToCells(
	px: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	const size = vertical ? cell.height : cell.width;
	return px / size;
}

/** Cells along one axis as CSS pixels. */
export function cellsToPx(
	cells: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	return cells * (vertical ? cell.height : cell.width);
}
