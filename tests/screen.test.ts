/**
 * window.screen: CSSOM View's Screen and the Screen Orientation spec's
 * ScreenOrientation. The terminal is the screen, so its size is the
 * window's, and it never turns.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, until} from "./test-utils.ts";

function mount(
	cols: number,
	rows: number,
): {dom: TermDOM; terminal: MockProcess; window: any} {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	return {dom, terminal, window: dom.window};
}

test("screen is a Screen as large as the window", () => {
	const {dom, window} = mount(40, 12);
	const {screen} = window;
	expect(screen).toBeInstanceOf(window.Screen);
	expect(String(screen)).toBe("[object Screen]");
	expect(screen).toBe(window.screen);
	expect([screen.width, screen.height, screen.availWidth, screen.availHeight])
		.toEqual([
			window.innerWidth,
			window.innerHeight,
			window.innerWidth,
			window.innerHeight,
		]);
	expect(screen.pixelDepth).toBe(screen.colorDepth);
	expect(() => new window.Screen()).toThrow(TypeError);
	dom.dispose();
});

test("the screen's orientation follows the window's shape and cannot be locked", async () => {
	const {dom, window} = mount(40, 12);
	const {orientation} = window.screen;
	expect(orientation).toBeInstanceOf(window.ScreenOrientation);
	expect(String(orientation)).toBe("[object ScreenOrientation]");
	expect(orientation).toBe(window.screen.orientation);
	expect([orientation.type, orientation.angle]).toEqual([
		"landscape-primary",
		0,
	]);
	expect(orientation.unlock()).toBeUndefined();
	const refusal = await orientation
		.lock("portrait")
		.then(() => "locked", (error: DOMException) => error.name);
	expect(refusal).toBe("NotSupportedError");
	expect(() => new window.ScreenOrientation()).toThrow(TypeError);
	dom.dispose();
});

test("turning the window from wide to tall fires change at the orientation", async () => {
	const {dom, terminal, window} = mount(40, 12);
	const changes: string[] = [];
	window.screen.orientation.onchange = () => {
		changes.push(window.screen.orientation.type);
	};
	await dom.attach();
	terminal.resize(30, 40);
	(terminal as any).emit("SIGWINCH");
	await until(() => changes.length === 1);
	terminal.resize(20, 40);
	(terminal as any).emit("SIGWINCH");
	terminal.resize(40, 10);
	(terminal as any).emit("SIGWINCH");
	await until(() => changes.length === 2);
	expect(changes).toEqual(["portrait-primary", "landscape-primary"]);
	dom.dispose();
});
