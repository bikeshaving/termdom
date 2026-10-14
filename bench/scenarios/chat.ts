import {
	installGlobals,
	measure,
	mount,
	nextFrame,
	silence,
} from "../harness.ts";

const {proc, dom} = await mount();
installGlobals(dom);
const React = await import("react");
const {createRoot} = await import("react-dom/client");
const {flushSync} = await import("react-dom");
const h = React.createElement;

dom.document.head.innerHTML = `<style>
	.msg { margin-top: 1px }
	.who { font-weight: bold }
	.you .who { color: #5fafff }
	.bot .who { color: #87d787 }
	.body { display: block }
	.time { color: #808080 }
	.prompt { display: flex }
	textarea { flex-grow: 1; border: none; padding: 0 }
</style>`;

interface Message {
	id: number;
	who: string;
	text: string;
}

let append: (message: Message) => void = () => {};

function App(): React.ReactElement {
	const [messages, setMessages] = React.useState<Message[]>([]);
	append = (message) => setMessages((list) => [...list, message]);
	return h(
		"div",
		null,
		h(
			"div",
			{className: "log"},
			messages.map((message) =>
				h(
					"div",
					{key: message.id, className: `msg ${message.who}`},
					h("span", {className: "who"}, message.who === "you" ? "You" : "Bot"),
					" ",
					h(
						"span",
						{className: "time"},
						`12:${String(message.id % 60).padStart(2, "0")}`,
					),
					h("span", {className: "body"}, message.text),
				)),
		),
		h(
			"div",
			{className: "prompt"},
			h("span", null, "› "),
			h("textarea", {rows: 1}),
		),
	);
}

const reactRoot = createRoot(dom.document.body);
flushSync(() => reactRoot.render(h(App)));
await nextFrame(dom);
silence(proc);

const words = (
	"the quick brown fox jumps over the lazy dog while a terminal renders the dom"
).split(" ");
let id = 0;
await measure("react chat: append a message", 200, async () => {
	const text = Array.from({length: 12 + (id % 20)}, (_, k) => words[(id + k) %
		words.length]).join(" ");
	flushSync(() => append({id, who: id % 2 ? "bot" : "you", text}));
	id++;
	await nextFrame(dom);
});
dom.dispose();
