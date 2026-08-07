/**
 * Right-to-left text: Hebrew and Arabic, beside their left-to-right equivalents.
 *
 *   node examples/rtl.ts
 *
 * Terminals do not run the Unicode bidirectional algorithm, so termdom asks for
 * ECMA-48 explicit mode (BDSM, `CSI 8 l`), asks back what it got (`CSI 8 $ p`),
 * and hands over cells already in visual order: UAX #9 reordering via bidi-js,
 * and contextual Arabic shaping (joined letterforms, lam-alef ligatures) via
 * arabic-persian-reshaper, applied after measurement so caret offsets stay
 * logical.
 */

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body { padding: 1px 2ch; }
	h1 { color: cyan; margin-bottom: 1px; }
	section { margin-bottom: 1px; }
	.label { color: #808080; }
	.card {
		border: 1px solid;
		padding: 0 1ch;
		width: 34ch;
		margin-bottom: 1px;
	}
	.rtl { direction: rtl; }
	.price { color: yellow; }
`;
document.head.appendChild(style);

const app = document.createElement("div");
app.innerHTML = `
	<h1>RTL rendering</h1>

	<section>
		<div class="label">Hebrew in an LTR paragraph — reordered, left-aligned, as a browser without dir=auto</div>
		<div class="card">שלום עולם</div>
	</section>

	<section>
		<div class="label">Hebrew in a right-to-left box, with a Latin run and a number</div>
		<div class="card rtl">גרסה 0.1.0 של <span class="price">termdom</span></div>
	</section>

	<section>
		<div class="label">Arabic — reordered and contextually shaped</div>
		<div class="card rtl">مرحبا بالعالم</div>
	</section>

	<section>
		<div class="label">Arabic wrapping inside a narrow box</div>
		<div class="card rtl">هذا نص عربي طويل بما يكفي ليلتف على أكثر من سطر واحد</div>
	</section>

	<section>
		<div class="label">An RTL paragraph carrying Latin and digits</div>
		<div class="card rtl">الإصدار 2.1 يعمل على Bun و Node</div>
	</section>
`;
document.body.appendChild(app);
