import {keyLatency, mount, nextFrame, underLoad} from "../harness.ts";

const {proc, dom} = await mount();
dom.document.body.innerHTML = "<input id=field>";
const field = dom.document.getElementById("field");
field.focus();
await nextFrame(dom);
const press = keyLatency(proc);

async function type(keys: number): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < keys; i++) {
		times.push(await press(String.fromCharCode(97 + (i % 26))));
		if (field.value.length > 60) {
			field.value = "";
			await nextFrame(dom);
		}
	}
	return times;
}

await type(20);
await underLoad("latency: key to frame", () => type(100));
dom.dispose();
