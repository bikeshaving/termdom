// Hacker News as a page: the front page from the Algolia API, and a story's
// comment thread rendered from the HTML the API hands back.
//
//   node examples/hacker-news.ts
//
//   j/k or arrows   move        Enter   read the comments
//   g / G           top/bottom  Escape  back to the front page
//   r               reload      q       quit
//   a click selects a story and opens it
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
	.hint { color: #666666; padding: 0 1ch; }

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
	.gone { color: #555555; }

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
document.body.append(masthead, hint, listView, readerView);

const LIST_KEYS = " j/k move · enter comments · g/G ends · r reload · q quit";
const READER_KEYS = " j/k scroll · space page · esc back · r reload · q quit";

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

function rows(): HTMLElement[] {
	return Array.from(listView.querySelectorAll<HTMLElement>(".story"));
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
	selected = Math.max(0, Math.min(index, all.length - 1));
	all.forEach((row, i) => row.classList.toggle("on", i === selected));
	count.textContent = all.length ? `${selected + 1}/${all.length}` : "";
}

function refresh(): void {
	rows()[selected]?.scrollIntoView();
	// At the first story, pull the camera the rest of the way up so the
	// masthead shows too -- scrollIntoView alone stops below it.
	if (selected === 0) {
		toTop();
	}
}

function toTop(): void {
	window.scrollBy(0, -document.body.scrollHeight);
}

function page(): number {
	return Math.max(1, window.innerHeight - 1);
}

async function loadStories(): Promise<void> {
	const mine = ++generation;
	reading = null;
	readerView.style.display = "none";
	listView.style.display = "";
	hint.textContent = LIST_KEYS;
	count.textContent = "";
	listView.replaceChildren(message("loading", "loading the front page…"));
	toTop();
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

function makeComment(item: Item, depth: number): HTMLElement {
	const comment = document.createElement("div");
	comment.className = "comment";
	comment.style.paddingLeft = `${1 + Math.min(depth, INDENT_LIMIT) * 2}ch`;
	const thread = document.createElement("div");
	thread.className = "thread";
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
	thread.appendChild(byline);
	if (item.text) {
		const body = document.createElement("div");
		body.className = "body";
		body.innerHTML = item.text;
		thread.appendChild(body);
	}
	comment.appendChild(thread);
	return comment;
}

async function openThread(story: Story): Promise<void> {
	const mine = ++generation;
	reading = story;
	listView.style.display = "none";
	readerView.style.display = "";
	hint.textContent = READER_KEYS;
	count.textContent = plural(story.num_comments ?? 0, "comment");
	readerView.replaceChildren(
		storyHead(story),
		message("loading", "loading the comments…"),
	);
	toTop();
	try {
		const response = await fetch(`${API}/items/${story.id}`);
		if (!response.ok) {
			throw new Error(`the API answered ${response.status}`);
		}
		const item = (await response.json()) as Item;
		if (mine !== generation) {
			return;
		}
		const thread: Array<[Item, number]> = [];
		flatten(item, 0, thread);
		const parts: HTMLElement[] = [storyHead(story)];
		if (!thread.length) {
			parts.push(message("loading", "no comments yet"));
		}
		for (const [child, depth] of thread) {
			parts.push(makeComment(child, depth));
		}
		if (thread.length >= COMMENT_LIMIT) {
			parts.push(message("loading", `the first ${COMMENT_LIMIT} comments`));
		}
		readerView.replaceChildren(...parts);
		toTop();
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
	select(selected);
	refresh();
}

document.addEventListener("keydown", (event: Event) => {
	const key = (event as KeyboardEvent).key;
	if (key === "q") {
		term.window.close();
		return;
	}
	if (reading) {
		if (key === "Escape" || key === "h" || key === "ArrowLeft") {
			back();
		} else if (key === "r") {
			void openThread(reading);
		} else if (key === "j" || key === "ArrowDown") {
			window.scrollBy(0, 1);
		} else if (key === "k" || key === "ArrowUp") {
			window.scrollBy(0, -1);
		} else if (key === " " || key === "f" || key === "PageDown") {
			window.scrollBy(0, page());
		} else if (key === "b" || key === "PageUp") {
			window.scrollBy(0, -page());
		} else if (key === "g") {
			toTop();
		} else if (key === "G") {
			window.scrollBy(0, document.body.scrollHeight);
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
	if (reading) {
		return;
	}
	const row = (event.target as Element).closest(".story") as HTMLElement | null;
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
