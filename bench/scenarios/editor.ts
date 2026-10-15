import {mountEditor} from "../editor.ts";
import {measure, nextFrame, silence} from "../harness.ts";

const {proc, dom, view} = await mountEditor();
silence(proc);

async function press(data: string): Promise<void> {
	const before = view.state.doc.length;
	proc.stdin.simulateResponse(data);
	for (let i = 0; i < 200 && view.state.doc.length === before; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	await nextFrame(dom);
}

const text = "const value = compute(element, rect);";
let typed = 0;
await measure("codemirror: type a character", 120, async () => {
	await press(text[typed % text.length]);
	typed++;
	if (typed % text.length === 0) {
		await press("\r");
	}
});
dom.dispose();
