/** The README example, verbatim: a progress card driven by mutation. */
import type {TermDOM} from "../../src/index.ts";

export default {
	setup(termdom: TermDOM): () => void {
		const {document} = termdom;
		document.body.innerHTML = `
			<style>
				.card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
				.title { color: #5fafff; font-weight: bold; }
				.done { color: green; }
				.rest { color: #444; }
				.pct { color: #888; }
			</style>
			<div class="card">
				<div class="title">Installing</div>
				<div><span class="done" id="done"></span><span class="rest" id="rest"></span> <span class="pct" id="pct"></span></div>
			</div>
		`;

		let n = 0;
		const tick = (): void => {
			n = (n + 1) % 101;
			const cells = Math.round(n / 4);
			document.getElementById("done")!.textContent = "█".repeat(cells);
			document.getElementById("rest")!.textContent = "░".repeat(25 - cells);
			document.getElementById("pct")!.textContent = String(n).padStart(3) + "%";
		};
		const interval = setInterval(tick, 50);
		tick();
		return () => clearInterval(interval);
	},
	steps: Array.from({length: 50}, () => 0.1) as Array<number | string>,
};
