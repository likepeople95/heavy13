/**
 * 로컬 개발 서버: public/ 정적 파일 + /api/room (Vercel 함수와 같은 핸들러).
 * Redis 환경변수가 없으면 메모리 저장소를 쓴다 (서버를 끄면 방이 사라짐).
 *   npm run dev  →  http://localhost:3000
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/room.js";
import { getStore } from "./lib/store.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/room") return handler(req, res);
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    try {
      const data = await readFile(join(root, path));
      res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`무거운 13 개발 서버: http://localhost:${port}  (저장소: ${getStore()?.kind})`);
  });
}
