#!/usr/bin/env node
// Klondike solitaire, drawn as a web page and rendered to the terminal. The
// board is a flex row of flex columns, a card is a styled <span>, and every
// move is a click or a keystroke on it.
//
//   node examples/solitaire.ts            (opens the new-game menu)
//   node examples/solitaire.ts <deal>     (skips the menu -- the speedrun door)
//
//   The menu chooses one-card or three-card draw; in three-card, the flip
//   fans its last three and only the top is playable.
//
//   space  draw from the deck (or turn it over when empty; enter draws too
//          while nothing is focused)
//   f      pick up the flip's top card (0 works too -- the pile left of 1)
//   1-7    pick up a tableau pile's whole face-up stack, or put what you
//          are holding down on it; the same number again picks up one
//          card fewer, down to the top card, then the whole stack again
//   arrows and tab move the focus anywhere on the board; enter picks up
//          the card under it (with its stack), puts down what you are
//          holding, or puts the focused card back
//   s/h/d/c  send that suit's ready card home -- each home takes only the
//          suit that labels it, and the letters are the player's pick
//          where several cards are ready at once
//   a      send everything that fits home
//   escape lets go of what you hold    u undo    q quit
//   n new deal    r retry this deal
//          (n and r mid-run ask first -- y or enter abandons, n stays)
//
// The clock starts on the first move and stops on the win; a deal's best
// time survives retries, which is what makes a deal number a speedrun.
//
// Clicking does the same: a card picks up, a pile drops, the deck deals, and
// a double-click sends a card home. The menu and the confirm dialog take
// clicks too.
import {pathToFileURL} from "node:url";

import type {Context} from "@b9g/crank";
import {renderer} from "@b9g/crank/dom";
import {jsx} from "@b9g/crank/standalone";
import {TermDOM} from "@b9g/termdom";

// ---- the deck ----------------------------------------------------------------

const SUITS = ["♠", "♥", "♦", "♣"];
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

function isRed(card: Card): boolean {
  return card.suit === 1 || card.suit === 2;
}

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
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({rank, suit, up: false});
    }
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

function someDeal(): number {
  return Math.floor(Math.random() * 100000) + 1;
}

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

function top(cards: Card[]): Card | undefined {
  return cards[cards.length - 1];
}

// ---- the rules ---------------------------------------------------------------

/** A foundation takes its suit's ace first, and then that suit in order. */
function fitsFoundation(card: Card, foundation: Card[]): boolean {
  const under = top(foundation);
  if (!under) {
    return card.rank === 1;
  }
  return under.suit === card.suit && under.rank === card.rank - 1;
}

/** A tableau pile takes a king on nothing, and descending alternating colours. */
function fitsTableau(card: Card, pile: Card[]): boolean {
  const under = top(pile);
  if (!under) {
    return card.rank === 13;
  }
  return (
    under.up && isRed(under) !== isRed(card) && under.rank === card.rank + 1
  );
}

/** Whether the cards from `index` down form a run that moves as one. */
function isRun(pile: Card[], index: number): boolean {
  if (index < 0 || index >= pile.length || !pile[index].up) {
    return false;
  }
  for (let i = index; i < pile.length - 1; i++) {
    const card = pile[i];
    const next = pile[i + 1];
    if (
      !next.up || isRed(card) === isRed(next) || card.rank !== next.rank + 1
    ) {
      return false;
    }
  }
  return true;
}

/** The deepest card of a pile that can be picked up with everything below it. */
function runStart(pile: Card[]): number {
  let index = pile.length - 1;
  while (index > 0 && isRun(pile, index - 1)) {
    index--;
  }
  return index;
}

type Held =
  {kind: "waste"} |
  {kind: "foundation"; index: number} |
  {kind: "tableau"; pile: number; index: number} |
  null;

/** The cards a hold is carrying, top of the run first in board order. */
function heldCards(game: Game, held: Held): Card[] {
  if (!held) {
    return [];
  }
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
  if (!held) {
    return;
  }
  if (held.kind === "waste") {
    game.waste.pop();
  } else if (held.kind === "foundation") {
    game.foundations[held.index].pop();
  } else {
    const pile = game.tableau[held.pile];
    pile.length = held.index;
    // The card a moved run was sitting on turns face up.
    const exposed = top(pile);
    if (exposed && !exposed.up) {
      exposed.up = true;
    }
  }
}

type Target =
  {kind: "tableau"; pile: number} | {kind: "foundation"; index: number};

/** Play the held cards onto a target, or report that they do not go there. */
function play(game: Game, held: Held, target: Target): boolean {
  const cards = heldCards(game, held);
  if (cards.length === 0) {
    return false;
  }
  if (target.kind === "foundation") {
    // A foundation takes one card, and only ever the last of a run.
    if (cards.length !== 1) {
      return false;
    }
    if (target.index !== cards[0].suit) {
      return false;
    }
    if (!fitsFoundation(cards[0], game.foundations[target.index])) {
      return false;
    }
    lift(game, held);
    game.foundations[target.index].push(cards[0]);
  } else {
    if (held?.kind === "tableau" && held.pile === target.pile) {
      return false;
    }
    if (!fitsTableau(cards[0], game.tableau[target.pile])) {
      return false;
    }
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
  if (game.waste.length === 0) {
    return false;
  }
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
  for (let progress = true; progress;) {
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
      if (!card) {
        continue;
      }
      const index = foundationFor(game, card);
      if (index === null) {
        continue;
      }
      play(game, source, {kind: "foundation", index});
      played++;
      progress = true;
    }
  }
  return played;
}

function won(game: Game): boolean {
  return game.foundations.every((pile) => pile.length === 13);
}

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
  compact: {width: 4, height: 3, gap: 1},
  roomy: {width: 5, height: 3, gap: 2},
  grand: {width: 7, height: 5, gap: 3},
} as const;
const ROOMY_MIN_WIDTH = 64;
const GRAND_MIN_WIDTH = 96;
const GRAND_MIN_HEIGHT = 32;
const HINT_MIN_HEIGHT = 20;

/**
 * The face of a card `depth` cards under the top one, from the top face
 * down five units of each channel a card, so the thirteenth is still a
 * cream and not a grey.
 */
function faceShade(depth: number): string {
  const step = Math.min(depth, 12) * 5;
  const hex = (channel: number) =>
    (channel - step).toString(16).padStart(2, "0");
  return `#${hex(0xf0)}${hex(0xf0)}${hex(0xe6)}`;
}

function depthShades(): string {
  return Array.from({length: 12}, (_, i) => {
    const depth = i + 1;
    const nth = depth === 12 ? `n+${depth + 1}` : String(depth + 1);
    return `  .fan > .card:not(.down):nth-last-child(${nth}),
  .pile > .card:not(.down):nth-last-child(${nth}) { background-color: ${faceShade(depth)}; }`;
  }).join("\n");
}

function sheet(): string {
  // One set of numbers drives the stylesheet's @media blocks AND the matchMedia
  // lists the component re-renders on, so the CSS widths and the drawn card
  // faces can never disagree about the size of a card.
  const css = (tier: Tier) => `
  .card, .slot { width: ${tier.width}ch; height: ${tier.height}px; }
  .number, .top .gap { width: ${tier.width}ch; }
  .pile { width: ${tier.width}ch; }
  .place { width: ${tier.width}ch; height: ${tier.height}px; }
  .pile > .card + .card { margin-top: -${tier.height - 1}px; }
  .pile > .card + .card:focus { margin-top: -${tier.height - 2}px; }
  .fan > .card + .card { margin-left: -${tier.width - 3}ch; }
  .top, .numbers, .board, .captions { gap: ${tier.gap}ch; }
  .play { width: ${7 * tier.width + 6 * tier.gap}ch; }
`;
  return `
  .table { padding: 0 1ch; background-color: #06421f; color: #cfe8d8; user-select: none; }
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

  .top { display: flex; flex-direction: row; margin-top: 1px; }
  /* Region names, on the deals wide enough to teach them. */
  .captions { display: flex; flex-direction: row; padding-top: 1px; color: #4d8f66; }
  .caption { white-space: pre; }
  /* The keys the piles answer to, over the piles they answer for. */
  .numbers { display: flex; flex-direction: row; padding-top: 1px; }
  .number { color: #4d8f66; }
  .number.drop { color: #ffd75f; font-weight: bold; }
  .board { display: flex; flex-direction: row; }
  .pile { display: flex; flex-direction: column; position: relative; z-index: 0; }
  .fan { display: flex; flex-direction: row; align-items: flex-start; }
  /* Every place a stack lives has the same dark ground under its cards, so
     a card that steps down shows the place behind it. The pile is its own
     stacking context, so the place sits under the cards and over the felt. */
  .place { position: absolute; top: 0; left: 0; z-index: -1; background-color: #05381a; }

  /* A card's rows are drawn, not written: the blank rows are spaces, and
     collapsing them would shorten the card. Every card is whole; a pile is
     cards laid over one another, each all but a row under the next, and
     the flip's fan lays them over one another sideways, each all but its
     index under the next; three columns, since a 10 takes them. A later
     card paints over an earlier one. */
  .card, .slot { white-space: pre; }
  .card { background-color: #f0f0e6; color: #202020; }
  .card.red { color: #c02020; }
  .card.down { background-color: #1d4f8f; color: #4f82c8; }
  /* A held card looks like any other. The one highlight on the board is
     the focus; what is held shows in the green of the places it can go. */
  .card.drop { background-color: #a9d7b7; }
  /* Each card under another is a shade darker than the one over it, a
     step a run of thirteen can take without reaching grey, so a fan or a
     run reads as cards rather than as one field. Backs keep their blue. */
  ${depthShades()}
  .slot { background-color: #05381a; color: #2f7a4a; }
  .slot.drop { background-color: #a9d7b7; color: #205c35; }
  /* The focused card steps down a row, the way a hand lifts a card off
     its pile, and it is the document's focus: tab, the arrows, the numbers
     and a click all move the same thing. Its colours stay its own. A card
     over another uncovers a second row of it; the first card of a pile
     uncovers the place. */
  .card, .slot { outline: none; }
  .card:focus { margin-top: 1px; background-color: #fbfbf5; }
  /* An empty place does not move. It takes the focus only as somewhere to
     put what is held, or as the deck to turn over, and brightens its mark. */
  .slot:focus { color: #cfe8d8; }

  /* The confirm covers the screen and centers its dialog; the board stays
     visible around the box, the way a modal reads. */
  /* Behind the menu or a question a game in progress fades: every colour on the felt
     drops toward it, so the board reads as where you were rather than what
     you are doing. Before any game is dealt, the menu has the felt to
     itself. */
  .fresh .play, .fresh .hint { display: none; }
  .behind .card { background-color: #7a8a7e; color: #46524a; }
  .behind .card.red { color: #7a4a4a; }
  .behind .card.down { background-color: #24476a; color: #3a5f86; }
  .behind .place, .behind .slot { background-color: #063f1e; color: #2a5a3a; }
  .behind .fan > .card:not(.down):nth-last-child(2),
  .behind .pile > .card:not(.down):nth-last-child(2),
  .behind .fan > .card:not(.down):nth-last-child(n+3),
  .behind .pile > .card:not(.down):nth-last-child(n+3) { background-color: #6f7e72; }
  .behind .bar, .behind .captions, .behind .numbers, .behind .hint, .behind .number { color: #3f6a4f; }
  .behind .bar .title, .behind .bar .win, .behind .number.drop { color: #8a7a3f; }
  .scrim { position: fixed; top: 0; left: 0; width: 100%; height: 100%;
           display: flex; align-items: center; justify-content: center; }
  dialog { display: block; width: 48ch; border: 1px solid; border-color: #ffd75f;
           background-color: #043016; color: #cfe8d8; padding: 1px 2ch; }
  dialog .ask { color: #ffd75f; font-weight: bold; }
  dialog .answers { color: #9ec5ab; padding-top: 1px; }
  dialog .answers { display: flex; flex-direction: row; }
  /* An answer is one flex item; keeping its width is what keeps its words
     on one line. */
  dialog .answers span { flex-shrink: 0; }
  .pick { color: #9ec5ab; }
  .pick.on { color: #ffd75f; font-weight: bold; }
  .pickgap { width: 3ch; }
  dialog .again { color: #7fae90; padding-top: 1px; }
  dialog .sep { white-space: pre; }
  dialog input { width: 12ch; }

  .hint { padding-top: 1px; color: #7fae90; text-align: center; }
  .hint b { color: #cfe8d8; font-weight: bold; }
  .hint kbd { color: #cfe8d8; }

  ${css(TIERS.compact)}
  @media (min-width: ${ROOMY_MIN_WIDTH}ch) { ${css(TIERS.roomy)} }
  @media (min-width: ${GRAND_MIN_WIDTH}ch) and (min-height: ${GRAND_MIN_HEIGHT}) { ${css(TIERS.grand)} }
  /* A short terminal spends its rows on the cards. */
  @media (max-height: ${HINT_MIN_HEIGHT - 1}) { .hint { display: none; } }
`;
}

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
const WEAVE = "░";
const TURN_GLYPH = "↻";
const DOT = " · ";
const MIDDOT = "·";
const STAR = "★";

/** The key hints shrink with the cards, never past their own columns. */
function deckKey(t: Tier): string {
  return t.width >= 7 ? "Space" : t.width >= 5 ? "Spc" : "\u2423";
}

function FlipKey({tier}: {tier: Tier}) {
  if (tier.width >= 7) {
    return jsx`<kbd>0</kbd>/<kbd>f</kbd>lip`;
  }
  if (tier.width >= 5) {
    return jsx`<kbd>0</kbd>/<kbd>f</kbd>`;
  }
  return jsx`<kbd>0</kbd>`;
}

/** The cells FlipKey takes, which the caption row's padding needs. */
function flipKeyLength(t: Tier): number {
  return t.width >= 7 ? 6 : t.width >= 5 ? 3 : 1;
}

/** A marked key, centered the way `centered` centers text. */
function CenteredKey({cap, width}: {cap: string; width: number}) {
  const pad = Math.max(0, width - cap.length);
  const left = Math.floor(pad / 2);
  return jsx`${" ".repeat(left)}<kbd>${cap}</kbd>${" ".repeat(pad - left)}`;
}

const ARROWS_ALL = "↑↓←→";

function blank(width: number): string {
  return " ".repeat(width);
}

/**
 * A card back: a plate with solid half-block rails around a dithered weave,
 * the way a printed back reads. A card under another shows the plate's top
 * rule, so a pile of backs is ruled lines rather than pattern noise.
 */
function backRows(width: number, height: number): string[] {
  return Array.from({length: height}, (_, row) => {
    if (row === 0) {
      return TL + T.repeat(width - 2) + TR;
    }
    if (row === height - 1) {
      return BL + B.repeat(width - 2) + BR;
    }
    return L + WEAVE.repeat(width - 2) + R;
  });
}

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
  if (!card.up) {
    return backRows(width, height);
  }
  const grid = Array.from(
    {length: height},
    () => Array.from({length: width}, () => " "),
  );
  const index = `${RANKS[card.rank - 1]}${SUITS[card.suit]}`;
  for (let i = 0; i < index.length && i < width; i++) {
    grid[0][i] = index[i];
  }
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

  held?: boolean;
  drop?: boolean;

  /** The id the focus moves to it by. A card with one can take the focus. */
  id?: string;
  onmousedown?: (event: MouseEvent) => unknown;
  onclick?: (event: MouseEvent) => unknown;
}

function CardFace({
  card,
  tier,
  held,
  drop,
  id,
  onmousedown,
  onclick,
}: CardProps) {
  const classes = ["card"];
  if (!card.up) {
    classes.push("down");
  } else if (isRed(card)) {
    classes.push("red");
  }
  if (held) {
    classes.push("held");
  } else if (drop) {
    classes.push("drop");
  }
  const rows = faceRows(card, tier);
  return jsx`
    <div
      class=${classes.join(" ")}
      id=${id}
      tabindex=${id !== undefined ? "0" : undefined}
      onmousedown=${onmousedown}
      onclick=${onclick}
    >${rows.map((row, line) => jsx`<div key=${line}>${row}</div>`)}</div>
  `;
}

/** An empty place on the board: the stock's turnover arrow, or a suit's home. */
function Slot(
  {tier, mark, drop, id, onmousedown, onclick}: {
    tier: Tier;
    mark?: string;
    drop?: boolean;
    id?: string;
    onmousedown?: (event: MouseEvent) => unknown;
    onclick?: (event: MouseEvent) => unknown;
  },
) {
  const rows = Array.from(
    {length: tier.height},
    (_, line) =>
      line === Math.floor(tier.height / 2) && mark
        ? centered(mark, tier.width)
        : blank(tier.width),
  );
  const classes = ["slot"];
  if (drop) {
    classes.push("drop");
  }
  return jsx`
    <div
      class=${classes.join(" ")}
      id=${id}
      tabindex=${id !== undefined ? "0" : undefined}
      onmousedown=${onmousedown}
      onclick=${onclick}
    >${rows.map((row, line) => jsx`<div key=${line}>${row}</div>`)}</div>
  `;
}

/** A run's clock, as a speedrunner reads it: m:ss. */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function *App(this: Context) {
  // One or three cards per turn of the stock -- chosen on the menu, kept
  // for every deal after. A deal named on the command line skips the menu:
  // that is the speedrunner's and the verifier's door.
  let mode: 1 | 3 = 1;
  let menu = startInMenu;
  // Whether a game has been dealt to go back to. The first menu has none
  // behind it; every later one has the game it was opened from.
  let dealt = !startInMenu;
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
    if (startedAt !== null && finishedAt === null) {
      // The tick changes no state; the render reads the clock itself.
      // eslint-disable-next-line crank/prefer-refresh-callback
      this.refresh();
    }
  }, 1000);
  this.cleanup(() => clearInterval(ticker));

  // A run in progress is worth a question: n, r and q open a <dialog>
  // instead of tearing the game down on one keystroke, and the dialog's
  // keys are the only ones that answer while it shows.
  let confirming: {question: string; yes: string; go: () => void} | null = null;

  const liveRun = (): boolean =>
    startedAt !== null && finishedAt === null && game.moves > 0;

  // The board is a set of places: the deck, the flip, the four homes, and
  // every card of every pile. A place has a source, what a hand would pick
  // up there, and a target, where a hand would put a card down. The state
  // of play is two things: what is held, and where the focus is. The focus
  // is the document's, held by a card's element, so there is one and every
  // input moves the same one.
  //
  // One gesture serves every input, choose(place):
  //   the focused card again          put it back, and let the focus go
  //   holding a card that fits here   put it down; nothing is focused after
  //   otherwise                       pick up what is here, and focus it
  // A click chooses the place under the pointer and Enter the focused one.
  // A number chooses a pile, with a cycle of its own. A drag is a press and
  // a release on different piles, and puts the pressed card down on the
  // second. A double-click on a pile sends its top card home.
  interface Place {
    row: "top" | "board";
    col: number;
    depth: number;
  }
  const DECK: Place = {row: "top", col: 0, depth: 0};
  const FLIP: Place = {row: "top", col: 1, depth: 0};
  const homePlace = (index: number): Place => ({
    row: "top",
    col: 3 + index,
    depth: 0,
  });
  const boardPlace = (col: number, depth = 0): Place => ({
    row: "board",
    col,
    depth,
  });

  /** The top row's occupied columns: the gap at column 2 holds nothing. */
  const TOP_COLS = [0, 1, 3, 4, 5, 6];
  const pileAt = (col: number): Card[] => game.tableau[col];
  const getLast = (pile: Card[]): number => pile.length - 1;
  const firstUp = (pile: Card[]): number => {
    const index = pile.findIndex((card) => card.up);
    return index < 0 ? getLast(pile) : index;
  };
  const topOf = (col: number): Place =>
    boardPlace(col, Math.max(0, getLast(pileAt(col))));

  const idAt = ({row, col, depth}: Place): string =>
    row === "board"
      ? `pile-${col}-${depth}`
      : col === 0 ? "deck" : col === 1 ? "flip" : `home-${col - 3}`;
  const focused = (): Place | null => {
    const id = document.activeElement?.id ?? "";
    if (id === "deck") {
      return DECK;
    }
    if (id === "flip") {
      return FLIP;
    }
    const home = /^home-(\d)$/.exec(id);
    if (home) {
      return homePlace(Number(home[1]));
    }
    const card = /^pile-(\d)-(\d+)$/.exec(id);
    if (card) {
      return boardPlace(Number(card[1]), Number(card[2]));
    }
    return null;
  };

  /** The board is rendered first, so the element is there to take the focus. */
  const seat = (place: Place): void => {
    this.refresh();
    document.getElementById(idAt(place))?.focus();
  };
  const unfocus = (): void => {
    (document.activeElement as HTMLElement | null)?.blur();
  };

  /** What a hand would pick up at a place: a card, a run, or nothing. */
  const sourceAt = (place: Place): Held => {
    if (place.row === "top") {
      if (place.col === 1) {
        return top(game.waste) ? {kind: "waste"} : null;
      }
      if (place.col >= 3) {
        const index = place.col - 3;
        return game.foundations[index].length > 0
          ? {kind: "foundation", index}
          : null;
      }
      return null;
    }
    const pile = pileAt(place.col);
    // A face-down card stands for the whole face-up stack under it.
    const index = pile[place.depth]?.up ? place.depth : firstUp(pile);
    return pile[index]?.up && isRun(pile, index)
      ? {kind: "tableau", pile: place.col, index}
      : null;
  };

  /** The place a source is picked up from: its own card, not the hit slop. */
  const placeOf = (source: Held): Place =>
    source?.kind === "tableau"
      ? boardPlace(source.pile, source.index)
      : source?.kind === "foundation" ? homePlace(source.index) : FLIP;

  /** Where a hand would put a card down at a place, or nowhere. */
  const targetAt = (place: Place): Target | null =>
    place.row === "board"
      ? {kind: "tableau", pile: place.col}
      : place.col >= 3 ? {kind: "foundation", index: place.col - 3} : null;

  const onSamePile = (a: Place, b: Place): boolean =>
    a.row === b.row && a.col === b.col;

  const isSame = (a: Held, b: Held): boolean =>
    a !== null &&
    b !== null &&
    a.kind === b.kind &&
    (a.kind !== "tableau" ||
      (b.kind === "tableau" && a.pile === b.pile && a.index === b.index));

  /** Whether a source can go on a target, by the rules of the game. */
  const fits = (source: Held, drop: Target): boolean => {
    const cards = heldCards(game, source);
    if (cards.length === 0) {
      return false;
    }
    if (drop.kind === "tableau") {
      return (
        !(source?.kind === "tableau" && source.pile === drop.pile) &&
        fitsTableau(cards[0], game.tableau[drop.pile])
      );
    }
    return (
      cards.length === 1 &&
      cards[0].suit === drop.index &&
      fitsFoundation(cards[0], game.foundations[drop.index])
    );
  };

  /** Back to the deal's opening position, clock unstarted, cursor down. */
  const reset = (number: number): void => {
    this.refresh(() => {
      if (number !== game.number) {
        best = null;
      }
      game = deal(number, mode);
      history = [];
      held = null;
      message = "";
      startedAt = null;
      finishedAt = null;
    });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const guardedReset = (number: number, label: string): void => {
    if (!liveRun()) {
      return reset(number);
    }
    this.refresh(() => {
      confirming = {
        question: "Abandon this run?",
        yes: `start ${label}`,
        go: () => reset(number),
      };
    });
  };

  /** Run a move, keeping the board undoable and the hold consistent. */
  const act = (change: (game: Game) => boolean): void => {
    const before = clone(game);
    // An illegal move is not a mistake worth a history entry.
    if (!change(game)) {
      return;
    }
    this.refresh(() => {
      history.push(before);
      if (history.length > 200) {
        history.shift();
      }
      held = null;
      message = "";
      if (startedAt === null) {
        startedAt = performance.now();
      }
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

  /** A card picked up is held and focused, wherever it was picked from. */
  const pickUp = (source: Held): void => {
    this.refresh(() => {
      held = source;
      message = "";
    });
    seat(placeOf(source));
  };

  /** A card put back lies where it was, and the focus goes with it. */
  const putBack = (): void => {
    this.refresh(() => {
      held = null;
      message = "";
    });
    unfocus();
  };

  /**
   * A card put down lands and lies still: nothing on the pile it joins is
   * focused or lifted afterwards, by mouse or by key.
   */
  const putDown = (source: Held, drop: Target): void => {
    act((game) => play(game, source, drop));
    unfocus();
  };

  /** The one gesture, at a place: put back, put down, or pick up. */
  const choose = (place: Place): void => {
    const source = sourceAt(place);
    if (held !== null) {
      if (isSame(held, source)) {
        return putBack();
      }
      const drop = targetAt(place);
      if (drop !== null && fits(held, drop)) {
        return putDown(held, drop);
      }
      // Holding something that does not go here is a change of mind.
    }
    if (source !== null) {
      pickUp(source);
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
      if (index === null) {
        continue;
      }
      act((game) => play(game, source, {kind: "foundation", index}));
      return;
    }
  };

  /**
   * Send a named suit's ready card home: the held card if it is that suit,
   * else the flip's top, else the first pile top. Where a double-click
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
  };

  const undo = (): void => {
    this.refresh(() => {
      const before = history.pop();
      if (!before) {
        return;
      }
      game = before;
      held = null;
      message = "";
    });
  };

  // The menu answers to clicks as well as keys, so its moves live here
  // rather than inside the keydown handler.

  /** The typed seed names the deal; empty or nonsense means any deal. */
  const dealFromMenu = (): void => {
    const seedField = document.getElementById("seed") as HTMLInputElement |
      null;
    const seed = Number.parseInt(seedField?.value ?? "", 10);
    menu = false;
    dealt = true;
    reset(Number.isFinite(seed) && seed > 0 ? seed : someDeal());
  };

  /** Pick a draw mode; picking the one already picked deals. */
  const pickMode = (picked: 1 | 3): void => {
    if (mode === picked) {
      return dealFromMenu();
    }
    this.refresh(() => {
      mode = picked;
    });
  };

  /** Back from the menu to the game behind it, when there is one. */
  const leaveMenu = (): void => {
    this.refresh(() => {
      menu = false;
    });
  };

  /** Answer the confirm dialog, by key or by click. */
  const answer = (yes: boolean): void => {
    const ask = confirming;
    if (!ask) {
      return;
    }
    if (yes) {
      confirming = null;
      ask.go();
    } else {
      this.refresh(() => {
        confirming = null;
      });
    }
  };

  /** Space: draw, and follow the turned card to the flip. */
  const drawTo = (): void => {
    const before = game.moves;
    act(draw);
    seat(game.moves > before && top(game.waste) ? FLIP : DECK);
  };

  /** A click on the deck: draw, and leave the focus alone. */
  const drawOnly = (): void => {
    act(draw);
    unfocus();
  };

  /**
   * A number: put what is held, or what the focus is on, down on that pile
   * when it fits. Otherwise pick up the pile's whole face-up stack, and on
   * the same number again one card fewer, down to the top card and round.
   */
  const choosePile = (pile: number): void => {
    const drop: Target = {kind: "tableau", pile};
    const cur = focused();
    const grip = held ?? (cur === null ? null : sourceAt(cur));
    if (grip !== null && fits(grip, drop)) {
      return putDown(grip, drop);
    }
    const cards = pileAt(pile);
    if (cards.length === 0) {
      return seat(boardPlace(pile));
    }
    const onPile = cur !== null && cur.row === "board" && cur.col === pile;
    const index = onPile && cur.depth < getLast(cards)
      ? cur.depth + 1
      : runStart(cards);
    pickUp({kind: "tableau", pile, index});
  };

  /**
   * The mouse. A press remembers what is under it and keeps the engine
   * from focusing it, so nothing moves before the button comes up. A
   * release on another pile puts the pressed card, or the held one, down
   * there: a drag. A click chooses the place, and a double-click on a
   * pile sends its top card home.
   */
  let pressed: {place: Place; source: Held} | null = null;
  const press = (place: Place) => (event: Event): void => {
    event.preventDefault();
    pressed = {place, source: sourceAt(place)};
  };
  const release = (place: Place) => (): void => {
    const from = pressed;
    pressed = null;
    const drop = targetAt(place);
    if (from === null || drop === null || onSamePile(from.place, place)) {
      return;
    }
    const source = from.source ?? held;
    if (source !== null && fits(source, drop)) {
      putDown(source, drop);
    }
  };
  const sendTopHome = (pile: number): void => {
    const cards = pileAt(pile);
    const last = getLast(cards);
    if (last >= 0 && cards[last].up) {
      sendHome({kind: "tableau", pile, index: last});
    }
  };

  const moveFocus = (dx: number, dy: number): void => {
    const cur = focused() ?? topOf(0);
    let next: Place = cur;
    if (dx !== 0) {
      if (cur.row === "top") {
        const at = TOP_COLS.indexOf(cur.col);
        next = {
          ...cur,
          col: TOP_COLS[(at + dx + TOP_COLS.length) % TOP_COLS.length],
        };
      } else {
        next = topOf((cur.col + dx + 7) % 7);
      }
    } else if (cur.row === "top") {
      if (dy > 0) {
        next = topOf(cur.col === 2 ? 1 : cur.col);
      }
    } else {
      const pile = pileAt(cur.col);
      if (dy < 0) {
        next = pile.length === 0 || cur.depth <= firstUp(pile)
          ? {row: "top", col: cur.col === 2 ? 1 : cur.col, depth: 0}
          : {...cur, depth: cur.depth - 1};
      } else if (cur.depth < getLast(pile)) {
        next = {...cur, depth: cur.depth + 1};
      }
    }
    seat(next);
  };

  const onkeydown = (event: KeyboardEvent): void => {
    const key = event.key;
    if (menu) {
      // While the seed field has focus, letters and digits belong to it;
      // Enter still deals. Tab and Escape leave it, and Tab goes no
      // further: the board behind the menu is not for walking.
      const typing = (event.target as Element | null)?.tagName === "INPUT";
      if (key === "Tab" || key === "Escape") {
        event.preventDefault();
        unfocus();
        return;
      }
      if (typing && key !== "Enter") {
        return;
      }
      if (key === "1" || key === "3") {
        // The number picks; the same number again deals, so the whole
        // menu answers to two fingers.
        pickMode(key === "1" ? 1 : 3);
      } else if (key === "Enter" || key === " " || key === "y") {
        dealFromMenu();
      } else if ((key === "n" || key === "b") && dealt) {
        leaveMenu();
      } else if (key === "q") {
        term.window.close();
      }
      return;
    }
    if (confirming) {
      if (key === "y" || key === "Enter") {
        answer(true);
      } else if (key === "n" || key === "Escape") {
        answer(false);
      }
      return;
    }
    switch (key) {
      case "q":
        if (!liveRun()) {
          return term.window.close();
        }
        return this.refresh(() => {
          confirming = {
            question: "Quit in the middle of a run?",
            yes: "quit",
            go: () => term.window.close(),
          };
        });
      case "n":
        return this.refresh(() => {
          menu = true;
        });
      case "r":
        return guardedReset(game.number, "this deal again");
      case "u":
        return undo();
      case "Escape":
        // Lets go of what is held; the focus stays where it is.
        return this.refresh(() => {
          held = null;
          message = "";
        });
      case " ":
        return drawTo();
      case "f":
      case "0":
        return choose(FLIP);
      case "s":
      case "h":
      case "d":
      case "c":
        sendSuit({s: 0, h: 1, d: 2, c: 3}[key]!);
        return unfocus();
      case "a":
        return act((game) => autoplay(game) > 0);
      // Tab is the engine's: it walks the focusable cards in document order.
      case "ArrowUp":
        return moveFocus(0, -1);
      case "ArrowDown":
        return moveFocus(0, 1);
      case "ArrowLeft":
        return moveFocus(-1, 0);
      case "ArrowRight":
        return moveFocus(1, 0);
      case "Enter": {
        // Until something takes the focus, Enter draws -- the typing
        // player's right hand never leaves home row -- and puts the focus
        // on the deck, where a second Enter draws again.
        const cur = focused();
        if (cur === null) {
          act(draw);
          return seat(DECK);
        }
        if (onSamePile(cur, DECK)) {
          return act(draw);
        }
        return choose(cur);
      }
      default:
        if (key >= "1" && key <= "7") {
          choosePile(Number(key) - 1);
        }
    }
  };
  document.addEventListener("keydown", onkeydown);
  this.cleanup(() => document.removeEventListener("keydown", onkeydown));

  // Read through a call, so the render below sees what the closures above
  // assign rather than the null this was declared with.
  const holding = (): Held => held;
  const asking = (): typeof confirming => confirming;
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
  term.window.addEventListener("resize", retier);
  this.cleanup(() => {
    roomy.removeEventListener("change", retier);
    grand.removeEventListener("change", retier);
    term.window.removeEventListener("resize", retier);
  });
  const tier = (): Tier =>
    grand.matches ? TIERS.grand : roomy.matches ? TIERS.roomy : TIERS.compact;

  for ({} of this) {
    const t = tier();
    // The board holds the tallest pile the rules allow, six face-down cards
    // under a king-to-ace run, so a growing pile never pushes the hint
    // down or the felt past the screen. A short terminal gets what is
    // left after the rows above and below.
    // One row more than the cards, for the focused one to step down into.
    const topRows = t.height + 1;
    const boardRows = Math.max(
      t.height,
      Math.min(19 + t.height, term.window.innerHeight - (8 + topRows)),
    );
    const grip = holding();
    const ask = asking();
    const carrying = heldCards(game, grip);
    const card = carrying[0];
    const wasteTop = top(game.waste);
    const home = card ? foundationFor(game, card) : null;

    yield jsx`
      <div class=${inMenu() && !dealt ? "table fresh" : inMenu() || ask ? "table behind" : "table"}>
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
            won(game) ? jsx`<span class="win">Won${message ? ` ${MIDDOT} ${message}` : ""}</span>` : message && jsx`<span class="score">${message}</span>`
          }
        </div>

        <div class="captions">
          <span class="caption"><kbd>${deckKey(t)}</kbd>${blank(Math.max(0, t.width - deckKey(t).length))}</span>
          <span class="caption"><${FlipKey} tier=${t} /></span>
          <span class="caption">${blank(2 * t.width - flipKeyLength(t))}</span>
          <span class="caption"><${CenteredKey} cap="s" width=${t.width} /></span>
          <span class="caption"><${CenteredKey} cap="h" width=${t.width} /></span>
          <span class="caption"><${CenteredKey} cap="d" width=${t.width} /></span>
          <span class="caption"><${CenteredKey} cap="c" width=${t.width} /></span>
        </div>
        <div class="top" style=${`min-height: ${topRows}px`}>
          <div class="pile">
            <div class="place"></div>
            ${
              game.stock.length > 0
                ? jsx`<${CardFace}
                    card=${{rank: 1, suit: 0, up: false}}
                    tier=${t}
                    id="deck"
                    onmousedown=${press(DECK)}
                    onclick=${drawOnly}
                  />`
                : jsx`<${Slot} tier=${t} mark=${TURN_GLYPH}
                    id="deck" onmousedown=${press(DECK)} onclick=${drawOnly} />`
            }
          </div>
          <div
            class="pile"
            ondblclick=${() => wasteTop && sendHome({kind: "waste"})}
          >
            <div class="place"></div>
            ${
              wasteTop
                ? jsx`<div class="fan">${game.waste.slice(-(game.draw === 3 ? 3 : 1)).map(
                  (card, at, fan) => jsx`<${CardFace}
                        key=${`${card.suit}-${card.rank}`}
                        card=${card}
                        tier=${t}
                        held=${at === fan.length - 1 && grip?.kind === "waste"}
                        id=${at === fan.length - 1 ? "flip" : undefined}
                        onmousedown=${at === fan.length - 1 ? press(FLIP) : undefined}
                        onclick=${at === fan.length - 1 ? () => choose(FLIP) : undefined}
                      />`,
                )}</div>`
                : jsx`<${Slot} tier=${t} />`
            }
          </div>
          <div class="gap"></div>
          ${game.foundations.map((foundation, index) => jsx`
              <div
                class="pile"
                key=${`foundation-${index}`}
                onmouseup=${release(homePlace(index))}
              >
                <div class="place"></div>
                ${
                  top(foundation)
                    ? jsx`<${CardFace}
                        card=${top(foundation)}
                        tier=${t}
                        held=${grip?.kind === "foundation" && grip.index === index}
                        drop=${home === index}
                        id=${`home-${index}`}
                        onmousedown=${press(homePlace(index))}
                        onclick=${() => choose(homePlace(index))}
                      />`
                    : jsx`<${Slot}
                        tier=${t}
                        mark=${SUITS[index]}
                        id=${card ? `home-${index}` : undefined}
                        drop=${home === index}
                        onmousedown=${press(homePlace(index))}
                        onclick=${() => choose(homePlace(index))}
                      />`
                }
              </div>
            `)}
        </div>

        <div class="numbers">
          ${game.tableau.map((pile, index) => jsx`
              <span
                class=${Boolean(card) && fitsTableau(card, pile) ? "number drop" : "number"}
                key=${`number-${index}`}
              ><${CenteredKey} cap=${String(index + 1)} width=${t.width} /></span>
            `)}
        </div>
        <div class="board" style=${`min-height: ${boardRows}px`}>
          ${game.tableau.map((pile, index) => jsx`
              <div
                class="pile"
                key=${`pile-${index}`}
                onmouseup=${release(boardPlace(index))}
                ondblclick=${() => sendTopHome(index)}
              >
                <div class="place"></div>
                ${
                  pile.length === 0
                    ? jsx`<${Slot}
                        tier=${t}
                        drop=${Boolean(card) && fitsTableau(card, pile)}
                        id=${card ? `pile-${index}-0` : undefined}
                        onmousedown=${press(boardPlace(index))}
                        onclick=${() => choose(boardPlace(index))}
                      />`
                    : pile.map((each, depth) => jsx`
                          <${CardFace}
                            key=${`${each.suit}-${each.rank}`}
                            card=${each}
                            tier=${t}
                            id=${each.up ? `pile-${index}-${depth}` : undefined}
                            held=${grip?.kind === "tableau" && grip.pile === index && depth >= grip.index}
                            drop=${depth === pile.length - 1 && Boolean(card) && fitsTableau(card, pile)}
                            onmousedown=${press(boardPlace(index, depth))}
                            onclick=${() => choose(boardPlace(index, depth))}
                          />
                        `)
                }
              </div>
            `)}
        </div>

        </div>
        ${
          inMenu() && jsx`<div class="scrim">
            <dialog open>
              <div class="ask">Solitaire ${MIDDOT} new game</div>
              <div class="answers">
                <span
                  class=${modeNow() === 1 ? "pick on" : "pick"}
                  onclick=${() => pickMode(1)}
                ><kbd>1</kbd>${" one card"}</span>
                <span class="pickgap"> </span>
                <span
                  class=${modeNow() === 3 ? "pick on" : "pick"}
                  onclick=${() => pickMode(3)}
                ><kbd>3</kbd>${" three cards"}</span>
              </div>
              <div class="again">(press <kbd>${modeNow()}</kbd> again to deal)</div>
              <div class="answers">seed${" #"}<input id="seed" type="number" min="1" placeholder="random" /></div>
              <div class="answers"><span onclick=${dealFromMenu}><kbd>Enter</kbd>${" deal"}</span>${
                dealt ? jsx`<span class="sep">${` ${MIDDOT} `}</span><span onclick=${leaveMenu}><kbd>b</kbd>ack</span>` : ""
              }<span class="sep">${` ${MIDDOT} `}</span><span onclick=${() => term.window.close()}><kbd>q</kbd>uit</span></div>
            </dialog>
          </div>`
        }
        ${
          ask && jsx`<div class="scrim">
            <dialog open>
              <div class="ask">${ask.question}</div>
              <div class="answers"><span onclick=${() => answer(true)}><kbd>y</kbd> ${ask.yes}</span><span class="sep">${` ${MIDDOT} `}</span><span onclick=${() => answer(false)}><kbd>n</kbd> keep playing</span></div>
            </dialog>
          </div>`
        }
        <div class="hint"><b>${ARROWS_ALL}</b>/<kbd>Tab</kbd> move${DOT}<kbd>Enter</kbd> take/place${DOT}<kbd>a</kbd>uto${DOT}<kbd>u</kbd>ndo${DOT}<kbd>n</kbd>ew${DOT}<kbd>r</kbd>etry${DOT}<kbd>q</kbd>uit</div>
      </div>
    `;
  }
}

export function mount(host: TermDOM, options: {deal?: number} = {}): void {
  term = host;
  term.attach();
  ({document} = term);
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
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const argument = Number(process.argv[2]);
  mount(
    new TermDOM(),
    Number.isFinite(argument) && argument > 0 ? {deal: argument} : {},
  );
}
