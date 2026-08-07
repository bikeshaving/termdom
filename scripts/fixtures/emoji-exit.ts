// Renders wide characters and exits through the static flush -- the scenario
// where a phantom continuation column would shift everything after an emoji.
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
term.document.body.innerHTML =
	`<div>🙂 one wide</div>` +
	`<div>a🙂b🎉c end-marker</div>` +
	`<div>plain ascii row</div>`;
setTimeout(() => {
	term.dispose();
	process.exit(0);
}, 800);
