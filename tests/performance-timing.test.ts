/**
 * The window's frame timing, through the browser's own APIs: Event
 * Timing says how long a key waited, how long its handlers ran and when
 * the frame after it was painted; Long Animation Frames says where a slow
 * frame's time went. Both reach a PerformanceObserver.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, until} from "./test-utils.js";

async function mounted(): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({cols: 20, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<input id=field>";
	await dom.attach();
	await nextFrame(dom);
	(dom.document.getElementById("field") as HTMLInputElement).focus();
	await nextFrame(dom);
	return {terminal, dom};
}

// lib.dom predates Long Animation Frames.
interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
	renderStart: number;
	styleAndLayoutStart: number;
	blockingDuration: number;
	firstUIEventTimestamp: number;
	scripts: unknown[];
}

function busy(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// Spin.
	}
}

function observe(
	dom: TermDOM,
	options: PerformanceObserverInit & {durationThreshold?: number},
): PerformanceEntry[] {
	const seen: PerformanceEntry[] = [];
	new dom.window.PerformanceObserver((list) => {
		seen.push(...list.getEntries());
	}).observe(options);
	return seen;
}

test("the observer names the entry types it supports", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	expect(dom.window.PerformanceObserver.supportedEntryTypes).toEqual([
		"event",
		"first-input",
		"long-animation-frame",
		"mark",
		"measure",
	]);
	dom.dispose();
});

test("a slow key's entry says when it came, how long it ran, and when it was painted", async () => {
	const {terminal, dom} = await mounted();
	const events = observe(dom, {type: "event", durationThreshold: 16});
	dom.document.addEventListener("keydown", () => busy(40));
	dom.document.addEventListener("keyup", () => busy(20));
	terminal.stdin.simulateResponse("a");
	await until(() => events.some((entry) => entry.name === "keyup"));
	const [down] = events.filter((entry) => entry.name === "keydown") as
		PerformanceEventTiming[];
	const up = events.find((entry) => entry.name === "keyup") as
		PerformanceEventTiming;
	expect(down.entryType).toBe("event");
	expect(down.processingStart).toBeGreaterThanOrEqual(down.startTime);
	expect(down.processingEnd - down.processingStart).toBeGreaterThanOrEqual(40);
	expect(down.duration).toBeGreaterThanOrEqual(40);
	expect(down.duration % 8).toBe(0);
	expect(down.target).toBe(dom.document.getElementById("field"));
	expect(down.interactionId).toBeGreaterThan(0);
	expect(up.interactionId).toBe(down.interactionId);
	expect(dom.window.performance.interactionCount).toBe(1);
	dom.dispose();
});

test("a quick key is not reported under the default threshold", async () => {
	const {terminal, dom} = await mounted();
	const events = observe(dom, {type: "event"});
	const marks = observe(dom, {type: "mark"});
	terminal.stdin.simulateResponse("a");
	await nextFrame(dom);
	dom.window.performance.mark("after");
	await until(() => marks.length > 0);
	expect(events.filter((event) => event.duration < 104)).toEqual([]);
	dom.dispose();
});

test("the first input is on the timeline, and a buffered observer hears it", async () => {
	const {terminal, dom} = await mounted();
	terminal.stdin.simulateResponse("a");
	await nextFrame(dom);
	terminal.stdin.simulateResponse("b");
	await nextFrame(dom);
	const timeline = dom.window.performance.getEntriesByType("first-input");
	expect(timeline.map((entry) => entry.name)).toEqual(["keydown"]);
	const heard = observe(dom, {type: "first-input", buffered: true});
	await until(() => heard.length > 0);
	expect(heard).toEqual(timeline);
	dom.dispose();
});

test("a slow frame is a long animation frame, with where its time went", async () => {
	const {terminal, dom} = await mounted();
	const frames = observe(dom, {type: "long-animation-frame"});
	dom.document.addEventListener("keydown", () => {
		dom.window.requestAnimationFrame(() => busy(60));
	});
	terminal.stdin.simulateResponse("a");
	await until(() => frames.length > 0);
	const [frame] = frames as unknown as PerformanceLongAnimationFrameTiming[];
	expect(frame.name).toBe("long-animation-frame");
	expect(frame.duration).toBeGreaterThanOrEqual(60);
	expect(frame.firstUIEventTimestamp).toBeGreaterThan(0);
	expect(frame.startTime).toBeLessThanOrEqual(frame.firstUIEventTimestamp);
	expect(frame.renderStart).toBeGreaterThanOrEqual(frame.startTime);
	expect(frame.styleAndLayoutStart - frame.renderStart)
		.toBeGreaterThanOrEqual(60);
	expect(frame.blockingDuration).toBeGreaterThan(0);
	expect(frame.scripts).toEqual([]);
	dom.dispose();
});

test("only a frame of 50 ms or more is a long one", async () => {
	const {terminal, dom} = await mounted();
	const frames = observe(dom, {type: "long-animation-frame"});
	const marks = observe(dom, {type: "mark"});
	for (const key of "abc") {
		terminal.stdin.simulateResponse(key);
		await nextFrame(dom);
	}
	dom.window.performance.mark("after");
	await until(() => marks.length > 0);
	expect(frames.filter((frame) => frame.duration < 50)).toEqual([]);
	dom.dispose();
});

test("observe() takes entryTypes or one type at a time, not both", () => {
	const dom = new TermDOM({transport: new MockProcess().transport});
	const observer = new dom.window.PerformanceObserver(() => {});
	expect(() => observer.observe({})).toThrow(TypeError);
	expect(() => observer.observe({entryTypes: ["mark"], type: "mark"}))
		.toThrow(TypeError);
	observer.observe({type: "mark"});
	expect(() => observer.observe({entryTypes: ["measure"]})).toThrow();
	dom.window.performance.mark("one");
	expect(observer.takeRecords().map((entry) => entry.name)).toEqual(["one"]);
	observer.disconnect();
	dom.window.performance.mark("two");
	expect(observer.takeRecords()).toEqual([]);
	dom.dispose();
});
