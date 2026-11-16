/**
 * 提交信息历史：只记录本工具提交成功过的消息，按仓库分开存。
 * 展示时还会和 git log 合并，所以新仓库里也能看到已有的提交消息。
 */
const STORAGE_KEY = "hpp.git.commitHistory.v1";
const MAX_ITEMS = 30;

type CommitHistoryStore = Record<string, string[]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 仓库键统一成小写正斜杠路径：Windows 下大小写、分隔符不同也共用一份历史。 */
const repoKeyOf = (repoPath: string) =>
  repoPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const readStore = (): CommitHistoryStore => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!isRecord(parsed)) return {};
    const store: CommitHistoryStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const items = value.filter((item): item is string => typeof item === "string" && !!item.trim());
      if (items.length > 0) store[key] = items;
    }
    return store;
  } catch {
    return {};
  }
};

export const readCommitHistory = (repoPath: string): string[] =>
  readStore()[repoKeyOf(repoPath)] || [];

export const rememberCommitMessage = (repoPath: string, message: string): void => {
  const text = message.trim();
  if (!text) return;
  try {
    const store = readStore();
    const key = repoKeyOf(repoPath);
    const current = store[key] || [];
    store[key] = [text, ...current.filter((item) => item !== text)].slice(0, MAX_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage 不可用（隐私模式 / 配额满）时静默跳过，不能影响提交本身。
  }
};
