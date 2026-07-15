import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MODEL_ID = "gpt-5.5";
const DEFAULT_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const getCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const getConfigPath = () => join(getCodexHome(), "config.toml");
const getAuthPath = () => join(getCodexHome(), "auth.json");

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";
const isMissingFileError = (error) => error?.code === "ENOENT";

const parseJsonObject = (content, filePath) => {
  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) throw new Error("root value must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error?.message || String(error)}`);
  }
};

const readTextFile = async (filePath) => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
};

const readJsonObject = async (filePath) => {
  try {
    return parseJsonObject(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
};

const writeTextFileAtomic = async (filePath, content) => {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const writeJsonObject = (filePath, value) =>
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);

const snapshotFile = async (filePath) => {
  try {
    return { filePath, existed: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { filePath, existed: false, content: "" };
    throw error;
  }
};

const restoreSnapshot = async (snapshot) => {
  if (snapshot.existed) {
    await writeTextFileAtomic(snapshot.filePath, snapshot.content);
  } else {
    await rm(snapshot.filePath, { force: true });
  }
};

const unquoteTomlValue = (rawValue) => {
  const value = rawValue.trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  if (value.startsWith("'")) return value.match(/^'([^']*)'/)?.[1] || "";
  return value.split(/\s+#/)[0].trim();
};

const parseTomlKeyValue = (line) => {
  const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
  return match ? { key: match[1], value: unquoteTomlValue(match[2]) } : null;
};

const parseProviderSection = (line) => {
  const match = line.match(/^\s*\[model_providers\.(?:"((?:\\.|[^"\\])*)"|'([^']+)'|([^\]]+))\]\s*$/);
  if (!match) return "";
  if (match[1] !== undefined) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return (match[2] || match[3] || "").trim();
};

const getTopLevelValue = (content, key) => {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return "";
    if (!line || line.startsWith("#")) continue;
    const pair = parseTomlKeyValue(rawLine);
    if (pair?.key === key) return pair.value;
  }
  return "";
};

const escapeTomlString = (value) => JSON.stringify(value);
const tomlKey = (key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeTomlString(key);
const providerSectionHeader = (providerId) => `[model_providers.${tomlKey(providerId)}]`;

const setTopLevelValue = (content, key, value) => {
  const lines = content ? content.split(/\r?\n/) : [];
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const scanEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const nextLine = `${key} = ${escapeTomlString(value)}`;
  for (let index = 0; index < scanEnd; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  lines.splice(firstSectionIndex === -1 ? lines.length : firstSectionIndex, 0, nextLine);
  return lines.join("\n");
};

const getFirstProviderSectionId = (content) => {
  for (const line of content.split(/\r?\n/)) {
    const providerId = parseProviderSection(line);
    if (providerId) return providerId;
  }
  return "";
};

const upsertProviderValue = (content, providerId, key, value) => {
  const lines = content ? content.split(/\r?\n/) : [];
  const nextLine = `${key} = ${escapeTomlString(value)}`;
  let start = lines.findIndex((line) => parseProviderSection(line) === providerId);
  if (start === -1) {
    const suffix = lines.length > 0 && lines.at(-1).trim() ? [""] : [];
    return [...lines, ...suffix, providerSectionHeader(providerId), nextLine, ""].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  for (let index = start + 1; index < end; index += 1) {
    if (parseTomlKeyValue(lines[index])?.key === key) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  let insertIndex = end;
  while (insertIndex > start + 1 && !lines[insertIndex - 1].trim()) insertIndex -= 1;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
};

export const readProviderConfig = async () => {
  const [content, auth] = await Promise.all([
    readTextFile(getConfigPath()),
    readJsonObject(getAuthPath()),
  ]);
  const activeProviderId = getTopLevelValue(content, "model_provider") || undefined;
  const activeModelId = getTopLevelValue(content, "model") || DEFAULT_MODEL_ID;
  const providers = new Map();
  let currentProviderId = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const providerSection = parseProviderSection(rawLine);
    if (providerSection) {
      currentProviderId = providerSection;
      providers.set(providerSection, {
        providerId: providerSection,
        displayName: providerSection,
        baseUrl: "",
        apiKey: asString(auth.OPENAI_API_KEY),
        endpoint: "responses",
        models: [],
      });
      continue;
    }
    if (!currentProviderId) continue;
    const provider = providers.get(currentProviderId);
    const pair = parseTomlKeyValue(rawLine);
    if (!provider || !pair) continue;
    if (pair.key === "name") provider.displayName = pair.value || currentProviderId;
    if (pair.key === "base_url") provider.baseUrl = pair.value;
    if (pair.key === "wire_api") provider.endpoint = pair.value === "responses" ? "responses" : "chat-completions";
  }

  if (activeProviderId && !providers.has(activeProviderId)) {
    providers.set(activeProviderId, {
      providerId: activeProviderId,
      displayName: activeProviderId,
      baseUrl: "",
      apiKey: asString(auth.OPENAI_API_KEY),
      endpoint: "responses",
      models: [],
    });
  }
  for (const provider of providers.values()) {
    provider.apiKey = asString(auth.OPENAI_API_KEY);
    provider.models = [{ id: activeModelId, name: activeModelId, reasoning: true, imageInput: true }];
  }
  return { activeProviderId, providers: Array.from(providers.values()) };
};

export const activateProvider = async (provider) => {
  if (!isRecord(provider)) throw new Error("Codex provider configuration is invalid.");
  const baseUrl = asString(provider.baseUrl);
  const apiKey = asString(provider.apiKey);
  const selectedModel = asString(provider.models?.[0]?.id) || DEFAULT_MODEL_ID;
  if (!baseUrl) throw new Error("Codex provider base URL is empty.");
  if (!apiKey) throw new Error("Codex provider API key is empty.");

  const configPath = getConfigPath();
  const authPath = getAuthPath();
  const snapshots = await Promise.all([snapshotFile(configPath), snapshotFile(authPath)]);
  let content = snapshots[0].content;
  const auth = snapshots[1].existed ? parseJsonObject(snapshots[1].content, authPath) : {};
  const activeNativeProviderId = getTopLevelValue(content, "model_provider");
  const firstNativeProviderId = getFirstProviderSectionId(content);
  const targetProviderId = activeNativeProviderId || firstNativeProviderId || "openai";

  content = setTopLevelValue(content, "model_provider", targetProviderId);
  content = setTopLevelValue(content, "model", selectedModel);
  content = upsertProviderValue(content, targetProviderId, "base_url", baseUrl);
  content = upsertProviderValue(content, targetProviderId, "wire_api", provider.endpoint === "responses" ? "responses" : "chat");
  auth.OPENAI_API_KEY = apiKey;

  try {
    await writeTextFileAtomic(configPath, content.endsWith("\n") ? content : `${content}\n`);
    await writeJsonObject(authPath, auth);
    return { snapshots };
  } catch (error) {
    await Promise.allSettled(snapshots.map(restoreSnapshot));
    throw error;
  }
};

export const getDefaultThinkingLevel = async () => {
  const value = getTopLevelValue(await readTextFile(getConfigPath()), "model_reasoning_effort").toLowerCase();
  if (value === "none") return "off";
  return VALID_THINKING_LEVELS.has(value) ? value : DEFAULT_THINKING_LEVEL;
};
