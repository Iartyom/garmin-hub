// Local test server: `node serve.mjs`, then open http://localhost:5174 (service workers need localhost or https).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root = new URL(".", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const types = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^([\\/])+/, "") || "index.html";
  if (p.includes("..") || p.startsWith("data")) { res.writeHead(403).end(); return; }   // never serve synced data
  try { const b = await readFile(join(root, p)); res.writeHead(200, { "Content-Type": types[extname(p)] || "application/octet-stream" }).end(b); }
  catch { res.writeHead(404).end("not found"); }
}).listen(5174, () => console.log("http://localhost:5174"));
