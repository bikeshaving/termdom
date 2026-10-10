/** The README example, verbatim: a progress card driven by mutation. */
import type {TermDOM} from "../../src/index.ts";

export default {
	setup(termdom: TermDOM): () => void {
		const {document} = termdom;
		document.body.innerHTML = `
			<style>
				.card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
				.title { color: #5fafff; font-weight: bold; }
				progress { width: 25ch; }
				progress::slider-fill { background-color: green; }
				.pct { color: #888; }
			</style>
			<div class="card">
				<div class="title">Installing</div>
				<div>
					<progress id="bar" max="100" value="0"></progress>
					<span class="pct" id="pct"></span>
				</div>
			</div>
		`;

		let n = 0;
		const tick = (): void => {
			n = (n + 1) % 101;
			document.querySelector("progress")!.value = n;
			document.getElementById("pct")!.textContent = String(n).padStart(3) + "%";
		};
		const interval = setInterval(tick, 50);
		tick();
		return () => clearInterval(interval);
	},
	steps: Array.from({length: 50}, () => 0.1) as Array<number | string>,
};
