import { createReadStream, existsSync, statSync } from "fs";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
import { extname, isAbsolute } from "path";

/**
 * 本地视频流的 HTTP 服务。
 *
 * Chromium 的媒体加载安全检查只接受 http/https/file/data/blob，
 * Electron 的自定义协议（即使 standard+secure）会被
 * `Media load rejected by URL safety check` 拒绝，所以视频预览改走
 * 一个只监听 127.0.0.1 的临时 HTTP 服务：
 * - 随机端口 + 每次启动随机 token，外部站点无法构造 URL；
 * - 支持 Range，播放器可以拖动进度条；
 * - 只读取绝对路径且必须是已存在的文件（拒绝目录）。
 */
const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ts": "video/mp2t",
  ".3gp": "video/3gpp",
};

export interface LocalMediaServer {
  /** 渲染进程拼 URL 用：`${baseUrl}${encodeURIComponent(path)}`。 */
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

const fileMimeType = (filePath: string) =>
  VIDEO_MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";

const parseRange = (header: string | undefined, size: number) => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  let start = rawStart ? Number.parseInt(rawStart, 10) : size - Number.parseInt(rawEnd, 10);
  let end = rawStart && rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return null;
  return { start, end };
};

export const createLocalMediaServer = (): Promise<LocalMediaServer> => {
  const token = randomUUID();
  const prefix = `/media/${token}/`;
  let server: Server | null = null;

  server = createServer((request, response) => {
    const respond = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(message);
    };

    let pathname = "";
    try {
      pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    } catch {
      respond(400, "Bad Request");
      return;
    }
    if (!pathname.startsWith(prefix)) {
      respond(403, "Forbidden");
      return;
    }

    let filePath = "";
    try {
      filePath = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      respond(400, "Bad Request");
      return;
    }
    if (!filePath || !isAbsolute(filePath) || !existsSync(filePath)) {
      respond(404, "Not Found");
      return;
    }
    let size = 0;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) {
        respond(404, "Not Found");
        return;
      }
      size = stats.size;
    } catch {
      respond(404, "Not Found");
      return;
    }

    const headers: Record<string, string | number> = {
      "Content-Type": fileMimeType(filePath),
      "Accept-Ranges": "bytes",
      // 本地文件可能被外部程序改写，不缓存，避免播放到旧内容。
      "Cache-Control": "no-store",
    };
    const range = parseRange(request.headers.range, size);
    if (!range) {
      response.writeHead(200, { ...headers, "Content-Length": size });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
      return;
    }

    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": range.end - range.start + 1,
    });
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}${prefix}`,
        port,
        close: () => new Promise<void>((done) => {
          server!.close(() => done());
        }),
      });
    });
  });
};
