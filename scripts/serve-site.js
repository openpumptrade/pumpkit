import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/// Static preview of site/ — `npm run site`. No dependencies.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const TYPES = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".json": "application/json" };
const port = Number(process.env.PORT || 4173);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body); }
  catch { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); }
}).listen(port, () => console.log(`site → http://localhost:${port}`));
