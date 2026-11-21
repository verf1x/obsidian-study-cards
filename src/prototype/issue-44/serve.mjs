import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? 4144);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/preview.css", ["preview.css", "text/css; charset=utf-8"]],
  ["/preview.js", ["preview.js", "text/javascript; charset=utf-8"]],
]);

createServer(async (request, response) => {
  const asset = files.get(request.url.split("?")[0]);
  if (!asset || request.method !== "GET") {
    response.writeHead(404).end();
    return;
  }
  const [file, contentType] = asset;
  try {
    const contents = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" }).end(contents);
  } catch {
    response.writeHead(500).end();
  }
}).listen(port, "127.0.0.1", () => console.log("Study Cards prototype · http://127.0.0.1:" + port));
