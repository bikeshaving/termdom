// Adapted from https://backbonenotbad.hyperclay.com/
// https://gist.github.com/panphora/8f4d620ae92e8b28dcb4f20152185749
import {TermDOM} from "@b9g/termdom";
import type {Context} from "@b9g/crank";
import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";

const term = new TermDOM();

term.attach();
const document = term.document;
globalThis.Node = term.window.Node;
globalThis.document = term.document;

const style = document.createElement("style");
style.textContent = `
	.card { border: 1px solid #5f5f5f; padding: 0 2ch; width: 40ch; margin: 1px 0 0 1ch; }
	.card h1 { color: cyan; font-weight: bold; }
	.card input { width: 100%; margin-top: 1px; }
	.reqs { margin-top: 1px; }
	.req .mark { display: inline; }
	.req.met .mark, .req.met .label { color: #5faf5f; }
	.req.met .label { font-weight: bold; }
	.req:not(.met) .mark, .req:not(.met) .label { color: #666666; }
`;
document.head.appendChild(style);

interface Requirement {
	label: string;
	check: (pwd: string) => boolean;
}

const requirements: Requirement[] = [
	{label: "8+ characters", check: (pwd) => pwd.length >= 8},
	{label: "12+ characters", check: (pwd) => pwd.length >= 12},
	{label: "Lowercase letter", check: (pwd) => /[a-z]/.test(pwd)},
	{label: "Uppercase letter", check: (pwd) => /[A-Z]/.test(pwd)},
	{label: "Number", check: (pwd) => /\d/.test(pwd)},
	{label: "Special character", check: (pwd) => /[^a-zA-Z0-9]/.test(pwd)},
];

function* PasswordStrength(this: Context) {
	let password = "";

	const oninput = (ev: any) => {
		this.refresh(() => (password = ev.target.value));
	};

	// Idiomatic Crank: this yields the component's props each iteration; {}
	// says none are used.
	// eslint-disable-next-line no-empty-pattern
	for ({} of this) {
		yield jsx`
			<div class="card">
				<h1>Password strength</h1>
				<input
					type="password"
					value=${password}
					oninput=${oninput}
					placeholder="Enter password"
					autofocus
				/>
				<div class="reqs">
					${requirements.map(({label, check}) => {
						const met = check(password);
						return jsx`
							<div class=${{req: true, met}} key=${label}>
								<span class="mark">${met ? "✓" : "○"} </span><span class="label">${label}</span>
							</div>
						`;
					})}
				</div>
			</div>
		`;
	}
}

renderer.render(jsx`<${PasswordStrength} />`, document.body);

document.addEventListener(
	"keydown",
	(event: Event) => {
		const e = event as KeyboardEvent;
		if (e.key === "Escape" || (e.ctrlKey && e.key === "c")) {
			term.window.close();
		}
	},
	true,
);

// No terminal (piped/CI): show the card mid-typing, then exit.
if (!process.stdout.isTTY) {
	const input = document.querySelector("input") as HTMLInputElement;
	input.value = "Tr0ub4dor";
	input.dispatchEvent(new term.window.Event("input", {bubbles: true}));
	setTimeout(() => {
		term.window.close();
	}, 100);
}
