import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_PRESENTED_FILES = 20;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";

/** 模型可能传 files / paths，也可能传单个字符串；统一成去重后的字符串数组。 */
export const normalizePresentedPaths = (value) => {
  const raw = isRecord(value) ? value.files ?? value.paths : value;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const seen = new Set();
  const paths = [];
  for (const item of list) {
    const path = asString(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_PRESENTED_FILES) break;
  }
  return paths;
};

/**
 * 把相对路径绑到会话工作目录：产物清单要能直接点开，落盘给宿主的必须是绝对路径。
 * 已经是绝对路径的原样返回。
 */
export const resolvePresentedPath = (path, cwd) => {
  const normalized = asString(path);
  if (!normalized) return "";
  if (isAbsolute(normalized)) return normalized;
  const base = asString(cwd);
  return base ? resolve(base, normalized) : normalized;
};

/**
 * Hpp 的产物声明工具。只有模型显式调用它，宿主才把文件当成交付物呈现；
 * 未调用时回退到基于写盘记录的推断（见 src/lib/message-artifacts.ts）。
 */
export const createHppPresentExtension = ({
  getWorkspaceRoot = () => process.cwd(),
} = {}) => (pi) => {
  if (!pi || typeof pi.registerTool !== "function") return;

  pi.registerTool({
    name: "present_files",
    label: "Present Files",
    description: [
      "把这次任务真正交付给用户的成品文件呈现出来。",
      "只在已经写出成品（报告、表格、文档、网页、图片、安装包等）后调用一次；",
      "中间脚本、日志、缓存、调试截图不要列进来。",
      "按用户实际要的东西声明 1-5 个文件即可，不要列整个目录。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "成品文件的路径（绝对路径；相对路径按当前工作目录解析）",
          items: { type: "string" },
        },
        summary: {
          type: "string",
          description: "一句话说明交付了什么，会显示在产物区",
        },
      },
      required: ["files"],
      additionalProperties: false,
    },

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = isRecord(rawParams) ? rawParams : {};
      const cwd = asString(ctx?.cwd) || getWorkspaceRoot();
      const requested = normalizePresentedPaths(params);
      if (requested.length === 0) {
        return {
          content: [{ type: "text", text: "present_files 需要一个非空的 files 数组（成品文件路径）。" }],
          details: { files: [], missing: [] },
          isError: true,
        };
      }

      // 不存在的路径不静默丢掉：模型写错路径时要能立刻看到，否则用户会以为产物丢了。
      const files = [];
      const missing = [];
      for (const path of requested) {
        const absolute = resolvePresentedPath(path, cwd);
        try {
          const info = await stat(absolute);
          if (info.isFile()) files.push(absolute);
          else missing.push(absolute);
        } catch {
          missing.push(absolute);
        }
      }

      if (files.length === 0) {
        return {
          content: [{ type: "text", text: `没有找到可呈现的文件：${missing.join("、")}` }],
          details: { files: [], missing },
          isError: true,
        };
      }

      const summary = asString(params.summary);
      const lines = [
        summary ? `${summary}` : "已呈现交付物：",
        ...files.map((file) => `- ${file}`),
        ...(missing.length > 0 ? [`未找到（已跳过）：${missing.join("、")}`] : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { files, missing, ...(summary ? { summary } : {}) },
      };
    },
  });
};
