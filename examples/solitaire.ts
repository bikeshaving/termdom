#!/usr/bin/env node
// Klondike solitaire, drawn as a web page and rendered to the terminal. The
// board is a flex row of flex columns, a card is a styled <span>, and every
// move is a click or a keystroke on it.
//
//   node examples/solitaire.ts            (opens the new-game menu)
//   node examples/solitaire.ts <deal>     (skips the menu -- the speedrun door)
//
//   The menu chooses one-card or three-card draw; in three-card, the discard
//   fans its last three and only the top is playable.
//
//   s      draw from the stock (or turn it over when empty; space works too)
//          each foundation takes only the suit that labels it
//   1-7    pick up a tableau pile, or drop what you are holding on it
//   d      pick up the discard's top card
//   arrows move the cursor anywhere on the board; enter takes the card
//          under it (with its stack) or places what you are holding
//   f      send what you are holding (or the first ready card) home
//   S/H/D/C  send that suit's ready card home -- the player's pick where
//          several are ready at once
//   a      send everything that fits to the foundations
//   enter on the held stack's own pile puts it back    u undo    q quit
//   n new deal    r retry this deal
//          (n and r mid-run ask first -- y or enter abandons, n stays)
//
// The clock starts on the first move and stops on the win; a deal's best
// time survives retries, which is what makes a deal number a speedrun.
//
// Clicking does the same: a card picks up, a pile drops, the stock deals, and
// a double-click sends a card home.
import {TermDOM} from "@b9g/termdom";
import type {Context} from "@b9g/crank";
import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";
import {pathToFileURL} from "node:url";

// ---- the deck ----------------------------------------------------------------

const SUITS = ["♠", "♥", "♦", "♣"];
const SUIT_NAMES = ["spade", "heart", "diamond", "club"];
const RANKS = [
	"A",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"J",
	"Q",
	"K",
];

interface Card {
	/** 1 (ace) through 13 (king). */
	rank: number;
	/** An index into SUITS; hearts and diamonds are the red ones. */
	suit: number;
	up: boolean;
}

const isRed = (card: Card): boolean => card.suit === 1 || card.suit === 2;

interface Game {
	/** The deal this game was shuffled from. */
	number: number;
	/** How many cards a turn of the stock flips: klondike's one or three. */
	draw: number;
	stock: Card[];
	waste: Card[];
	/** One pile per suit, in SUITS order, each running up from its ace. */
	foundations: Card[][];
	tableau: Card[][];
	moves: number;
}

/** mulberry32: enough randomness for a shuffle, from a number you can keep. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled(seed: number): Card[] {
	const next = random(seed);
	const deck: Card[] = [];
	for (let suit = 0; suit < 4; suit++) {
		for (let rank = 1; rank <= 13; rank++) deck.push({rank, suit, up: false});
	}
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

/** Every deal has a number, so a game you liked can be played again. */
function deal(number: number, draw: number): Game {
	const deck = shuffled(number);
	const tableau: Card[][] = [];
	for (let pile = 0; pile < 7; pile++) {
		const cards = deck.splice(0, pile + 1);
		cards[cards.length - 1].up = true;
		tableau.push(cards);
	}
	return {
		number,
		draw,
		stock: deck,
		waste: [],
		foundations: [[], [], [], []],
		tableau,
		moves: 0,
	};
}

const someDeal = (): number => Math.floor(Math.random() * 100000) + 1;

/** A copy deep enough to hand to the undo stack. */
function clone(game: Game): Game {
	const pile = (cards: Card[]) => cards.map((card) => ({...card}));
	return {
		number: game.number,
		draw: game.draw,
		stock: pile(game.stock),
		waste: pile(game.waste),
		foundations: game.foundations.map(pile),
		tableau: game.tableau.map(pile),
		moves: game.moves,
	};
}

const top = (cards: Card[]): Card | undefined => cards[cards.length - 1];

// ---- the rules ---------------------------------------------------------------

/** A foundation takes its suit's ace first, and then that suit in order. */
function fitsFoundation(card: Card, foundation: Card[]): boolean {
	const under = top(foundation);
	if (!under) return card.rank === 1;
	return under.suit === card.suit && under.rank === card.rank - 1;
}

/** A tableau pile takes a king on nothing, and descending alternating colours. */
function fitsTableau(card: Card, pile: Card[]): boolean {
	const under = top(pile);
	if (!under) return card.rank === 13;
	return (
		under.up && isRed(under) !== isRed(card) && under.rank === card.rank + 1
	);
}

/** Whether the cards from `index` down form a run that moves as one. */
function isRun(pile: Card[], index: number): boolean {
	if (index < 0 || index >= pile.length || !pile[index].up) return false;
	for (let i = index; i < pile.length - 1; i++) {
		const card = pile[i];
		const next = pile[i + 1];
		if (
			!next.up ||
			isRed(card) === isRed(next) ||
			card.rank !== next.rank + 1
		) {
			return false;
		}
	}
	return true;
}

/** The deepest card of a pile that can be picked up with everything below it. */
function runStart(pile: Card[]): number {
	let index = pile.length - 1;
	while (index > 0 && isRun(pile, index - 1)) index--;
	return index;
}

type Held =
	| {kind: "waste"}
	| {kind: "foundation"; index: number}
	| {kind: "tableau"; pile: number; index: number}
	| null;

/** The cards a hold is carrying, top of the run first in board order. */
function heldCards(game: Game, held: Held): Card[] {
	if (!held) return [];
	if (held.kind === "waste") {
		const card = top(game.waste);
		return card ? [card] : [];
	}
	if (held.kind === "foundation") {
		const card = top(game.foundations[held.index]);
		return card ? [card] : [];
	}
	return game.tableau[held.pile].slice(held.index);
}

/** Take the held cards off the board. The caller has already placed them. */
function lift(game: Game, held: Held): void {
	if (!held) return;
	if (held.kind === "waste") {
		game.waste.pop();
	} else if (held.kind === "foundation") {
		game.foundations[held.index].pop();
	} else {
		const pile = game.tableau[held.pile];
		pile.length = held.index;
		// The card a moved run was sitting on turns face up.
		const exposed = top(pile);
		if (exposed && !exposed.up) exposed.up = true;
	}
}

type Target =
	| {kind: "tableau"; pile: number}
	| {kind: "foundation"; index: number};

/** Play the held cards onto a target, or report that they do not go there. */
function play(game: Game, held: Held, target: Target): boolean {
	const cards = heldCards(game, held);
	if (cards.length === 0) return false;
	if (target.kind === "foundation") {
		// A foundation takes one card, and only ever the last of a run.
		if (cards.length !== 1) return false;
		if (target.index !== cards[0].suit) return false;
		if (!fitsFoundation(cards[0], game.foundations[target.index])) return false;
		lift(game, held);
		game.foundations[target.index].push(cards[0]);
	} else {
		if (held?.kind === "tableau" && held.pile === target.pile) return false;
		if (!fitsTableau(cards[0], game.tableau[target.pile])) return false;
		lift(game, held);
		game.tableau[target.pile].push(...cards);
	}
	game.moves++;
	return true;
}

/** The foundation a single card belongs on, if it is ready for it. */
function foundationFor(game: Game, card: Card): number | null {
	// Each foundation belongs to the suit that labels it, so a card has
	// exactly one legal home and the row always reads true.
	return fitsFoundation(card, game.foundations[card.suit]) ? card.suit : null;
}

/** Turn a card from the stock, or turn the whole waste back over. */
function draw(game: Game): boolean {
	if (game.stock.length > 0) {
		for (let i = 0; i < game.draw && game.stock.length > 0; i++) {
			const card = game.stock.pop()!;
			card.up = true;
			game.waste.push(card);
		}
		game.moves++;
		return true;
	}
	if (game.waste.length === 0) return false;
	while (game.waste.length > 0) {
		const card = game.waste.pop()!;
		card.up = false;
		game.stock.push(card);
	}
	game.moves++;
	return true;
}

/** Send every card that is ready to a foundation, until none is. Returns moves. */
function autoplay(game: Game): number {
	let played = 0;
	for (let progress = true; progress; ) {
		progress = false;
		const sources: Held[] = [{kind: "waste"}];
		for (let pile = 0; pile < 7; pile++) {
			const cards = game.tableau[pile];
			if (cards.length > 0) {
				sources.push({kind: "tableau", pile, index: cards.length - 1});
			}
		}
		for (const source of sources) {
			const card = heldCards(game, source)[0];
			if (!card) continue;
			const index = foundationFor(game, card);
			if (index === null) continue;
			play(game, source, {kind: "foundation", index});
			played++;
			progress = true;
		}
	}
	return played;
}

const won = (game: Game): boolean =>
	game.foundations.every((pile) => pile.length === 13);

// ---- the page ----------------------------------------------------------------

// The game mounts onto a TermDOM it is handed, so the demo recorder can drive
// it as easily as the command line does.
let term: TermDOM;
let document: TermDOM["document"];
let opening: number;
let startInMenu: boolean;

/** How big a card is: the terminal's size decides, through the tiers below. */
interface Tier {
	width: number;
	height: number;
	gap: number;
}

const TIERS = {
	compact: {width: 3, height: 3, gap: 1},
	roomy: {width: 5, height: 3, gap: 2},
	grand: {width: 7, height: 5, gap: 3},
} as const;
const ROOMY_MIN_WIDTH = 64;
const GRAND_MIN_WIDTH = 96;
const GRAND_MIN_HEIGHT = 32;
const HINT_MIN_HEIGHT = 20;

const sheet = (): string => {
	// One set of numbers drives the stylesheet's @media blocks AND the matchMedia
	// lists the component re-renders on, so the CSS widths and the drawn card
	// faces can never disagree about the size of a card.
	const css = (tier: Tier) => `
  .card, .slot { width: ${tier.width}ch; }
  .number, .top .gap { width: ${tier.width}ch; }
  .pile { width: ${tier.width}ch; }
  .top, .numbers, .board, .captions { gap: ${tier.gap}ch; }
  .play { width: ${7 * tier.width + 6 * tier.gap}ch; }
`;
	return `
  .table { padding: 0 1ch; background-color: #06421f; color: #cfe8d8; }
  /* The felt reaches the edges of the screen it was given. */
  .table:fullscreen { padding: 0 2ch; }
  /* The playfield is as wide as its seven piles, and the auto margins
     center it in whatever the terminal turned out to be. */
  .play { margin: 0 auto; }
  .bar { display: flex; flex-direction: row; gap: 2ch; }
  /* A crowded bar overflows the felt rather than shrinking its words. */
  .bar span { flex-shrink: 0; }
  .bar .title { color: #ffd75f; font-weight: bold; }
  .bar .score { color: #9ec5ab; }
  .bar .win { color: #ffd75f; font-weight: bold; }

  .top { display: flex; flex-direction: row; padding-top: 1px; }
  /* Region names, on the deals wide enough to teach them. */
  .captions { display: flex; flex-direction: row; padding-top: 1px; color: #4d8f66; }
  .caption { white-space: pre; }
  /* The keys the piles answer to, over the piles they answer for. */
  .numbers { display: flex; flex-direction: row; padding-top: 1px; }
  .number { color: #4d8f66; }
  .number.drop { color: #ffd75f; font-weight: bold; }
  .board { display: flex; flex-direction: row; }
  .pile { display: flex; flex-direction: column; }

  /* A card's rows are drawn, not written: the blank rows are spaces, and
     collapsing them would shorten the card. A covered card shows only the
     row its index is on, which is what makes a pile a stack. */
  .card, .slot { white-space: pre; }
  .card { background-color: #f0f0e6; color: #202020; }
  .card.red { color: #c02020; }
  .card.down { background-color: #1d4f8f; color: #4f82c8; }
  /* A held card keeps its suit's colour -- losing it is disorienting when the
     colour is what the next move is chosen by -- and changes its FIELD. */
  .card.held { background-color: #ffd75f; font-weight: bold; }
  .card.drop { background-color: #a9d7b7; }
  .slot { background-color: #05381a; color: #2f7a4a; }
  .slot.drop { background-color: #a9d7b7; color: #205c35; }
  /* Where the keyboard is, and what it holds, are one effect: the gold
     field. A card keeps its suit's colour under it either way. */
  .cursor { background-color: #ffd75f; font-weight: bold; }
  .card.down.cursor { color: #1d4f8f; }
  .slot.cursor { background-color: #ffd75f; color: #6b5b1e; }

  /* The confirm covers the screen and centers its dialog; the board stays
     visible around the box, the way a modal reads. */
  .scrim { position: fixed; top: 0; left: 0; width: 100%; height: 100%;
           display: flex; align-items: center; justify-content: center; }
  dialog { display: block; width: 48ch; border: 1px solid; border-color: #ffd75f;
           background-color: #043016; color: #cfe8d8; padding: 1px 2ch; }
  dialog .ask { color: #ffd75f; font-weight: bold; }
  dialog .answers { color: #9ec5ab; padding-top: 1px; }
  dialog .answers { display: flex; flex-direction: row; }
  .pick { color: #9ec5ab; }
  .pick.on { color: #ffd75f; font-weight: bold; }
  .pickgap { width: 3ch; }

  .hint { padding-top: 1px; color: #7fae90; }
  .hint b { color: #cfe8d8; font-weight: bold; }

  ${css(TIERS.compact)}
  @media (min-width: ${ROOMY_MIN_WIDTH}ch) { ${css(TIERS.roomy)} }
  @media (min-width: ${GRAND_MIN_WIDTH}ch) and (min-height: ${GRAND_MIN_HEIGHT}) { ${css(TIERS.grand)} }
  /* A short terminal spends its rows on the cards. */
  @media (max-height: ${HINT_MIN_HEIGHT - 1}) { .hint { display: none; } }
`;
};

// ---- the board ---------------------------------------------------------------

// Every glyph reaches the markup through an interpolation. The jsx tag parses
// a template's RAW spans, and a runtime that reports raw text as an escape
// sequence -- Bun does, for anything outside ASCII -- puts the six characters
// of `▒` on the board instead of the hatch.
const TL = "▛";
const TR = "▜";
const BL = "▙";
const BR = "▟";
const T = "▀";
const B = "▄";
const L = "▌";
const R = "▐";
const MOTIF = "♦";
const TURN_GLYPH = "↻";
const DOT = " · ";
const MIDDOT = "·";
const STAR = "★";
const ARROWS_ALL = "←↑↓→";

const blank = (width: number): string => " ".repeat(width);

/**
 * A card back: a plate with solid half-block rails and a single motif at the
 * center, the way a printed back reads. A covered card shows the plate's top
 * rule, so a pile of backs is ruled lines rather than pattern noise.
 */
const backRows = (width: number, height: number): string[] =>
	Array.from({length: height}, (_, row) => {
		if (row === 0) return TL + T.repeat(width - 2) + TR;
		if (row === height - 1) return BL + B.repeat(width - 2) + BR;
		const inner = Array.from({length: width - 2}, (_, col) =>
			row === Math.floor(height / 2) && col === Math.floor((width - 2) / 2)
				? MOTIF
				: " ",
		).join("");
		return L + inner + R;
	});

/** `text` centered in a field of `width` cells. */
function centered(text: string, width: number): string {
	const pad = Math.max(0, width - text.length);
	const left = Math.floor(pad / 2);
	return " ".repeat(left) + text + " ".repeat(pad - left);
}

/**
 * A card's face: its index across the top-left, its suit at the center on
 * any card wide enough to carry one, and the mirrored index -- suit then
 * rank -- reading into the bottom-right corner, the rotational symmetry of
 * a real card's two indices.
 */
function faceRows(card: Card, tier: Tier): string[] {
	const {width, height} = tier;
	if (!card.up) return backRows(width, height);
	const grid = Array.from({length: height}, () =>
		Array.from({length: width}, () => " "),
	);
	const index = `${RANKS[card.rank - 1]}${SUITS[card.suit]}`;
	for (let i = 0; i < index.length && i < width; i++) grid[0][i] = index[i];
	if (width > 3) {
		grid[Math.floor(height / 2)][Math.floor(width / 2)] = SUITS[card.suit];
	}
	// The bottom corner mirrors the top: suit then rank, reading into the
	// corner -- the rotational symmetry of a real card's two indices, spelled
	// by unit order rather than by turned glyphs.
	const corner = `${SUITS[card.suit]}${RANKS[card.rank - 1]}`;
	for (let i = 0; i < corner.length; i++) {
		grid[height - 1][width - corner.length + i] = corner[i];
	}
	return grid.map((row) => row.join(""));
}

interface CardProps {
	card: Card;
	tier: Tier;
	/** A card with another lying over it, showing its index row alone. */
	covered?: boolean;
	held?: boolean;
	drop?: boolean;
	/** The keyboard cursor rests here. */
	cursor?: boolean;
	onclick?: (event: MouseEvent) => unknown;
	ondblclick?: (event: MouseEvent) => unknown;
}

function CardFace({
	card,
	tier,
	covered,
	held,
	drop,
	cursor,
	onclick,
	ondblclick,
}: CardProps) {
	const classes = ["card"];
	if (!card.up) classes.push("down");
	else if (isRed(card)) classes.push("red");
	if (held) classes.push("held");
	else if (drop) classes.push("drop");
	if (cursor) classes.push("cursor");
	const rows = faceRows(card, tier);
	return jsx`
		<div
			class=${classes.join(" ")}
			onclick=${onclick}
			ondblclick=${ondblclick}
		>${(covered ? rows.slice(0, 1) : rows).map(
			(row, line) => jsx`<div key=${line}>${row}</div>`,
		)}</div>
	`;
}

/** An empty place on the board: the stock's turnover arrow, or a suit's home. */
function Slot({
	tier,
	mark,
	drop,
	cursor,
	onclick,
}: {
	tier: Tier;
	mark?: string;
	drop?: boolean;
	cursor?: boolean;
	onclick?: (event: MouseEvent) => unknown;
}) {
	const rows = Array.from({length: tier.height}, (_, line) =>
		line === Math.floor(tier.height / 2) && mark
			? centered(mark, tier.width)
			: blank(tier.width),
	);
	const classes = ["slot"];
	if (drop) classes.push("drop");
	if (cursor) classes.push("cursor");
	return jsx`
		<div class=${classes.join(" ")} onclick=${onclick}>${rows.map(
			(row, line) => jsx`<div key=${line}>${row}</div>`,
		)}</div>
	`;
}

/** A run's clock, as a speedrunner reads it: m:ss. */
function clock(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function* App(this: Context) {
	// One or three cards per turn of the stock -- chosen on the menu, kept
	// for every deal after. A deal named on the command line skips the menu:
	// that is the speedrunner's and the verifier's door.
	let mode: 1 | 3 = 1;
	let menu = startInMenu;
	let game = deal(opening, 1);
	let held: Held = null;
	let history: Game[] = [];
	let message = "";
	// The clock runs from the first move to the win, and a best is the best
	// for THIS deal -- retrying the same number is what a speedrun is.
	let startedAt: number | null = null;
	let finishedAt: number | null = null;
	let best: {ms: number; moves: number} | null = null;

	const ticker = setInterval(() => {
		if (startedAt !== null && finishedAt === null) this.refresh();
	}, 1000);
	this.cleanup(() => clearInterval(ticker));

	// A run in progress is worth a question: n and r open a <dialog> instead
	// of tearing the game down on one keystroke, and the dialog's keys are the
	// only ones that answer while it shows.
	let confirming: {number: number; label: string} | null = null;

	const guardedReset = (number: number, label: string): void => {
		const live = startedAt !== null && finishedAt === null && game.moves > 0;
		if (!live) return reset(number);
		this.refresh(() => {
			confirming = {number, label};
		});
	};

	/** Back to the deal's opening position, clock unstarted. */
	const reset = (number: number): void => {
		this.refresh(() => {
			if (number !== game.number) best = null;
			game = deal(number, mode);
			history = [];
			held = null;
			message = "";
			startedAt = null;
			finishedAt = null;
		});
	};

	/** Run a move, keeping the board undoable and the hold consistent. */
	const act = (change: (game: Game) => boolean, note = ""): void => {
		const before = clone(game);
		if (!change(game)) {
			// An illegal move is not a mistake worth a history entry, but the
			// player deserves to know the card did not go.
			this.refresh(() => {
				message = note || "That card does not go there.";
			});
			return;
		}
		this.refresh(() => {
			history.push(before);
			if (history.length > 200) history.shift();
			held = null;
			message = "";
			if (startedAt === null) startedAt = performance.now();
			if (won(game) && finishedAt === null) {
				finishedAt = performance.now();
				const ms = finishedAt - startedAt;
				if (!best || ms < best.ms) {
					best = {ms, moves: game.moves};
					message = `${STAR} best`;
				}
			}
		});
	};

	const grab = (next: Held): void => {
		this.refresh(() => {
			// Picking up what you are already holding puts it back.
			const same =
				held &&
				next &&
				held.kind === next.kind &&
				(held.kind !== "tableau" ||
					(next.kind === "tableau" &&
						held.pile === next.pile &&
						held.index === next.index));
			held = same ? null : next;
			message = "";
		});
	};

	/** Drop on a pile, or -- holding nothing -- pick that pile up instead. */
	const target = (target: Target): void => {
		if (held) {
			// Its own pile takes a held stack BACK: in fullscreen the platform
			// owns Escape (it exits), so releasing is a move like any other.
			if (
				held.kind === "tableau" &&
				target.kind === "tableau" &&
				held.pile === target.pile
			) {
				return grab(held);
			}
			act((game) => play(game, held, target));
			return;
		}
		if (target.kind === "foundation") {
			if (game.foundations[target.index].length > 0) {
				grab({kind: "foundation", index: target.index});
			}
			return;
		}
		const pile = game.tableau[target.pile];
		if (pile.length > 0) {
			grab({kind: "tableau", pile: target.pile, index: runStart(pile)});
		}
	};

	/**
	 * Send a card home: the one named, else the one being held, else the
	 * first that is ready -- the waste before the tableau, as a hand would.
	 */
	const sendHome = (named?: Held): void => {
		let candidates: Held[];
		if (named ?? held) {
			candidates = [named ?? held];
		} else {
			candidates = [{kind: "waste"}];
			for (let pile = 0; pile < 7; pile++) {
				const cards = game.tableau[pile];
				if (cards.length > 0) {
					candidates.push({kind: "tableau", pile, index: cards.length - 1});
				}
			}
		}
		for (const source of candidates) {
			const card = heldCards(game, source)[0];
			const index = card?.up ? foundationFor(game, card) : null;
			if (index === null) continue;
			act((game) => play(game, source, {kind: "foundation", index}));
			return;
		}
		this.refresh(() => {
			message = "Nothing is ready for a foundation.";
		});
	};

	/**
	 * Send a named suit's ready card to its foundation: the held card if it
	 * is that suit, else the discard's top, else the first pile top. Where f
	 * auto-picks among several ready cards, a suit key is the player's pick.
	 */
	const sendSuit = (suit: number): void => {
		const grip = held;
		const home = {kind: "foundation" as const, index: suit};
		if (grip) {
			const card = heldCards(game, grip)[0];
			if (card?.suit === suit) {
				return act((game) => play(game, grip, home));
			}
		} else {
			const wasteCard = top(game.waste);
			if (
				wasteCard?.suit === suit &&
				fitsFoundation(wasteCard, game.foundations[suit])
			) {
				return act((game) => play(game, {kind: "waste"}, home));
			}
			for (let pile = 0; pile < 7; pile++) {
				const cards = game.tableau[pile];
				const card = top(cards);
				if (
					card?.up &&
					card.suit === suit &&
					fitsFoundation(card, game.foundations[suit])
				) {
					return act((game) =>
						play(game, {kind: "tableau", pile, index: cards.length - 1}, home),
					);
				}
			}
		}
		this.refresh(() => {
			message = `No ${SUIT_NAMES[suit]} is ready for its foundation.`;
		});
	};

	const undo = (): void => {
		this.refresh(() => {
			const before = history.pop();
			if (!before) {
				message = "Nothing to undo.";
				return;
			}
			game = before;
			held = null;
			message = "";
		});
	};

	// The cursor is a place on the board, in the board's own geometry: seven
	// columns, a top row (stock, discard, a gap, four foundations) and the
	// tableau below, where a column is a pile and the cursor can rest on any
	// face-up card of it. Enter acts where the cursor is; the arrows move it,
	// wrapping across columns.
	let cur: {row: "top" | "board"; col: number; depth: number} = {
		row: "board",
		col: 0,
		depth: 0,
	};
	// The cursor exists once the keyboard asks for it -- the :focus-visible
	// convention. A fresh deal shows no gold, and a mouse game never does.
	let cursorShown = false;

	/** The top row's occupied columns: the gap at column 2 holds nothing. */
	const TOP_COLS = [0, 1, 3, 4, 5, 6];

	const pileAt = (col: number): Card[] => game.tableau[col];
	const lastOf = (pile: Card[]): number => pile.length - 1;
	const firstUp = (pile: Card[]): number => {
		const index = pile.findIndex((card) => card.up);
		return index < 0 ? lastOf(pile) : index;
	};

	const moveCursor = (dx: number, dy: number): void => {
		this.refresh(() => {
			message = "";
			cursorShown = true;
			if (dx !== 0) {
				if (cur.row === "top") {
					const at = TOP_COLS.indexOf(cur.col);
					cur = {
						...cur,
						col: TOP_COLS[(at + dx + TOP_COLS.length) % TOP_COLS.length],
					};
				} else {
					const col = (cur.col + dx + 7) % 7;
					cur = {row: "board", col, depth: lastOf(pileAt(col))};
				}
				return;
			}
			if (cur.row === "top") {
				if (dy > 0) {
					const col = cur.col === 2 ? 1 : cur.col;
					cur = {row: "board", col, depth: lastOf(pileAt(col))};
				}
				return;
			}
			const pile = pileAt(cur.col);
			if (dy < 0) {
				if (pile.length === 0 || cur.depth <= firstUp(pile)) {
					cur = {row: "top", col: cur.col === 2 ? 1 : cur.col, depth: 0};
				} else {
					cur = {...cur, depth: cur.depth - 1};
				}
			} else if (cur.depth < lastOf(pile)) {
				cur = {...cur, depth: cur.depth + 1};
			}
		});
	};

	/** Enter, wherever the cursor rests: pick up, drop, or draw. */
	const activate = (): void => {
		if (cur.row === "top") {
			if (cur.col === 0)
				return act(draw, "The stock and the discard are both empty.");
			if (cur.col === 1) {
				if (held)
					return void this.refresh(() => {
						message = "The discard takes nothing back.";
					});
				if (top(game.waste)) grab({kind: "waste"});
				return;
			}
			return target({kind: "foundation", index: cur.col - 3});
		}
		const pile = pileAt(cur.col);
		if (held) return target({kind: "tableau", pile: cur.col});
		if (pile.length === 0) return;
		const card = pile[cur.depth];
		if (!card?.up || !isRun(pile, cur.depth)) {
			this.refresh(() => {
				message = "That card is not free to take.";
			});
			return;
		}
		grab({kind: "tableau", pile: cur.col, index: cur.depth});
	};

	const onkeydown = (event: KeyboardEvent): void => {
		const key = event.key;
		if (menu) {
			if (key === "1" || key === "3") {
				this.refresh(() => {
					mode = key === "1" ? 1 : 3;
				});
			} else if (key === "Enter" || key === " " || key === "y") {
				menu = false;
				reset(someDeal());
			} else if (key === "n" || key === "b") {
				this.refresh(() => {
					menu = false;
				});
			} else if (key === "q") {
				term.window.close();
			}
			return;
		}
		if (confirming) {
			if (key === "y" || key === "Enter") {
				const number = confirming.number;
				confirming = null;
				reset(number);
			} else if (key === "n" || key === "Escape") {
				this.refresh(() => {
					confirming = null;
				});
			}
			return;
		}
		if (key === "q") {
			term.window.close();
			return;
		}
		if (key === "n") {
			this.refresh(() => {
				menu = true;
			});
			return;
		}
		if (key === "r") return guardedReset(game.number, "this deal again");
		if (key === "u") return undo();
		if (key === "Escape") {
			this.refresh(() => {
				held = null;
				message = "";
			});
			return;
		}
		if (key === " " || key === "s") {
			return act(draw, "The stock and the discard are both empty.");
		}
		if (key === "d" || key === "w") {
			if (top(game.waste)) grab({kind: "waste"});
			return;
		}
		if (key === "f") return sendHome();
		if (key === "S" || key === "H" || key === "D" || key === "C") {
			return sendSuit({S: 0, H: 1, D: 2, C: 3}[key]!);
		}
		if (key === "a") {
			act((game) => autoplay(game) > 0, "Nothing is ready for a foundation.");
			return;
		}
		if (key === "Tab") {
			event.preventDefault();
			const stops: Array<{row: "top" | "board"; col: number}> = [
				...Array.from({length: 7}, (_, col) => ({row: "board" as const, col})),
				...TOP_COLS.map((col) => ({row: "top" as const, col})),
			];
			const at = stops.findIndex(
				(stop) => stop.row === cur.row && stop.col === cur.col,
			);
			const step = event.shiftKey ? -1 : 1;
			const next = stops[(at + step + stops.length) % stops.length];
			this.refresh(() => {
				message = "";
				cursorShown = true;
				cur = {
					row: next.row,
					col: next.col,
					depth:
						next.row === "board" ? Math.max(0, pileAt(next.col).length - 1) : 0,
				};
			});
			return;
		}
		if (key === "ArrowUp") return moveCursor(0, -1);
		if (key === "ArrowDown") return moveCursor(0, 1);
		if (key === "ArrowLeft") return moveCursor(-1, 0);
		if (key === "ArrowRight") return moveCursor(1, 0);
		if (key === "Enter") {
			// Until the arrows summon the cursor, Enter draws -- the typing
			// player's right hand never leaves home row. With the cursor up,
			// Enter takes and places at it.
			if (!cursorShown) {
				return act(draw, "The stock and the discard are both empty.");
			}
			return activate();
		}
		if (key >= "1" && key <= "7") {
			const pile = Number(key) - 1;
			// Naming a pile you cannot reach from is a change of mind, not an
			// error: pick that pile up instead of refusing the move.
			if (held && !fitsTableau(heldCards(game, held)[0], game.tableau[pile])) {
				const cards = game.tableau[pile];
				if (cards.length > 0) {
					grab({kind: "tableau", pile, index: runStart(cards)});
					return;
				}
			}
			target({kind: "tableau", pile});
		}
	};
	document.addEventListener("keydown", onkeydown);
	this.cleanup(() => document.removeEventListener("keydown", onkeydown));

	// Read through a call, so the render below sees what the closures above
	// assign rather than the null this was declared with.
	const holding = (): Held => held;
	const asking = (): {number: number; label: string} | null => confirming;
	const inMenu = (): boolean => menu;
	const modeNow = (): 1 | 3 => mode;

	// The tier is the terminal's answer, asked through the same evaluator the
	// stylesheet's @media blocks use, and a resize that crosses a breakpoint
	// re-renders the faces to the size the CSS just snapped to.
	const roomy = term.window.matchMedia(`(min-width: ${ROOMY_MIN_WIDTH}ch)`);
	const grand = term.window.matchMedia(
		`(min-width: ${GRAND_MIN_WIDTH}ch) and (min-height: ${GRAND_MIN_HEIGHT})`,
	);
	const retier = () => this.refresh();
	roomy.addEventListener("change", retier);
	grand.addEventListener("change", retier);
	this.cleanup(() => {
		roomy.removeEventListener("change", retier);
		grand.removeEventListener("change", retier);
	});
	const tier = (): Tier =>
		grand.matches ? TIERS.grand : roomy.matches ? TIERS.roomy : TIERS.compact;

	// eslint-disable-next-line no-empty-pattern
	for ({} of this) {
		if (inMenu()) {
			yield jsx`
				<div class="table">
					<div class="scrim">
						<dialog open>
							<div class="ask">Solitaire ${MIDDOT} new game</div>
							<div class="answers">
								<span class=${modeNow() === 1 ? "pick on" : "pick"}>${"[1] one card"}</span>
								<span class="pickgap"> </span>
								<span class=${modeNow() === 3 ? "pick on" : "pick"}>${"[3] three cards"}</span>
							</div>
							<div class="answers">enter deals ${MIDDOT} b back ${MIDDOT} q quit</div>
						</dialog>
					</div>
				</div>
			`;
			continue;
		}
		const t = tier();
		// The board the cursor was on may have shrunk under it.
		if (cur.row === "board") {
			cur = {
				...cur,
				depth: Math.max(0, Math.min(cur.depth, pileAt(cur.col).length - 1)),
			};
		}
		const atTop = (col: number): boolean =>
			cursorShown && cur.row === "top" && cur.col === col;
		const grip = holding();
		const ask = asking();
		const carrying = heldCards(game, grip);
		const card = carrying[0];
		const wasteTop = top(game.waste);
		const home = card ? foundationFor(game, card) : null;

		yield jsx`
			<div class="table">
				<div class="play">
				<div class="bar">
					<span class="title">Solitaire</span>
					<span class="score">deal ${game.number}</span>
					<span class="score">
						${game.moves} ${game.moves === 1 ? "move" : "moves"}
					</span>
					<span class="score">
						${clock(startedAt === null ? 0 : (finishedAt ?? performance.now()) - startedAt)}
					</span>
					${
						won(game)
							? jsx`<span class="win">Won${message ? ` ${MIDDOT} ${message}` : ""}</span>`
							: message && jsx`<span class="score">${message}</span>`
					}
				</div>

				${
					t === TIERS.grand &&
					jsx`<div class="captions">
						<span class="caption">${"[s]tock".padEnd(t.width)}</span>
						<span class="caption">${"[d]iscard"}</span>
						<span class="caption">${blank(2 * t.width - 9)}</span>
						<span class="caption">${centered("[f]oundations", 4 * t.width + 3 * t.gap)}</span>
					</div>`
				}
				<div class="top">
					<div class="pile">
						${
							game.stock.length > 0
								? jsx`<${CardFace}
										card=${{rank: 1, suit: 0, up: false}}
										tier=${t}
										cursor=${atTop(0)}
										onclick=${() => act(draw)}
									/>`
								: jsx`<${Slot} tier=${t} mark=${TURN_GLYPH}
										cursor=${atTop(0)} onclick=${() => act(draw)} />`
						}
					</div>
					<div class="pile">
						${
							wasteTop
								? game.waste.slice(-(game.draw === 3 ? 3 : 1)).map(
										(card, at, fan) => jsx`<${CardFace}
												key=${`${card.suit}-${card.rank}`}
												card=${card}
												tier=${t}
												covered=${at < fan.length - 1}
												held=${at === fan.length - 1 && grip?.kind === "waste"}
												cursor=${at === fan.length - 1 && atTop(1)}
												onclick=${at === fan.length - 1 ? () => grab({kind: "waste"}) : undefined}
												ondblclick=${at === fan.length - 1 ? () => sendHome({kind: "waste"}) : undefined}
											/>`,
									)
								: jsx`<${Slot} tier=${t} cursor=${atTop(1)} />`
						}
					</div>
					<div class="gap"></div>
					${game.foundations.map(
						(foundation, index) => jsx`
							<div class="pile" key=${`foundation-${index}`}>
								${
									top(foundation)
										? jsx`<${CardFace}
												card=${top(foundation)}
												tier=${t}
												held=${grip?.kind === "foundation" && grip.index === index}
												drop=${home === index}
												cursor=${atTop(3 + index)}
												onclick=${() => target({kind: "foundation", index})}
											/>`
										: jsx`<${Slot}
												tier=${t}
												mark=${SUITS[index]}
												cursor=${atTop(3 + index)}
												drop=${home === index}
												onclick=${() => target({kind: "foundation", index})}
											/>`
								}
							</div>
						`,
					)}
				</div>

				<div class="numbers">
					${game.tableau.map(
						(pile, index) => jsx`
							<span
								class=${Boolean(card) && fitsTableau(card, pile) ? "number drop" : "number"}
								key=${`number-${index}`}
							>${centered(String(index + 1), t.width)}</span>
						`,
					)}
				</div>
				<div class="board">
					${game.tableau.map(
						(pile, index) => jsx`
							<div class="pile" key=${`pile-${index}`}>
								${
									pile.length === 0
										? jsx`<${Slot}
												tier=${t}
												drop=${Boolean(card) && fitsTableau(card, pile)}
												cursor=${cursorShown && cur.row === "board" && cur.col === index}
												onclick=${() => target({kind: "tableau", pile: index})}
											/>`
										: pile.map(
												(each, depth) => jsx`
													<${CardFace}
														key=${`${each.suit}-${each.rank}`}
														card=${each}
														tier=${t}
														covered=${depth < pile.length - 1}
														cursor=${cursorShown && cur.row === "board" && cur.col === index && cur.depth === depth}
														held=${grip?.kind === "tableau" && grip.pile === index && depth >= grip.index}
														drop=${depth === pile.length - 1 && Boolean(card) && fitsTableau(card, pile)}
														onclick=${() => {
															if (held || !each.up) {
																target({kind: "tableau", pile: index});
															} else if (isRun(pile, depth)) {
																grab({
																	kind: "tableau",
																	pile: index,
																	index: depth,
																});
															}
														}}
														ondblclick=${() => {
															if (depth === pile.length - 1 && each.up) {
																sendHome({
																	kind: "tableau",
																	pile: index,
																	index: depth,
																});
															}
														}}
													/>
												`,
											)
								}
							</div>
						`,
					)}
				</div>

				</div>
				${
					ask &&
					jsx`<div class="scrim">
						<dialog open>
							<div class="ask">Abandon this run?</div>
							<div class="answers">${"y"} starts ${ask.label} ${MIDDOT} ${"n"} keeps playing</div>
						</dialog>
					</div>`
				}
				<div class="hint"><b>[s]</b>tock${DOT}<b>[d]</b>iscard${DOT}<b>[f]</b>oundation${DOT}<b>S/H/D/C</b> by suit${DOT}<b>[1-7]</b> pile${DOT}<b>${ARROWS_ALL}</b>/<b>tab</b> move${DOT}<b>enter</b> take/place${DOT}<b>[a]</b>uto${DOT}<b>[u]</b>ndo${DOT}<b>[n]</b>ew${DOT}<b>[r]</b>etry${DOT}<b>[q]</b>uit</div>
			</div>
		`;
	}
}

export function mount(host: TermDOM, options: {deal?: number} = {}): void {
	term = host;
	term.attach();
	({document} = term);
	globalThis.Node = term.window.Node;
	globalThis.document = document as never;
	startInMenu = options.deal === undefined;
	opening = options.deal ?? someDeal();
	const style = document.createElement("style");
	style.textContent = sheet();
	document.head.appendChild(style);
	renderer.render(jsx`<${App} />`, document.body);
	// A game takes the screen. The alternate screen keeps the deal off the
	// scrollback -- the shell comes back exactly as it was left -- and gives
	// the board the whole terminal.
	const table = document.querySelector(".table") as HTMLElement;
	void table.requestFullscreen();
}

// `node examples/solitaire.ts 4242` deals game 4242 again, skipping the menu.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const argument = Number(process.argv[2]);
	mount(
		new TermDOM(),
		Number.isFinite(argument) && argument > 0 ? {deal: argument} : {},
	);
}
