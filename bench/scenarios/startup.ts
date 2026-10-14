import {marked} from "marked";

import {
	cpuMs,
	MockProcess,
	nextFrame,
	readBenchFile,
	report,
	TermDOM,
} from "../harness.ts";

const html = marked.parse(readBenchFile("README.md"), {async: false});
const times: number[] = [];
for (let i = 0; i < 25; i++) {
	const proc = new MockProcess({cols: 100, rows: 40});
	const start = cpuMs();
	const dom = new TermDOM({transport: proc.transport});
	dom.document.body.innerHTML = `<article>${html}</article>`;
	dom.attach();
	await nextFrame(dom);
	if (i >= 5) {
		times.push(cpuMs() - start);
	}
	dom.dispose();
}
report("startup: README to first frame", times);
