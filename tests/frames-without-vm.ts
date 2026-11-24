/**
 * Runs DuckDuckGo's result click, a message to a hidden frame that sends
 * the page to the result, where the runtime has no node:vm, as in
 * isolated-vm. Prints what the frame's window had and heard, as JSON.
 * The engine looks for node:vm the first time a frame is made, so the
 * runtime's has to be hidden before the engine loads.
 *
 *   bun tests/frames-without-vm.ts
 */
const getBuiltinModule = process.getBuiltinModule.bind(process);
Object.defineProperty(process, "getBuiltinModule", {
	value: (id: string) =>
		id === "node:vm" || id === "vm" ? undefined : getBuiltinModule(id),
	configurable: true,
});

const {TermDOM} = await import("../src/index.ts");
const {canCreateRealms} = await import("../src/internal/realms.ts");
const {MockProcess, until} = await import("./test-utils.ts");

const dom = new TermDOM({
	transport: new MockProcess().transport,
	url: "https://duckduckgo.com/?q=termdom",
});
const iframe = dom.document.createElement("iframe");
iframe.setAttribute("src", "/post3.html");
iframe.style.display = "none";
dom.document.body.append(iframe);
const frame = iframe.contentWindow as any;
const sandboxed = dom.document.createElement("iframe");
sandboxed.setAttribute("sandbox", "allow-scripts");
dom.document.body.append(sandboxed);

let heard: unknown[] = [];
let navigated = "";
dom.window.navigation.addEventListener("navigate", (event) => {
	navigated = event.destination.url;
	event.preventDefault();
});
frame.addEventListener("message", (event: MessageEvent) => {
	heard = [event.data, event.origin, event.source === frame.parent];
	if (event.source === frame.parent) {
		frame.parent.window.location.href = event.data.slice(4);
	}
});
frame.postMessage("ddg:https://example.org/result", dom.window.origin);
await until(() => navigated !== "");

process.stdout.write(
	JSON.stringify({
		realms: canCreateRealms(),
		postMessage: typeof frame.postMessage,
		parent: frame.parent === dom.window,
		top: frame.top === dom.window,
		frameElement: frame.frameElement === iframe,
		location: frame.location.href,
		origin: frame.origin,
		sandboxedDocument: sandboxed.contentDocument,
		heard,
		navigated,
	}),
);
await dom.dispose();
