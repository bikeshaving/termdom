#!/usr/bin/env node
// Klondike solitaire, drawn as a web page and rendered to the terminal. The
// board is a flex row of flex columns, a card is a styled <span>, and every
// move is a click or a keystroke on it.
//
//   node examples/solitaire.ts
//
//   space  deal from the stock (or turn it over when empty)
//   1-7    pick up a tableau pile, or drop what you are holding on it
//   w      pick up the waste's top card
//   up/dn  take more or fewer cards of the run you are holding
//   f      send what you are holding to its foundation
//   a      send everything that fits to the foundations
//   esc    put it back      u  undo      n  new game      q  quit
//
// Clicking does the same: a card picks up, a pile drops, the stock deals, and
// a double-click sends a card home.
import {TermDOM} from "@b9g/termdom";
import type {Context} from "@b9g/crank";
import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";

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

const isRed = (card: Card): boolean => card.suit === 1 || card.suit === 2;

interface Game {
	/** The deal this game was shuffled from. */
	number: number;
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
function deal(number: number): Game {
	const deck = shuffled(number);
	const tableau: Card[][] = [];
	for (let pile = 0; pile < 7; pile++) {
		const cards = deck.splice(0, pile + 1);
		cards[cards.length - 1].up = true;
		tableau.push(cards);
	}
	return {
		number,
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
	for (let index = 0; index < 4; index++) {
		if (fitsFoundation(card, game.foundations[index])) return index;
	}
	return null;
}

/** Turn a card from the stock, or turn the whole waste back over. */
function draw(game: Game): boolean {
	if (game.stock.length > 0) {
		const card = game.stock.pop()!;
		card.up = true;
		game.waste.push(card);
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

// `node examples/solitaire.ts 4242` deals game 4242 again.
const argument = Number(process.argv[2]);
const opening =
	Number.isFinite(argument) && argument > 0 ? argument : someDeal();

const term = new TermDOM();
term.attach();
const {document} = term;
globalThis.Node = term.window.Node;
globalThis.document = term.document;

const style = document.createElement("style");
style.textContent = `
  .table { padding: 0 1ch; background-color: #06421f; color: #cfe8d8; }
  .bar { display: flex; flex-direction: row; gap: 2ch; }
  .bar .title { color: #ffd75f; font-weight: bold; }
  .bar .score { color: #9ec5ab; }
  .bar .win { color: #ffd75f; font-weight: bold; }

  .top { display: flex; flex-direction: row; gap: 1ch; padding-top: 1px; }
  /* The gap the classic deal leaves between the talon and the foundations. */
  .top .gap { width: 5ch; }
  /* The keys the piles answer to, over the piles they answer for. */
  .numbers { display: flex; flex-direction: row; gap: 1ch; padding-top: 1px; }
  .number { width: 4ch; color: #4d8f66; }
  .number.drop { color: #ffd75f; font-weight: bold; }
  .board { display: flex; flex-direction: row; gap: 1ch; }
  .pile { display: flex; flex-direction: column; width: 4ch; }

  .card { width: 4ch; background-color: #f0f0e6; color: #202020; }
  .card.red { color: #c02020; }
  .card.down { background-color: #1d4f8f; color: #4f82c8; }
  /* What you are holding, and where it can go. */
  .card.held, .slot.held { background-color: #ffd75f; color: #202020; font-weight: bold; }
  .slot { width: 4ch; color: #2f7a4a; }
  .slot.drop, .card.drop { color: #ffd75f; }

  .hint { padding-top: 1px; color: #7fae90; }
  .hint b { color: #cfe8d8; font-weight: bold; }
`;
document.head.appendChild(style);

// ---- the board ---------------------------------------------------------------

interface CardProps {
	card: Card;
	held?: boolean;
	drop?: boolean;
	onclick?: (event: MouseEvent) => unknown;
	ondblclick?: (event: MouseEvent) => unknown;
}

function CardFace({card, held, drop, onclick, ondblclick}: CardProps) {
	if (!card.up) {
		return jsx`
			<span class="card down" onclick=${onclick}>▒▒▒▒</span>
		`;
	}
	const classes = ["card"];
	if (isRed(card)) classes.push("red");
	if (held) classes.push("held");
	else if (drop) classes.push("drop");
	// Two columns for the rank keeps the ten from shunting the suit along.
	const text = `${RANKS[card.rank - 1].padStart(2, " ")}${SUITS[card.suit]} `;
	return jsx`
		<span
			class=${classes.join(" ")}
			onclick=${onclick}
			ondblclick=${ondblclick}
		>${text}</span>
	`;
}

/** An empty place on the board: the stock's turnover arrow, or a suit's home. */
function Slot({
	text,
	drop,
	onclick,
}: {
	text: string;
	drop?: boolean;
	onclick?: (event: MouseEvent) => unknown;
}) {
	return jsx`
		<span class=${drop ? "slot drop" : "slot"} onclick=${onclick}>${text}</span>
	`;
}

function* App(this: Context) {
	let game = deal(opening);
	let held: Held = null;
	let history: Game[] = [];
	let message = "";

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

	/** Take more or fewer cards of the run being held. */
	const reach = (delta: number): void => {
		const grip = held;
		if (grip?.kind !== "tableau") return;
		const index = grip.index + delta;
		if (!isRun(game.tableau[grip.pile], index)) return;
		this.refresh(() => {
			held = {kind: "tableau", pile: grip.pile, index};
		});
	};

	const onkeydown = (event: KeyboardEvent): void => {
		const key = event.key;
		if (key === "q") {
			term.window.close();
			return;
		}
		if (key === "n") {
			this.refresh(() => {
				game = deal(someDeal());
				history = [];
				held = null;
				message = "";
			});
			return;
		}
		if (key === "u") return undo();
		if (key === "Escape") {
			this.refresh(() => {
				held = null;
				message = "";
			});
			return;
		}
		if (key === " ")
			return act(draw, "The stock and the waste are both empty.");
		if (key === "w") {
			if (top(game.waste)) grab({kind: "waste"});
			return;
		}
		if (key === "f") return sendHome();
		if (key === "a") {
			act((game) => autoplay(game) > 0, "Nothing is ready for a foundation.");
			return;
		}
		if (key === "ArrowUp") return reach(-1);
		if (key === "ArrowDown") return reach(1);
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

	// eslint-disable-next-line no-empty-pattern
	for ({} of this) {
		const grip = holding();
		const carrying = heldCards(game, grip);
		const card = carrying[0];
		const wasteTop = top(game.waste);
		const home = card ? foundationFor(game, card) : null;

		yield jsx`
			<div class="table">
				<div class="bar">
					<span class="title">Solitaire</span>
					<span class="score">deal ${game.number}</span>
					<span class="score">
						${game.moves} ${game.moves === 1 ? "move" : "moves"}
					</span>
					${
						won(game)
							? jsx`<span class="win">You win. Press n for a new deal.</span>`
							: message && jsx`<span class="score">${message}</span>`
					}
				</div>

				<div class="top">
					<div class="pile">
						${
							game.stock.length > 0
								? jsx`<${CardFace}
										card=${{rank: 1, suit: 0, up: false}}
										onclick=${() => act(draw)}
									/>`
								: jsx`<${Slot} text="  ↻ " onclick=${() => act(draw)} />`
						}
					</div>
					<div class="pile">
						${
							wasteTop
								? jsx`<${CardFace}
										card=${wasteTop}
										held=${grip?.kind === "waste"}
										onclick=${() => grab({kind: "waste"})}
										ondblclick=${() => sendHome({kind: "waste"})}
									/>`
								: jsx`<${Slot} text="    " />`
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
												held=${grip?.kind === "foundation" && grip.index === index}
												drop=${home === index}
												onclick=${() => target({kind: "foundation", index})}
											/>`
										: jsx`<${Slot}
												text=${`  ${SUITS[index]} `}
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
							>${`  ${index + 1} `}</span>
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
												text="    "
												drop=${Boolean(card) && fitsTableau(card, pile)}
												onclick=${() => target({kind: "tableau", pile: index})}
											/>`
										: pile.map(
												(each, depth) => jsx`
													<${CardFace}
														key=${`${each.suit}-${each.rank}`}
														card=${each}
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

				<div class="hint"><b>space</b> deal · <b>1-7</b> pile · <b>w</b> waste · <b>↑↓</b> reach · <b>f</b> home · <b>a</b> auto · <b>u</b> undo · <b>n</b> new · <b>q</b> quit</div>
			</div>
		`;
	}
}

renderer.render(jsx`<${App} />`, document.body);
