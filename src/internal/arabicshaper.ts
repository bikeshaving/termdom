/**
 * Arabic contextual shaping: base letters in, the presentation forms
 * that join them out. Not length-preserving, since a lam and the alef
 * after it become one ligature.
 *
 * Adapted from arabic-persian-reshaper 1.0.1, whose license follows.
 *
 * MIT License
 *
 * Copyright (c) 2018 Shen Yiming
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** A letter's isolated, initial, medial and final forms, 0 for none. */
type Forms = readonly [number, number, number, number];

const FORMS = new Map<number, Forms>([
	[0x0621, [0xfe80, 0, 0, 0]],
	[0x0622, [0xfe81, 0, 0, 0xfe82]],
	[0x0623, [0xfe83, 0, 0, 0xfe84]],
	[0x0624, [0xfe85, 0, 0, 0xfe86]],
	[0x0625, [0xfe87, 0, 0, 0xfe88]],
	[0x0626, [0xfe89, 0xfe8b, 0xfe8c, 0xfe8a]],
	[0x0627, [0xfe8d, 0, 0, 0xfe8e]],
	[0x0628, [0xfe8f, 0xfe91, 0xfe92, 0xfe90]],
	[0x0629, [0xfe93, 0, 0, 0xfe94]],
	[0x062a, [0xfe95, 0xfe97, 0xfe98, 0xfe96]],
	[0x062b, [0xfe99, 0xfe9b, 0xfe9c, 0xfe9a]],
	[0x062c, [0xfe9d, 0xfe9f, 0xfea0, 0xfe9e]],
	[0x062d, [0xfea1, 0xfea3, 0xfea4, 0xfea2]],
	[0x062e, [0xfea5, 0xfea7, 0xfea8, 0xfea6]],
	[0x062f, [0xfea9, 0, 0, 0xfeaa]],
	[0x0630, [0xfeab, 0, 0, 0xfeac]],
	[0x0631, [0xfead, 0, 0, 0xfeae]],
	[0x0632, [0xfeaf, 0, 0, 0xfeb0]],
	[0x0698, [0xfb8a, 0, 0, 0xfb8b]],
	[0x0633, [0xfeb1, 0xfeb3, 0xfeb4, 0xfeb2]],
	[0x0634, [0xfeb5, 0xfeb7, 0xfeb8, 0xfeb6]],
	[0x0635, [0xfeb9, 0xfebb, 0xfebc, 0xfeba]],
	[0x0636, [0xfebd, 0xfebf, 0xfec0, 0xfebe]],
	[0x0637, [0xfec1, 0xfec3, 0xfec4, 0xfec2]],
	[0x0638, [0xfec5, 0xfec7, 0xfec8, 0xfec6]],
	[0x0639, [0xfec9, 0xfecb, 0xfecc, 0xfeca]],
	[0x063a, [0xfecd, 0xfecf, 0xfed0, 0xfece]],
	[0x0640, [0x0640, 0x0640, 0x0640, 0x0640]],
	[0x0641, [0xfed1, 0xfed3, 0xfed4, 0xfed2]],
	[0x0642, [0xfed5, 0xfed7, 0xfed8, 0xfed6]],
	[0x0643, [0xfed9, 0xfedb, 0xfedc, 0xfeda]],
	[0x0644, [0xfedd, 0xfedf, 0xfee0, 0xfede]],
	[0x0645, [0xfee1, 0xfee3, 0xfee4, 0xfee2]],
	[0x0646, [0xfee5, 0xfee7, 0xfee8, 0xfee6]],
	[0x0647, [0xfee9, 0xfeeb, 0xfeec, 0xfeea]],
	[0x0648, [0xfeed, 0, 0, 0xfeee]],
	[0x0649, [0xfeef, 0xfbe8, 0xfbe9, 0xfbfd]],
	[0x064a, [0xfef1, 0xfef3, 0xfef4, 0xfef2]],
	// Farsi yeh ends in alef maksura's final form, which Arabic fonts
	// draw as the final yeh.
	[0x06cc, [0xfbfc, 0xfbfe, 0xfbff, 0xfef0]],
	[0x0686, [0xfb7a, 0xfb7c, 0xfb7d, 0xfb7b]],
	[0x067e, [0xfb56, 0xfb58, 0xfb59, 0xfb57]],
	[0x06af, [0xfb92, 0xfb94, 0xfb95, 0xfb93]],
	[0x06a9, [0xfb8e, 0xfb90, 0xfb91, 0xfb8f]],
]);

const LAM = 0x0644;

/** Lam followed by each alef: the ligature's isolated and final forms. */
const LAM_ALEF = new Map<number, readonly [number, number]>([
	[0x0622, [0xfef5, 0xfef6]],
	[0x0623, [0xfef7, 0xfef8]],
	[0x0625, [0xfef9, 0xfefa]],
	[0x0627, [0xfefb, 0xfefc]],
]);

/** The marks a letter joins across, as though they were not there. */
const TRANSPARENT = new Set([
	0x0610,
	0x0612,
	0x0613,
	0x0614,
	0x0615,
	0x064b,
	0x064c,
	0x064d,
	0x064e,
	0x064f,
	0x0650,
	0x0651,
	0x0652,
	0x0653,
	0x0654,
	0x0655,
	0x0656,
	0x0657,
	0x0658,
	0x0670,
	0x06d6,
	0x06d7,
	0x06d8,
	0x06d9,
	0x06da,
	0x06db,
	0x06dc,
	0x06df,
	0x06e0,
	0x06e1,
	0x06e2,
	0x06e3,
	0x06e4,
	0x06e7,
	0x06e8,
	0x06ea,
	0x06eb,
	0x06ec,
	0x06ed,
]);

/**
 * Each letter in the form its neighbors call for: joined to the letter
 * before when that one has an initial or medial form, and to the letter
 * after when that one has a medial or final form. A lam and the alef
 * after it become their ligature, and the code unit after the lam is
 * dropped.
 */
export function convertArabic(text: string): string {
	let shaped = "";
	for (let i = 0; i < text.length; i++) {
		const current = text.charCodeAt(i);
		const forms = FORMS.get(current);
		if (forms === undefined) {
			shaped += text[i];
			continue;
		}

		let prevAt = i - 1;
		while (prevAt >= 0 && TRANSPARENT.has(text.charCodeAt(prevAt))) {
			prevAt--;
		}

		const prevForms = prevAt >= 0
			? FORMS.get(text.charCodeAt(prevAt))
			: undefined;
		const joinsPrev =
			prevForms !== undefined && (prevForms[1] !== 0 || prevForms[2] !== 0);
		let nextAt = i + 1;
		while (nextAt < text.length && TRANSPARENT.has(text.charCodeAt(nextAt))) {
			nextAt++;
		}

		const next = nextAt < text.length ? text.charCodeAt(nextAt) : -1;
		const nextForms = FORMS.get(next);
		const joinsNext =
			nextForms !== undefined && (nextForms[2] !== 0 || nextForms[3] !== 0);
		const ligature = current === LAM && joinsNext
			? LAM_ALEF.get(next)
			: undefined;
		if (ligature !== undefined) {
			shaped += String.fromCharCode(joinsPrev ? ligature[1] : ligature[0]);
			i++;
		} else if (joinsPrev && joinsNext && forms[2] !== 0) {
			shaped += String.fromCharCode(forms[2]);
		} else if (joinsPrev && forms[3] !== 0) {
			shaped += String.fromCharCode(forms[3]);
		} else if (joinsNext && forms[1] !== 0) {
			shaped += String.fromCharCode(forms[1]);
		} else {
			shaped += String.fromCharCode(forms[0]);
		}
	}
	return shaped;
}
