/**
 * Line-based placement: every item states the grid lines it runs between, and
 * the grid is whatever those spans add up to.
 *
 * The companion to grid.ts, which names areas instead. Areas draw a picture of
 * the layout and let each item point at a region of it; lines let an item say
 * where it goes without the container knowing the shape in advance. Two things
 * fall out of that which areas cannot express, and both are here:
 *
 * - Items may OVERLAP. `.one` runs from column line 1 to 3 and `.two` from 2 to
 *   4, so both cover column 2 of the first row. Neither is positioned, so paint
 *   order is document order and `.two` wins the cells they share.
 * - Rows may be IMPLICIT. Only three columns are declared; nothing declares a
 *   row. Every row here was created by an item reaching for it, and sized by
 *   `grid-auto-rows`.
 *
 * The placement is MDN's "line-based placement" example from the CSS grid
 * guide, unchanged -- the same six items spanning the same lines. What differs
 * is the sizing, which is in cells rather than pixels: a terminal row is one
 * cell tall, so a 100px minimum becomes 3 rows and a 2px border becomes the one
 * cell a terminal can draw.
 */
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body {
		margin: 0;
	}
	.wrapper {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0 2ch;
		grid-auto-rows: minmax(3px, auto);
		max-width: 72ch;
	}
	.wrapper > div {
		border: 1px solid #e9ab58;
		border-radius: 1px;
		background-color: #3a2c17;
		color: #ffb066;
		padding: 0 1ch;
	}
	/*
	 * The six placements, exactly as the guide states them. Read a pair as
	 * "from this line to that one"; a single number is one track.
	 */
	.one {
		grid-column: 1 / 3;
		grid-row: 1;
	}
	.two {
		grid-column: 2 / 4;
		grid-row: 1 / 3;
	}
	.three {
		grid-column: 1;
		grid-row: 2 / 5;
	}
	.four {
		grid-column: 3;
		grid-row: 3;
	}
	.five {
		grid-column: 2;
		grid-row: 4;
	}
	.six {
		grid-column: 3;
		grid-row: 4;
	}
	.legend {
		color: #808080;
		padding: 1px 0 0 0;
	}
`;
document.head.appendChild(style);

const wrapper = document.createElement("div");
wrapper.className = "wrapper";
wrapper.innerHTML = ["one", "two", "three", "four", "five", "six"]
	.map(
		(name, index) =>
			`<div class="${name}">${name[0].toUpperCase()}${name.slice(1)} ` +
			`<span>(${index + 1})</span></div>`,
	)
	.join("");
document.body.appendChild(wrapper);

const legend = document.createElement("div");
legend.className = "legend";
legend.textContent =
	"One and Two both reach column 2 of row 1; Two is later, so it paints there. " +
	"q to quit";
document.body.appendChild(legend);

document.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "q") {
		term.window.close();
	}
});
