/**
 * Images and canvases a page removes are freed.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {encodePNG} from "../src/internal/images.ts";
import {collect, grownOver, MB, settle, WARM_UP} from "./memory-utils.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// Pixels sit in array buffers, which the heap does not count.
async function heldMemory(): Promise<number> {
	let lowest = Infinity;
	for (let i = 0; i < 3; i++) {
		await settle();
		const usage = process.memoryUsage();
		lowest = Math.min(lowest, usage.heapUsed + (usage.external ?? 0));
	}
	return lowest;
}

// A 256 by 256 image is 256 KB decoded, so a page that held its images
// after they went would hold some 100 MB here.
const IMAGE = (() => {
	const bytes = encodePNG({
		width: 256,
		height: 256,
		data: new Uint8ClampedArray(256 * 256 * 4).fill(200),
	});
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return `data:image/png;base64,${btoa(binary)}`;
})();

async function showImages(dom: TermDOM, round: number): Promise<void> {
	const host = dom.document.createElement("div");
	host.innerHTML =
		`<img src="${IMAGE}">`.repeat(4) +
		"<canvas width=256 height=256></canvas>".repeat(2);
	dom.document.body.append(host);
	for (const canvas of host.querySelectorAll("canvas")) {
		const context = canvas.getContext("2d")!;
		context.fillStyle = `#${(round * 997 % 0xffffff).toString(16).padStart(6, "0")}`;
		context.fillRect(0, 0, 256, 256);
	}
	// Every other round, the images go before they load.
	if (round % 2 === 0) {
		const images = [...host.querySelectorAll("img")];
		while (!images.every((image) => image.complete)) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
	}
	await nextFrame(dom);
	host.remove();
	await nextFrame(dom);
}

(collect === null ? test.skip : test)(
	"showing and removing images and canvases does not grow memory",
	async () => {
		const dom = new TermDOM({
			transport: new MockProcess({cols: 100, rows: 40}).transport,
			csp: "img-src data: https:",
		});
		let round = 0;
		const churn = () => showImages(dom, round++);
		while (round < WARM_UP) {
			await churn();
		}
		const grown = await grownOver(heldMemory, churn);
		dom.dispose();
		expect(grown).toBeLessThan(MB);
	},
);
