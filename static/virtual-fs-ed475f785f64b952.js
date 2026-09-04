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
    guides: {},
    "dom-conformance.md": "",
    "cssom-conformance.md": ""
  },
  examples: {},
  src: {
    "index.ts": "",
    internal: {
      "cssom.ts": "",
      "dom.ts": "",
      "exchange.ts": "",
      "htmltables.ts": "",
      "input.ts": "",
      "inspector.ts": "",
      "layout.ts": "",
      "painter.ts": "",
      "screen.ts": "",
      "termdom.ts": "",
      "text.ts": "",
      "useragent.ts": ""
    }
  },
  tests: {
    "dom.test.ts": "",
    "cascade.test.ts": "",
    "flexbox.test.ts": ""
  },
  LICENSE: "",
  "README.md": "",
  "package.json": ""
};
var seeded = globalThis.__workspaceFiles;
if (seeded !== void 0) {
  for (const [path, contents] of Object.entries(seeded)) {
    const parts = path.split("/");
    const name = parts.pop();
    let node = REPO;
    for (const part of parts) {
      const child = node[part];
      node = typeof child === "object" ? child : node[part] = {};
    }
    node[name] = contents;
  }
}
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
function resolve(...parts) {
  let path = "";
  for (let i = parts.length - 1; i >= 0 && !path.startsWith("/"); i--) {
    if (parts[i]) {
      path = path === "" ? parts[i] : `${parts[i]}/${path}`;
    }
  }
  if (!path.startsWith("/")) {
    path = `${FS_ROOT}/${path}`;
  }
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
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
