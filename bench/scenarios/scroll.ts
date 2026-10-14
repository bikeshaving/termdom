import {marked} from "marked";

import {measure, mount, nextFrame, readBenchFile, silence} from "../harness.ts";

const html = marked.parse(readBenchFile("README.md"), {async: false});
const {proc, dom} = await mount();
dom.document.body.innerHTML = `<article>${html}</article>`;
await nextFrame(dom);
silence(proc);
const view = dom.window;
let direction = 1;

async function scroll(rows: number): Promise<void> {
	const max = dom.document.body.scrollHeight - view.innerHeight;
	const next = view.scrollY + rows * direction;
	if (next > max || next < 0) {
		direction = -direction;
	}
	view.scrollBy(0, rows * direction);
	await nextFrame(dom);
}

await measure("scroll: one row", 100, () => scroll(1));
await measure("scroll: one page", 60, () => scroll(40));
dom.dispose();
