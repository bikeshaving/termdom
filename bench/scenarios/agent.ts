/**
 * The two scenarios of nathan-cannon/tui-benchmarks, in plain DOM: a
 * coding agent's transcript at 120x40, kept scrolled to its end, with a
 * key counter under it. One key changes the counter, and one appends a
 * word to the last reply, as a streamed answer does. The messages are
 * this bench's own, of the lengths that one uses.
 */
import {measure, mount, nextFrame} from "../harness.ts";

const QUESTIONS = [
	"Why does the parser drop the last token?",
	"Can you add a timeout to the fetch call?",
	"What happens when the cache is empty?",
	"Split the handler into smaller pieces",
	"Why is the build slower since Tuesday?",
];

const ANSWERS = [
	"The tokenizer stops at the final newline instead of the end of input, so a file without a trailing newline loses its last token. I moved the end check after the read and added a test with no trailing newline.",
	"I wrapped the call in an AbortController with a ten second limit. A timeout now rejects with its own error, which the retry loop treats like a network failure, and the existing tests still pass unchanged.",
	"An empty cache returns undefined from the first lookup, and the caller reads a field off it. I made the lookup return a miss record instead, so the caller falls through to the network as it does for a stale entry.",
	"I pulled out three functions: one that validates the request, one that builds the query, and one that writes the response. Each is short enough to test alone, and the handler now reads as the three calls in order.",
	"The new source maps plugin runs on every file, including vendored ones that never change. I limited it to the source directory and cached its output by content hash, which brings the build back to where it was.",
];

const STREAMED = [
	"The fix is to read the length before the loop starts,",
	"so that a later push cannot extend the walk",
	"past the items it was given",
].join(" ").split(" ");

const SIZES = [10, 100, 500];

const SCENARIOS = [["one cell", false], ["streaming", true]] as const;

async function run(messages: number): Promise<void> {
	const {proc, dom} = await mount(120, 40);
	const {document, window} = dom;
	document.head.innerHTML = `<style>
		body { margin: 0 }
		.header { color: #5599ff; font-weight: bold }
		.role { font-weight: bold }
		.user { color: #00cc66 }
		.assistant { color: #cc66ff }
	</style>`;
	const header = document.createElement("div");
	header.className = "header";
	header.textContent = `Agent v1.0 | session-bench | msgs: ${messages}`;
	document.body.append(header);
	let last: Text | null = null;
	for (let i = 0; i < messages; i++) {
		const user = i % 2 === 0;
		const role = document.createElement("div");
		role.className = `role ${user ? "user" : "assistant"}`;
		role.textContent = user ? "user" : "assistant";
		const body = document.createElement("div");
		const text = user
			? QUESTIONS[(i / 2) % QUESTIONS.length]
			: ANSWERS[Math.floor(i / 2) % ANSWERS.length];
		body.append(text);
		if (!user) {
			last = body.firstChild as Text;
		}
		document.body.append(role, body);
	}
	const input = document.createElement("div");
	document.body.append(input);

	let count = 0;
	let streamed = 0;
	let streaming = false;
	input.textContent = `❯ keypress count: ${count}`;
	document.addEventListener("keydown", () => {
		if (streaming) {
			last!.appendData(` ${STREAMED[streamed++ % STREAMED.length]}`);
		} else {
			input.firstChild!.nodeValue = `❯ keypress count: ${++count}`;
		}
		window.scrollTo(0, document.documentElement.scrollHeight);
	});
	window.scrollTo(0, document.documentElement.scrollHeight);
	await nextFrame(dom);

	let bytes = 0;
	proc.stdout.write = (chunk: unknown, enc?: unknown, cb?: unknown) => {
		bytes += Buffer.byteLength(chunk as string);
		const callback = typeof enc === "function" ? enc : cb;
		if (typeof callback === "function") {
			(callback as () => void)();
		}
		return true;
	};
	const press = async (): Promise<void> => {
		proc.stdin.simulateResponse("x");
		await nextFrame(dom);
	};

	for (const [name, scenario] of SCENARIOS) {
		streaming = scenario;
		const label = `agent: ${name}, ${messages} messages`;
		await measure(label, 100, press, 15);
		bytes = 0;
		for (let i = 0; i < 20; i++) {
			await press();
		}
		console.error(`${label}: ${Math.round(bytes / 20)} bytes a frame`);
	}
	dom.dispose();
}

for (const messages of SIZES) {
	await run(messages);
}
