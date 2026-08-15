// Vue's stock DOM renderer, rendering into the terminal's document.
//
//   node examples/hello-vue.ts
//
//   any key  increments the counter
//   q        quit
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;
// @vue/runtime-dom captures `document` when its module loads to create nodes,
// and mount() tests the container with `instanceof Element` and `instanceof
// SVGElement`, so the globals go up before the import.
globalThis.document = document as never;
globalThis.window = term.window as never;
globalThis.Element = term.window.Element as never;
globalThis.SVGElement = term.window.SVGElement as never;

const {createApp, h, ref, onMounted, onUnmounted} = await import("vue");

const style = document.createElement("style");
style.textContent = `
	.card { border: 1px solid #5fafff; padding: 0 1ch; margin: 1px 2ch; }
	.greeting { color: cyan; font-weight: bold; }
	.count { color: #ffd75f; }
	.hint { color: #666666; margin-left: 2ch; }
`;
document.head.appendChild(style);

const Hello = {
	setup() {
		const count = ref(0);
		const onkeydown = (ev: any) => {
			if (ev.key === "q") {
				term.window.close();
				return;
			}

			count.value++;
		};

		onMounted(() => document.addEventListener("keydown", onkeydown));
		onUnmounted(() => document.removeEventListener("keydown", onkeydown));
		return () =>
			h("div", [
				h("div", {class: "card"}, [
					h("div", {class: "greeting"}, "Hello from Vue!"),
					h("div", {class: "count"}, `Keys pressed: ${count.value}`),
				]),
				h("div", {class: "hint"}, "any key counts · [q]uit"),
			]);
	},
};

createApp(Hello).mount(document.body as never);
