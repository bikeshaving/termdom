// Hacker News as a page: the front page from the Algolia API, and a story's
// comment thread rendered from the HTML the API hands back.
//
//   node examples/hacker-news.ts
//
//   j/k or up/down     move           Enter / l    read the comments
//   h / left           fold a reply   Backspace    back to the front page
//   l / right          unfold         space/f/b    page the thread
//   g / G              ends           r            reload
//   q                  quit
//   a click picks a story or a comment; picking a story opens it
//
// In a thread, h folds the comment under the cursor. On a comment that is
// folded already, or that has no replies, h steps up to the parent.
//
// The page takes the alternate screen, where Escape belongs to the terminal:
// it drops the reader back into the scrollback, and the document keeps
// rendering there in flow.
import {TermDOM} from "@b9g/termdom";

const API = "https://hn.algolia.com/api/v1";
const STORY_COUNT = 30;

// The front_page tag names everything that has been on the front page, which
// reaches back months. A three-day window is what is on it now.
const WINDOW_SECONDS = 3 * 24 * 60 * 60;

// The thread arrives whole, and a busy story carries a thousand comments.
// Past this many the reader stops building rows and says so.
const COMMENT_LIMIT = 250;

// Past this depth replies stop stepping right, so a long argument still
// leaves room for words at eighty columns.
const INDENT_LIMIT = 6;

// A job post carries no points, no author and no comment count, so the
// fields the meta line reads are optional.
interface Hit {
	title: string;
	url: string | null;
	points?: number;
	author?: string;
	num_comments?: number;
	created_at_i: number;
}

// The search calls a story's id objectID; the item endpoint wants it in a
// path. Everything below this line calls it id.
type Story = Hit & {id: string};

interface Item {
	id: number;
	author: string | null;
	text: string | null;
	created_at_i: number;
	children?: Item[];
}

const term = new TermDOM();
term.attach();
const {document, window} = term;

const style = document.createElement("style");
style.textContent = `
	.masthead {
		display: flex;
		flex-direction: row;
		justify-content: space-between;
		background-color: #ff6600;
		/* Near-black rather than black: the engine reads #000000 as the
		   terminal's default color, which on a dark theme is not dark. */
		color: #1a1a1a;
		font-weight: bold;
		padding: 0 1ch;
	}
	.masthead .y { background-color: #ffffff; color: #ff6600; }
	.masthead .count { font-weight: normal; }
	/* The reader fills the screen and scrolls its content; the bar sits on
	   the last row and stays there while the content scrolls under it. */
	.reader { overflow-y: auto; }
	.hint {
		position: fixed;
		bottom: 0;
		left: 0;
		width: 100%;
		background-color: #262626;
		color: #9e9e9e;
		padding: 0 1ch;
	}

	.story { padding: 0 1ch; }
	.headline { display: flex; flex-direction: row; }
	.headwords { flex-grow: 1; }
	.story .rank { width: 4ch; flex-shrink: 0; color: #828282; }
	.story .title { display: inline; }
	.story .domain { display: inline; color: #828282; }
	.story .meta { color: #828282; padding-left: 4ch; }
	.story.on { background-color: #33291a; }
	.story.on .rank { color: #ff6600; font-weight: bold; }
	.story.on .title { color: #ffffff; font-weight: bold; }

	.head { padding: 0 1ch; margin-bottom: 1px; }
	.head .title { color: #ff6600; font-weight: bold; }
	.head .link { color: #6699cc; }
	.head .meta { color: #828282; }

	.comment { padding: 0 1ch; margin-top: 1px; }
	.thread { border-left: 1px solid #3a3a3a; padding-left: 1ch; }
	.byline { color: #828282; }
	.byline .who { color: #b0b0b0; }
	.byline .fold { color: #666666; }
	.gone { color: #555555; }
	.comment.on { background-color: #33291a; }
	.comment.on .thread { border-left: 1px solid #ff6600; }
	.comment.on .who { color: #ffffff; font-weight: bold; }

	/* The comment body is HN's own markup: paragraphs, links, italics and
	   the occasional code block, parsed and laid out as it stands. */
	.body p { margin-top: 1px; }
	.body a { color: #6699cc; }
	.body i { font-style: italic; }
	.body code { color: #ff8c69; }
	/* HN quotes code and long quotations in pre; wrapping keeps them on
	   screen instead of running off the right edge. */
	.body pre {
		background-color: #1c1c1c;
		color: #d0d0d0;
		padding: 0 1ch;
		white-space: pre-wrap;
	}
	.body pre code { color: inherit; }

	.message { padding: 0 1ch; margin-top: 1px; }
	.message.loading { color: #828282; }
	.message.error { color: #ff5f5f; }
`;
document.head.appendChild(style);

const masthead = document.createElement("div");
masthead.className = "masthead";
const brand = document.createElement("span");
const logo = document.createElement("span");
logo.className = "y";
logo.textContent = "Y";
const name = document.createElement("span");
name.textContent = " Hacker News";
brand.append(logo, name);
const count = document.createElement("span");
count.className = "count";
masthead.append(brand, count);

const hint = document.createElement("div");
hint.className = "hint";
const listView = document.createElement("div");
const readerView = document.createElement("div");
readerView.style.display = "none";
// The reader takes the screen: the alternate screen keeps a thread out of
// the scrollback and hands the whole terminal to the page. The content
// scrolls its content; the fixed bar stays on the last row.
const reader = document.createElement("div");
reader.className = "reader";
reader.append(masthead, listView, readerView, hint);
document.body.appendChild(reader);
void reader.requestFullscreen();

const LIST_KEYS = " j/k move · enter comments · g/G ends · r reload · q quit";
const READER_KEYS =
	" j/k move · h/l fold · space page · backspace back · r reload · q quit";

function message(kind: string, text: string): HTMLElement {
	const div = document.createElement("div");
	div.className = `message ${kind}`;
	div.textContent = text;
	return div;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** How long ago, in the coarsest unit that still says something. */
function age(created: number): string {
	const minutes = Math.max(0, Math.round(Date.now() / 1000 - created) / 60);
	if (minutes < 60) {
		return `${plural(Math.round(minutes), "minute")} ago`;
	}
	const hours = minutes / 60;
	if (hours < 24) {
		return `${plural(Math.round(hours), "hour")} ago`;
	}
	return `${plural(Math.round(hours / 24), "day")} ago`;
}

/** Points, author, age and comment count, minus whatever the story lacks. */
function metaText(story: Story): string {
	const parts: string[] = [];
	if (story.points !== undefined) {
		parts.push(plural(story.points, "point"));
	}
	if (story.author) {
		parts.push(`by ${story.author}`);
	}
	parts.push(age(story.created_at_i));
	if (story.num_comments) {
		parts.push(`· ${plural(story.num_comments, "comment")}`);
	}
	return parts.join(" ");
}

function domainOf(url: string | null): string {
	if (!url) {
		return "";
	}
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch (_err) {
		return "";
	}
}

let stories: Story[] = [];
let selected = 0;
let reading: Story | null = null;
// Bumped by anything that changes what the screen is for, so a fetch that
// lands after the reader has moved on paints nothing.
let generation = 0;

// The thread in reading order, the ids of the comments whose replies are
// folded away, the thread positions the screen is showing, and the cursor
// as an offset into that showing list.
let thread: Array<[Item, number]> = [];
const folded = new Set<number>();
let showing: number[] = [];
let picked = 0;

/** Whichever list the cursor is walking: stories, or the comments on screen. */
function rows(): HTMLElement[] {
	const view = reading ? readerView : listView;
	const selector = reading ? ".comment" : ".story";
	return Array.from(view.querySelectorAll<HTMLElement>(selector));
}

function cursor(): number {
	return reading ? picked : selected;
}

function makeRow(story: Story, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "story";
	// The rank is its own flex column so a title that wraps hangs under
	// itself rather than under the number.
	const headline = document.createElement("div");
	headline.className = "headline";
	const rank = document.createElement("span");
	rank.className = "rank";
	rank.textContent = `${String(index + 1).padStart(2)}.`;
	const headwords = document.createElement("span");
	headwords.className = "headwords";
	const title = document.createElement("span");
	title.className = "title";
	title.textContent = story.title;
	headwords.appendChild(title);
	const domain = domainOf(story.url);
	if (domain) {
		const site = document.createElement("span");
		site.className = "domain";
		site.textContent = ` (${domain})`;
		headwords.appendChild(site);
	}
	headline.append(rank, headwords);
	const meta = document.createElement("div");
	meta.className = "meta";
	meta.textContent = metaText(story);
	row.append(headline, meta);
	return row;
}

function select(index: number): void {
	const all = rows();
	const at = Math.max(0, Math.min(index, all.length - 1));
	if (reading) {
		picked = at;
	} else {
		selected = at;
	}
	all.forEach((row, i) => row.classList.toggle("on", i === at));
	count.textContent = all.length ? `${at + 1}/${all.length}` : "";
}

/** The rows above the bar, which holds the last one. */
function page(): number {
	return Math.max(1, window.innerHeight - 1);
}

/**
 * Scroll the reader the least it takes to bring a row above the bar.
 * scrollIntoView reveals to the screen edge, where the bar would cover the
 * row, so the last row is reserved here instead.
 */
function reveal(row: HTMLElement): void {
	const rect = row.getBoundingClientRect();
	if (rect.top < 0) {
		reader.scrollBy(0, rect.top);
	} else if (rect.bottom > page()) {
		reader.scrollBy(0, rect.bottom - page());
	}
}

function refresh(): void {
	// At the first row, pull the reader the rest of the way up so the
	// masthead shows too -- a reveal alone stops below it.
	if (cursor() === 0) {
		reader.scrollTo(0, 0);
		return;
	}
	const row = rows()[cursor()];
	if (row) {
		reveal(row);
	}
}

async function loadStories(): Promise<void> {
	const mine = ++generation;
	reading = null;
	readerView.style.display = "none";
	listView.style.display = "";
	hint.textContent = LIST_KEYS;
	count.textContent = "";
	listView.replaceChildren(message("loading", "loading the front page…"));
	reader.scrollTo(0, 0);
	try {
		const since = Math.round(Date.now() / 1000) - WINDOW_SECONDS;
		const response = await fetch(
			`${API}/search?tags=front_page&hitsPerPage=${STORY_COUNT}` +
			`&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`,
		);
		if (!response.ok) {
			throw new Error(`the API answered ${response.status}`);
		}
		const data = (await response.json()) as {
			hits: Array<Hit & Record<"objectID", string>>;
		};
		if (mine !== generation) {
			return;
		}
		stories = (data.hits ?? []).map((hit) => ({...hit, id: hit.objectID}));
		if (!stories.length) {
			listView.replaceChildren(
				message("error", "the front page came back empty"),
			);
			return;
		}
		listView.replaceChildren(...stories.map(makeRow));
		select(Math.min(selected, stories.length - 1));
		refresh();
	} catch (_err) {
		if (mine === generation) {
			listView.replaceChildren(
				message(
					"error",
					"the front page is unreachable — press r to try again",
				),
			);
		}
	}
}

function storyHead(story: Story): HTMLElement {
	const head = document.createElement("div");
	head.className = "head";
	const title = document.createElement("div");
	title.className = "title";
	title.textContent = story.title;
	head.appendChild(title);
	if (story.url) {
		const link = document.createElement("div");
		link.className = "link";
		link.textContent = story.url;
		head.appendChild(link);
	}
	const meta = document.createElement("div");
	meta.className = "meta";
	meta.textContent = metaText(story);
	head.appendChild(meta);
	return head;
}

/** The thread in reading order, each reply paired with its depth. */
function flatten(item: Item, depth: number, out: Array<[Item, number]>): void {
	for (const child of item.children ?? []) {
		if (out.length >= COMMENT_LIMIT) {
			return;
		}
		out.push([child, depth]);
		flatten(child, depth + 1, out);
	}
}

/** How many replies hang under a thread position, down to the last of them. */
function replyCount(at: number): number {
	const depth = thread[at][1];
	let n = 0;
	for (let i = at + 1; i < thread.length && thread[i][1] > depth; i++) {
		n++;
	}
	return n;
}

/** The thread position a reply hangs from, or -1 at the top of the thread. */
function parentOf(at: number): number {
	const depth = thread[at][1];
	for (let i = at - 1; i >= 0; i--) {
		if (thread[i][1] < depth) {
			return i;
		}
	}
	return -1;
}

/** The thread minus the replies under folded comments, in reading order. */
function unfolded(): number[] {
	const out: number[] = [];
	// Depth of the folded comment whose replies are being skipped, or -1
	// while nothing is being skipped.
	let under = -1;
	for (let i = 0; i < thread.length; i++) {
		const depth = thread[i][1];
		if (under >= 0 && depth > under) {
			continue;
		}
		under = -1;
		out.push(i);
		if (folded.has(thread[i][0].id)) {
			under = depth;
		}
	}
	return out;
}

function makeComment(item: Item, depth: number, hidden: number): HTMLElement {
	const comment = document.createElement("div");
	comment.className = "comment";
	comment.style.paddingLeft = `${1 + Math.min(depth, INDENT_LIMIT) * 2}ch`;
	const rail = document.createElement("div");
	rail.className = "thread";
	const byline = document.createElement("div");
	byline.className = "byline";
	if (item.author) {
		const who = document.createElement("span");
		who.className = "who";
		who.textContent = item.author;
		const when = document.createElement("span");
		when.textContent = ` · ${age(item.created_at_i)}`;
		byline.append(who, when);
	} else {
		byline.classList.add("gone");
		byline.textContent = "[deleted]";
	}
	if (hidden > 0) {
		const marker = document.createElement("span");
		marker.className = "fold";
		marker.textContent = ` [+${hidden}]`;
		byline.appendChild(marker);
	}
	rail.appendChild(byline);
	if (item.text) {
		const body = document.createElement("div");
		body.className = "body";
		body.innerHTML = item.text;
		rail.appendChild(body);
	}
	comment.appendChild(rail);
	return comment;
}

/**
 * Repaints the thread from the fold state and puts the cursor back on the
 * comment at `target`, or on the nearest parent still on screen.
 */
function paintThread(story: Story, target: number): void {
	showing = unfolded();
	const parts: HTMLElement[] = [storyHead(story)];
	if (!thread.length) {
		parts.push(message("loading", "no comments yet"));
	}
	for (const at of showing) {
		const [item, depth] = thread[at];
		parts.push(
			makeComment(item, depth, folded.has(item.id) ? replyCount(at) : 0),
		);
	}
	if (thread.length >= COMMENT_LIMIT) {
		parts.push(message("loading", `the first ${COMMENT_LIMIT} comments`));
	}
	readerView.replaceChildren(...parts);
	let at = target;
	while (at >= 0 && !showing.includes(at)) {
		at = parentOf(at);
	}
	select(Math.max(0, showing.indexOf(at)));
	refresh();
}

function unfold(story: Story): void {
	const at = showing[picked];
	if (at === undefined || !folded.has(thread[at][0].id)) {
		return;
	}
	folded.delete(thread[at][0].id);
	paintThread(story, at);
}

function fold(story: Story): void {
	const at = showing[picked];
	if (at === undefined) {
		return;
	}
	const id = thread[at][0].id;
	if (!folded.has(id) && replyCount(at) > 0) {
		folded.add(id);
		paintThread(story, at);
		return;
	}
	const parent = parentOf(at);
	if (parent >= 0) {
		select(showing.indexOf(parent));
		refresh();
	}
}

async function openThread(story: Story): Promise<void> {
	const mine = ++generation;
	reading = story;
	thread = [];
	showing = [];
	picked = 0;
	folded.clear();
	listView.style.display = "none";
	readerView.style.display = "";
	hint.textContent = READER_KEYS;
	count.textContent = plural(story.num_comments ?? 0, "comment");
	readerView.replaceChildren(
		storyHead(story),
		message("loading", "loading the comments…"),
	);
	reader.scrollTo(0, 0);
	try {
		const response = await fetch(`${API}/items/${story.id}`);
		if (!response.ok) {
			throw new Error(`the API answered ${response.status}`);
		}
		const item = (await response.json()) as Item;
		if (mine !== generation) {
			return;
		}
		thread = [];
		flatten(item, 0, thread);
		paintThread(story, 0);
		reader.scrollTo(0, 0);
	} catch (_err) {
		if (mine === generation) {
			readerView.replaceChildren(
				storyHead(story),
				message("error", "the comments are unreachable — press r to try again"),
			);
		}
	}
}

function back(): void {
	generation++;
	reading = null;
	readerView.style.display = "none";
	listView.style.display = "";
	hint.textContent = LIST_KEYS;
	// The thread left the reader deep in its own rows; the front page starts
	// from its masthead and comes down to the story that was open.
	reader.scrollTo(0, 0);
	select(selected);
	refresh();
}

// Escape is the terminal's key, and it drops the page out of the alternate
// screen. Back at the top, the document prints into the scrollback from its
// first row.
document.addEventListener("fullscreenchange", () => {
	if (!document.fullscreenElement) {
		reader.scrollTo(0, 0);
	}
});

// A narrower terminal rewraps into more rows, a shorter one shows fewer:
// either way the reader re-aims at the row under the cursor.
window.addEventListener("resize", () => {
	refresh();
});

document.addEventListener("keydown", (event: Event) => {
	const key = (event as KeyboardEvent).key;
	if (key === "q") {
		term.window.close();
		return;
	}
	if (reading) {
		if (key === "Backspace") {
			back();
		} else if (key === "r") {
			void openThread(reading);
		} else if (key === "j" || key === "ArrowDown") {
			select(picked + 1);
			refresh();
		} else if (key === "k" || key === "ArrowUp") {
			select(picked - 1);
			refresh();
		} else if (key === "h" || key === "ArrowLeft") {
			fold(reading);
		} else if (key === "l" || key === "ArrowRight") {
			unfold(reading);
		} else if (key === " " || key === "f" || key === "PageDown") {
			reader.scrollBy(0, page());
		} else if (key === "b" || key === "PageUp") {
			reader.scrollBy(0, -page());
		} else if (key === "g") {
			select(0);
			refresh();
		} else if (key === "G") {
			select(rows().length - 1);
			refresh();
		}
		return;
	}
	if (key === "r") {
		void loadStories();
	} else if (key === "j" || key === "ArrowDown") {
		select(selected + 1);
		refresh();
	} else if (key === "k" || key === "ArrowUp") {
		select(selected - 1);
		refresh();
	} else if (key === "g") {
		select(0);
		refresh();
	} else if (key === "G") {
		select(rows().length - 1);
		refresh();
	} else if (key === "Enter" || key === "l" || key === "ArrowRight") {
		const story = stories[selected];
		if (story) {
			void openThread(story);
		}
	}
});

document.addEventListener("click", (event: Event) => {
	const target = event.target as Element;
	if (reading) {
		const comment = target.closest(".comment") as HTMLElement | null;
		if (comment) {
			select(rows().indexOf(comment));
			refresh();
		}
		return;
	}
	const row = target.closest(".story") as HTMLElement | null;
	if (!row) {
		return;
	}
	select(rows().indexOf(row));
	const story = stories[selected];
	if (story) {
		void openThread(story);
	}
});

void loadStories();
