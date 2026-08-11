/**
 * Klondike, scripted for recording: deal 13's opening ace, a run built with
 * the cursor, a draw played from the discard, the ace it uncovers, the
 * new-game menu, and an undo. Deal 13 is chosen for exactly this script.
 */
import type {TermDOM} from "../../src/index.js";

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const TAB = "\t";

export default {
	async setup(termdom: TermDOM) {
		const {mount} = await import("../../examples/solitaire.js");
		mount(termdom as never, {deal: 13});
	},
	steps: [
		1,
		"f", // the ace of diamonds, straight home
		1.1,
		RIGHT,
		0.25,
		RIGHT,
		0.3,
		ENTER, // take the six of spades
		0.6,
		RIGHT,
		0.25,
		RIGHT,
		0.25,
		RIGHT,
		0.3,
		ENTER, // onto the seven of hearts
		0.9,
		RIGHT,
		0.3,
		ENTER, // take the five of diamonds
		0.5,
		LEFT,
		0.3,
		ENTER, // the run grows
		1,
		" ",
		0.45,
		" ",
		0.45,
		" ",
		0.6, // three draws
		"d",
		0.5,
		"6", // the four of spades, from the discard
		1,
		"f", // the ace of clubs the six uncovered
		1.2,
		"n",
		1.3,
		"b", // the new-game menu, declined
		0.9,
		"u", // and an undo
		1,
		TAB,
		0.35,
		TAB,
		0.4,
		1.8,
	],
};
