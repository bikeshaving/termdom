/**
 * What one terminal cell measures in CSS pixels, per document. Layout
 * counts cells; everything a page writes or reads counts CSS pixels. At
 * the default unit size the two are the same number.
 */
import {getCellPixels, getCellSizeSetting} from "./tree.ts";

export interface CellSize {
	width: number;
	height: number;
}

export const UNIT_CELL: Readonly<CellSize> = {width: 1, height: 1};

/**
 * How the page's lengths map to cells: one CSS pixel a cell, the
 * terminal's pixels once it reports them, or a size the program gives.
 */
export type CellSizeSetting = "unit" | "auto" | Readonly<CellSize>;

export function getCellSize(node: Node | null | undefined): Readonly<CellSize> {
	const setting = node ? getCellSizeSetting(node) : undefined;
	if (setting === undefined || setting === "unit") {
		return UNIT_CELL;
	}
	return setting === "auto" ? getCellPixels(node!)! : setting;
}

/**
 * The cell an image's pixels divide by. An image's pixels are CSS
 * pixels, so this is the page's cell. Under the unit cell that would be
 * a cell per pixel, so the screen's cell stands in. A document no TermDOM
 * draws has no screen, and draws no image.
 */
export function getImageCellSize(
	node: Node | null | undefined,
): Readonly<CellSize> {
	const page = getCellSize(node);
	if (page !== UNIT_CELL) {
		return page;
	}
	return (node && getCellPixels(node)) ?? page;
}

/**
 * CSS pixels along one axis as cells, fractions kept. Layout rounds the
 * edges of the boxes it places, not each length, so lengths that add up
 * still add up.
 */
export function cellsFromPx(
	px: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	const size = vertical ? cell.height : cell.width;
	return px / size;
}

/** Cells along one axis as CSS pixels. */
export function pxFromCells(
	cells: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	return cells * (vertical ? cell.height : cell.width);
}
