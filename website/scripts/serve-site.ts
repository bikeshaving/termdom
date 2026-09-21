/**
 * Serve dist/public from the calling process. An external single-threaded
 * server queues a page's asset requests behind the browser's kept-alive
 * connections and the checks time out on the queue, not the pages.
 */
import {createServer} from "node:http";
import {createReadStream, existsSync, statSync} from "node:fs";
import {extname, join, normalize} from "node:path";
import {fileURLToPath} from "node:url";

const MIME: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
};

export function serveSite(): Promise<string> {
	const root = fileURLToPath(new URL("../dist/public", import.meta.url));
	const server = createServer((req, res) => {
		const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
		let file = join(root, path);
		if (existsSync(file) && statSync(file).isDirectory()) {
			file = join(file, "index.html");
		}
		if (!file.startsWith(root) || !existsSync(file)) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
		});
		createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as {port: number};
			server.unref();
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}
