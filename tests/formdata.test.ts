import {expect, test} from "@b9g/libuild/test";

import {createWindow} from "../src/internal/dom.ts";

test("a FormData holds its entries in order and reads them back by name", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	expect(Object.prototype.toString.call(data)).toBe("[object FormData]");
	expect(data.get("a")).toBe(null);
	expect(data.getAll("a")).toEqual([]);
	expect(data.has("a")).toBe(false);

	data.append("a", "1");
	data.append("b", "2");
	data.append("a", "3");
	expect(data.get("a")).toBe("1");
	expect(data.getAll("a")).toEqual(["1", "3"]);
	expect(data.has("b")).toBe(true);
	expect([...data]).toEqual([["a", "1"], ["b", "2"], ["a", "3"]]);
	expect([...data.keys()]).toEqual(["a", "b", "a"]);
	expect([...data.values()]).toEqual(["1", "2", "3"]);
	expect([...data.entries()]).toEqual([...data]);

	const seen: Array<[string, unknown, boolean]> = [];
	data.forEach(function (value, key, parent) {
		seen.push([key, value, parent === data]);
	});
	expect(seen).toEqual([["a", "1", true], ["b", "2", true], ["a", "3", true]]);

	data.set("a", "4");
	expect([...data]).toEqual([["a", "4"], ["b", "2"]]);
	data.set("c", "5");
	expect([...data]).toEqual([["a", "4"], ["b", "2"], ["c", "5"]]);
	data.delete("a");
	expect([...data]).toEqual([["b", "2"], ["c", "5"]]);
	expect(data.has("a")).toBe(false);
});

test("a FormData turns a value into a string and a blob into a file", async () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	data.append("n", 12 as unknown as string);
	expect(data.get("n")).toBe("12");

	const blob = new Blob(["hello"], {type: "text/plain"});
	data.append("plain", blob);
	const blobbed = data.get("plain") as File;
	expect(blobbed).toBeInstanceOf(File);
	expect(blobbed.name).toBe("blob");
	expect(blobbed.type).toBe(blob.type);
	expect(await blobbed.text()).toBe("hello");

	data.append("named", new Blob(["hi"]), "note.txt");
	expect((data.get("named") as File).name).toBe("note.txt");

	data.append("file", new File(["x"], "given.txt", {type: "text/plain"}));
	expect((data.get("file") as File).name).toBe("given.txt");

	data.append("renamed", new File(["x"], "given.txt"), "other.txt");
	expect((data.get("renamed") as File).name).toBe("other.txt");

	data.set("only", new Blob(["y"]), "one.txt");
	expect((data.get("only") as File).name).toBe("one.txt");
});

test("a FormData replaces a lone surrogate in a name or a value", () => {
	const window = createWindow("<!DOCTYPE html><body></body>");
	const data = new window.FormData();

	data.append("na\uD800me", "va\uDC00lue");
	expect([...data]).toEqual([["na�me", "va�lue"]]);
	expect(data.get("na\uD800me")).toBe("va�lue");
	expect(data.has("na�me")).toBe(true);

	data.append("pair", "😀");
	expect(data.get("pair")).toBe("😀");
});
