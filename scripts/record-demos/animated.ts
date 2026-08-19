/** The animated demo, scripted: let it run, no input. */
import type {TermDOM} from "../../src/index.js";

export default {
	setup(termdom: TermDOM): () => void {
		const {document} = termdom;
		const style = document.createElement("style");
		style.textContent = `
			.title { color: cyan; font-weight: bold; }
			.k { color: yellow; display: inline; }
			.spin { color: green; display: inline; }
			.bar-f { color: green; display: inline; }
			.bar-t { color: #444; display: inline; }
			.row { padding: 1 0 0 0; }
			.hint { color: #666; padding: 1 0 0 0; }
		`;
		document.head.appendChild(style);
		document.body.innerHTML = `
			<div class="title">termdom — a DOM, painted to the terminal</div>
			<div class="row"><span class="k">spinner </span><span class="spin" id="s"></span></div>
			<div class="row"><span class="k">render  </span><span class="bar-f" id="f"></span><span class="bar-t" id="t"></span></div>
			<div class="hint">every glyph is an element · incremental layout · O(screen) paint</div>
		`;
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let n = 0;
		const tick = (): void => {
			document.getElementById("s")!.textContent =
				frames[n % frames.length] + " live";
			const fill = n % 30;
			document.getElementById("f")!.textContent = "█".repeat(fill);
			document.getElementById("t")!.textContent = "░".repeat(30 - fill);
			n++;
		};
		const interval = setInterval(tick, 30);
		tick();
		return () => clearInterval(interval);
	},
	steps: Array.from({length: 60}, () => 0.09) as Array<number | string>,
};
