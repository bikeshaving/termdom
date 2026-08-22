// src/models/virtual-fs.ts
var FS_ROOT = "/workspace/termdom";
var HOME = "/home/visitor";
var REPO = {
  ".git": {
    HEAD: "",
    config: "",
    refs: { heads: { main: "" } }
  },
  ".gitignore": "",
  docs: {
    guides: {
      "01-getting-started.md": "",
      "02-layout.md": "",
      "03-events-and-input.md": "",
      "04-api.md": ""
    }
  },
  examples: {
    "flexbox.ts": "",
    "form.ts": "",
    "solitaire.ts": "",
    "todomvc.ts": "",
    "tree.ts": ""
  },
  src: {
    "index.ts": "",
    internal: {
      "ansi.ts": "",
      "dom.ts": "",
      "flex.ts": "",
      "layout.ts": "",
      "styles.ts": "",
      "termdom.ts": ""
    }
  },
  tests: {
    "dom.test.ts": "",
    "flexbox.test.ts": ""
  },
  "LICENSE.md": "",
  "README.md": [
    "# TermDOM",
    "",
    "A DOM you can attach to a terminal: HTML in, cells out.",
    "Layout is CSS, input is events, and the caret is real.",
    "",
    "    npm install @b9g/termdom",
    ""
  ].join("\n"),
  "package.json": [
    "{",
    '	"name": "@b9g/termdom",',
    '	"version": "0.1.3",',
    '	"license": "MIT"',
    "}",
    ""
  ].join("\n")
};
var ROOT = {
  workspace: { termdom: REPO },
  home: { visitor: {} }
};
function segments(path) {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}
function lookup(path) {
  let node = ROOT;
  for (const part of segments(path)) {
    if (typeof node === "string") return void 0;
    const child = node[part];
    if (child === void 0) return void 0;
    node = child;
  }
  return node;
}
function readdirSync(path, _options) {
  const node = lookup(path);
  if (node === void 0) throw new Error(`ENOENT: ${path}`);
  if (typeof node === "string") throw new Error(`ENOTDIR: ${path}`);
  return Object.entries(node).map(([name, child]) => ({
    name,
    isDirectory: () => typeof child !== "string",
    isFile: () => typeof child === "string",
    isSymbolicLink: () => false
  }));
}
function readFileSync(path, _encoding) {
  const node = lookup(path);
  if (node === void 0) throw new Error(`ENOENT: ${path}`);
  if (typeof node !== "string") throw new Error(`EISDIR: ${path}`);
  return node;
}
function writeFileSync(path, contents) {
  const parts = segments(path);
  const name = parts.pop();
  if (!name) throw new Error(`EISDIR: ${path}`);
  const dir = lookup("/" + parts.join("/"));
  if (dir === void 0) throw new Error(`ENOENT: ${path}`);
  if (typeof dir === "string") throw new Error(`ENOTDIR: ${path}`);
  dir[name] = String(contents);
}
function mkdirSync(path, options) {
  let node = ROOT;
  for (const part of segments(path)) {
    const child = node[part];
    if (child === void 0) {
      if (!(options == null ? void 0 : options.recursive)) throw new Error(`ENOENT: ${path}`);
      node = node[part] = {};
    } else if (typeof child === "string") {
      throw new Error(`ENOTDIR: ${path}`);
    } else {
      node = child;
    }
  }
}
function join(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}
function resolve(path) {
  if (!path || path === ".") return FS_ROOT;
  if (path.startsWith("/")) return path.replace(/\/+/g, "/");
  return join(FS_ROOT, path);
}
function homedir() {
  return HOME;
}
function pathToFileURL(path) {
  const main = globalThis.__mainModuleURL;
  return new URL(main ?? `file://${resolve(path)}`);
}
export {
  FS_ROOT,
  HOME,
  homedir,
  join,
  mkdirSync,
  pathToFileURL,
  readFileSync,
  readdirSync,
  resolve,
  writeFileSync
};
