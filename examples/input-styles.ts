#!/usr/bin/env bun
// A live gallery of candidate input field styles, for choosing termdom's UA
// default. Every variant is plain author CSS over the same <input> element --
// nothing here is a special rendering mode. Each row shows three states:
// a placeholder, empty with no placeholder, and a typed value.
//
//   node examples/input-styles.ts        Tab / Shift+Tab to move focus
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
  .gallery { padding: 1 2ch; }
  h2 { color: cyan; font-weight: bold; }
  .variant { padding-top: 1px; }
  .name { color: yellow; }
  .desc { color: #666; }
  .row { display: flex; flex-direction: row; gap: 2ch; }
  .row input { width: 24ch; }
  .sigil { color: magenta; display: inline; }

  /* 1. Bare (Ink / clack / Bubbles content style): no chrome at all */
  .bare input { text-decoration: none; }

  /* 2. Underline (current UA default; Material-style, not a TUI tradition) */
  .underline input { text-decoration: underline; }

  /* 3. Soft background block (modern editor-ish tint, both colors set) */
  .block input { background: #264f78; color: #ffffff; text-decoration: none; }

  /* 4. Curses blue (dialog / whiptail / Midnight Commander lineage) */
  .curses input { background: #0000af; color: #ffffff; text-decoration: none; }

  /* 5. Border box (Textual's default Input; the pre-flat termdom look) */
  .boxed input {
    text-decoration: none;
    border-top-width: 1px; border-bottom-width: 1px;
    border-left-width: 1px; border-right-width: 1px;
    border-top-style: solid; border-bottom-style: solid;
    border-left-style: solid; border-right-style: solid;
    padding-left: 1ch; padding-right: 1ch;
  }

  /* 6. Focus-reactive (Textual compact: bare blurred, tinted focused) */
  .reactive input { text-decoration: none; }
  .reactive input:focus { background: #264f78; color: #ffffff; }

  /* 7. Prompt sigil (Bubbles / fzf: a marker, not field chrome) */
  .prompted input { text-decoration: none; }
`;
document.head.appendChild(style);

interface Variant {
	cls: string;
	name: string;
	desc: string;
	sigil?: boolean;
}

const variants: Variant[] = [
	{cls: "bare", name: "1. bare", desc: "Ink/clack: placeholder + caret only"},
	{
		cls: "underline",
		name: "2. underline",
		desc: "current default; no TUI has this",
	},
	{cls: "block", name: "3. soft block", desc: "editor tint, fg+bg both set"},
	{cls: "curses", name: "4. curses blue", desc: "dialog/whiptail/MC lineage"},
	{cls: "boxed", name: "5. border box", desc: "Textual default; 3 rows tall"},
	{
		cls: "reactive",
		name: "6. focus-reactive",
		desc: "bare blurred, tint focused (Tab here!)",
	},
	{
		cls: "prompted",
		name: "7. prompt sigil",
		desc: "Bubbles/fzf: '> ' marks it, field bare",
		sigil: true,
	},
];

const gallery = document.createElement("div");
gallery.className = "gallery";
const title = document.createElement("h2");
title.textContent =
	"Input field styles — Tab/Shift+Tab to move focus, Ctrl+C quits";
gallery.appendChild(title);

for (const variant of variants) {
	const section = document.createElement("div");
	section.className = `variant ${variant.cls}`;
	const header = document.createElement("div");
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = `${variant.name}  `;
	const desc = document.createElement("span");
	desc.className = "desc";
	desc.textContent = variant.desc;
	header.append(name, desc);
	section.appendChild(header);

	const row = document.createElement("div");
	row.className = "row";
	for (const state of ["placeholder", "empty", "value"] as const) {
		const cell = document.createElement("div");
		if (variant.sigil) {
			// Flex, not an inline run: a span+input mixed run currently
			// mispaints (bug noted during this gallery's first render).
			cell.style.display = "flex";
			(cell.style as any).flexDirection = "row";
			const sigil = document.createElement("span");
			sigil.className = "sigil";
			sigil.textContent = "> ";
			sigil.style.display = "inline-block";
			cell.appendChild(sigil);
		}
		const input = document.createElement("input");
		if (state === "placeholder") {
			input.setAttribute("placeholder", "What needs doing?");
		} else if (state === "value") {
			input.value = "Buy milk";
		}
		cell.appendChild(input);
		row.appendChild(cell);
	}
	section.appendChild(row);
	gallery.appendChild(section);
}

document.body.appendChild(gallery);
