import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? 4160);
const fixture = "../../../fixtures/test-vault/Материалы/";
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/preview.css", ["preview.css", "text/css; charset=utf-8"]],
  ["/preview.js", ["preview.js", "text/javascript; charset=utf-8"]],
  ["/http.txt", [fixture + "HTTP — 100 вопросов.md", "text/plain; charset=utf-8"]],
  ["/cache.txt", [fixture + "Кэш браузера.md", "text/plain; charset=utf-8"]],
  ["/cheat.txt", [fixture + "Шпаргалка HTTP.md", "text/plain; charset=utf-8"]],
]);

createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, "http://localhost").pathname);
  if (!asset || request.method !== "GET") {
    response.writeHead(404).end();
    return;
  }
  const [file, type] = asset;
  try {
    const data = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(data);
  } catch {
    response.writeHead(500).end();
  }
}).listen(port, "127.0.0.1", () => console.log("Study Cards prototype · http://127.0.0.1:" + port));
