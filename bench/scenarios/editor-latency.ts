import {mountEditor} from "../editor.ts";
import {keyLatency, underLoad} from "../harness.ts";

const {proc, dom} = await mountEditor();
const press = keyLatency(proc);
const text = "const value = compute(element, rect);";
let typed = 0;

async function type(keys: number): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < keys; i++) {
		const key = typed % text.length === text.length - 1
			? "\r"
			: text[typed % text.length];
		times.push(await press(key));
		typed++;
	}
	return times;
}

await type(20);
await underLoad("codemirror: key to frame", () => type(100));
dom.dispose();
