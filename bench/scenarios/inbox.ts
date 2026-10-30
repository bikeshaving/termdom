/**
 * An inbox's key handling: a screen-tall list that scrolls in a box, with
 * the selection a class on one row, moved by keys as a mail reader's j
 * and k move it.
 */
import {measure, mount, nextFrame, silence} from "../harness.ts";

const {proc, dom} = await mount(100, 40);
silence(proc);
const {document} = dom;
document.head.innerHTML =
	"<style>body { margin: 0; height: 100vh; display: flex; " +
	"flex-direction: column } ul { flex: 1; overflow: auto; margin: 0 } " +
	"li { padding: 0 1ch } li:nth-child(odd) { color: gray } " +
	"li.on { background: navy; color: white }</style>";
document.body.innerHTML =
	"<header>Inbox</header><ul>" +
	Array.from(
		{length: 500},
		(_, i) => `<li>Message <b>${i}</b> <span>from someone ${i}</span></li>`,
	).join("") +
	"</ul><footer>500 messages</footer>";
await nextFrame(dom);
const rows = [...document.querySelectorAll("li")];
let at = 0;
let span = 0;
document.addEventListener("keydown", (event: KeyboardEvent) => {
	event.preventDefault();
	if (span === 0) {
		return;
	}
	rows[at].classList.remove("on");
	at = (at + 1) % span;
	rows[at].classList.add("on");
	rows[at].scrollIntoView({block: "nearest"});
});
rows[0].classList.add("on");

async function press(): Promise<void> {
	proc.stdin.simulateResponse("j");
	await nextFrame(dom);
}

// Every kind of key once over before any is measured, so the first
// measured is not charged for compiling what they all run.
for (const each of [0, 20, rows.length]) {
	span = each;
	for (let i = 0; i < 100; i++) {
		await press();
	}
}
span = 0;
await measure("inbox: a key that changes nothing", 200, press, 20);
span = 20;
await measure("inbox: a key that moves the selection", 200, press, 20);
span = rows.length;
await measure(
	"inbox: a key that moves the selection and scrolls",
	200,
	press,
	50,
);
dom.dispose();
