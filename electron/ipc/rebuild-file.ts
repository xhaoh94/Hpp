import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  extractChangePatch,
  extractHunkPatch,
  parsePatchHunks,
} from "../../shared/patch-split";
import type {
  PrepareReviewUndoRequest,
  ReviewUndoFileState,
  ReviewUndoFileStatus,
  ReviewUndoLoadResult,
  ReviewUndoResult,
  ReviewUndoSourceFile,
  ReviewUndoState,
  ReviewUndoTarget,
} from "../../shared/review-undo";
import {
  defaultRunGitApply,
  getFailureDetail,
  type RunGitApply,
} from "./reverse-apply-patches";

const MANIFEST_VERSION = 1;
const MAX_REVIEW_FILES = 500;
const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PATCH_BINARY = /^(?:GIT binary patch|Binary files\s)/m;
const PATCH_RENAME_OR_COPY = /^(?:rename|copy) (?:from|to)\s|^similarity index\s/m;
const PATCH_MODE_ONLY = /^(?:old mode|new mode)\s/m;
const HUNK_HEADER = /^@@\s/m;

type Snapshot = {
  exists: boolean;
  content: Buffer | null;
  hash: string;
  mode: number;
};

type StoredSnapshot = {
  exists: boolean;
  hash: string;
  mode: number;
  file?: string;
};

type ManifestFile = {
  sourceFile: string;
  relativePath: string;
  status?: string;
  statusExplicit?: boolean;
  supported: boolean;
  error?: string;
  baseline?: StoredSnapshot;
  expected?: StoredSnapshot;
};

type PendingFile = {
  fileIndex: number;
  before: StoredSnapshot;
  after: StoredSnapshot;
};

type PendingOperation = {
  id: string;
  targetVersion: number;
  snapshotDir: string;
  files: PendingFile[];
};

type ReviewManifest = {
  schemaVersion: number;
  transactionId: string;
  reviewId: string;
  sourceHash: string;
  projectPath: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  files: ManifestFile[];
  pending?: PendingOperation;
};

type ReviewUndoServiceOptions = {
  stateRoot: string;
  backupRoot: string;
  runGitApply?: RunGitApply;
};

const hashBytes = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const snapshotHash = (exists: boolean, content: Buffer | null, mode: number) => {
  const hash = createHash("sha256");
  hash.update(exists ? "file\0" : "missing\0");
  hash.update(String(mode));
  hash.update("\0");
  if (content) hash.update(content);
  return hash.digest("hex");
};

const toStoredSnapshot = (snapshot: Snapshot, file?: string): StoredSnapshot => ({
  exists: snapshot.exists,
  hash: snapshot.hash,
  mode: snapshot.mode,
  ...(file ? { file } : {}),
});

const normalizeSlashes = (value: string) => value.replace(/\\/g, "/");

const formatGitPatchPath = (value: string) =>
  /[\s"\\]/.test(value) ? JSON.stringify(value) : value;

const isPathInside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const normalizeStatus = (value?: string): ReviewUndoFileStatus => {
  if (value === "added" || value === "created") return "added";
  if (value === "deleted") return "deleted";
  return "modified";
};

const countPatchChanges = (patch: string) => ({
  additions: parsePatchHunks(patch).reduce(
    (sum, hunk) => sum + hunk.rows.filter((row) => row.type === "add").length,
    0,
  ),
  deletions: parsePatchHunks(patch).reduce(
    (sum, hunk) => sum + hunk.rows.filter((row) => row.type === "del").length,
    0,
  ),
});

const writeFileDurably = (filePath: string, content: Buffer | string) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  const fd = openSync(filePath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeJsonAtomic = (filePath: string, value: unknown) => {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileDurably(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
};

const readSnapshot = (filePath: string): Snapshot => {
  if (!existsSync(filePath)) {
    return {
      exists: false,
      content: null,
      mode: 0,
      hash: snapshotHash(false, null, 0),
    };
  }
  const info = lstatSync(filePath);
  if (info.isSymbolicLink()) throw new Error("符号链接文件不支持审核撤销");
  if (!info.isFile()) throw new Error("目标路径不是普通文件");
  if (info.size > MAX_FILE_BYTES) throw new Error("文件过大，无法创建安全撤销快照");
  const content = readFileSync(filePath);
  if (content.includes(0)) throw new Error("二进制文件不支持审核撤销");
  const mode = info.mode & 0o777;
  return {
    exists: true,
    content,
    mode,
    hash: snapshotHash(true, content, mode),
  };
};

const storedSnapshotContent = (stateDir: string, stored: StoredSnapshot): Snapshot => {
  if (!stored.exists) {
    return {
      exists: false,
      content: null,
      mode: 0,
      hash: snapshotHash(false, null, 0),
    };
  }
  if (!stored.file) throw new Error("撤销快照缺少内容文件");
  const content = readFileSync(join(stateDir, stored.file));
  const hash = snapshotHash(true, content, stored.mode);
  if (hash !== stored.hash) throw new Error("撤销快照校验失败");
  return { exists: true, content, mode: stored.mode, hash };
};

const materializeSnapshot = (root: string, relativePath: string, snapshot: Snapshot) => {
  const target = join(root, relativePath);
  if (!snapshot.exists) {
    rmSync(target, { force: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, snapshot.content as Buffer);
  try {
    chmodSync(target, snapshot.mode);
  } catch {
    // Windows may not expose every POSIX mode bit. Content safety does not depend on chmod.
  }
};

const readMaterializedSnapshot = (root: string, relativePath: string): Snapshot => {
  const snapshot = readSnapshot(join(root, relativePath));
  return snapshot;
};

const decodeGitQuotedPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed.split("\t", 1)[0];
  const bytes: number[] = [];
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '"') return Buffer.from(bytes).toString("utf8");
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    index += 1;
    const escaped = trimmed[index];
    if (escaped === undefined) break;
    const escapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    if (escaped in escapes) {
      bytes.push(escapes[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(trimmed[index + 1] || "")) {
        index += 1;
        octal += trimmed[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(...Buffer.from(escaped));
  }
  throw new Error("补丁路径引号不完整");
};

const normalizePatchHeaderPath = (
  value: string,
  projectPath: string,
  expectedRelativePath: string,
) => {
  if (value === "/dev/null") return "/dev/null";
  let candidate = normalizeSlashes(value);
  if (/^[ab]\//.test(candidate)) candidate = candidate.slice(2);
  if (candidate.startsWith("./")) candidate = candidate.slice(2);
  if (isAbsolute(candidate)) candidate = normalizeSlashes(relative(projectPath, candidate));
  const expected = normalizeSlashes(expectedRelativePath);
  const matches = process.platform === "win32"
    ? candidate.toLowerCase() === expected.toLowerCase()
    : candidate === expected;
  if (!matches) throw new Error("补丁包含目标文件之外的路径");
  return candidate;
};

const normalizePatchForFile = (
  patch: string,
  projectPath: string,
  relativePath: string,
  status: string | undefined,
  statusExplicit: boolean,
  currentExists: boolean,
) => {
  // 尾部只能去掉换行符本身：CRLF 文件补丁最后一行的 \r 是内容，
  // trimEnd 会把它当空白剥掉，git apply 从此对不上磁盘。
  const trimmed = patch.replace(/\n+$/, "");
  if (!trimmed) throw new Error("补丁内容为空");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PATCH_BYTES) throw new Error("补丁过大");
  if (PATCH_BINARY.test(trimmed)) throw new Error("二进制补丁不支持审核撤销");
  if (PATCH_RENAME_OR_COPY.test(trimmed)) throw new Error("重命名或复制补丁不支持单文件撤销");
  if (PATCH_MODE_ONLY.test(trimmed)) throw new Error("文件模式补丁不支持内容撤销");

  const lines = trimmed.split("\n");
  const sections = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (sections > 1) throw new Error("一个补丁包含多个文件，无法安全执行单文件撤销");

  const oldHeaders = lines.filter((line) => /^---\s/.test(line));
  const newHeaders = lines.filter((line) => /^\+\+\+\s/.test(line));
  const hunks = parsePatchHunks(trimmed);
  const metadataAddsEmptyFile = lines.some((line) => /^new file mode\s/.test(line));
  const metadataDeletesEmptyFile = lines.some((line) => /^deleted file mode\s/.test(line));
  if (hunks.length === 0 || !HUNK_HEADER.test(trimmed)) {
    if (metadataAddsEmptyFile === metadataDeletesEmptyFile || sections !== 1) {
      throw new Error("补丁没有可撤销的文本 hunk");
    }
    const diffHeader = lines.find((line) => line.startsWith("diff --git ")) || "";
    const safeRelativePath = normalizeSlashes(relativePath);
    const rawExpectedHeader = `diff --git a/${safeRelativePath} b/${safeRelativePath}`;
    const expectedHeader = `diff --git ${formatGitPatchPath(`a/${safeRelativePath}`)} ${formatGitPatchPath(`b/${safeRelativePath}`)}`;
    if (diffHeader !== rawExpectedHeader && diffHeader !== expectedHeader) {
      throw new Error("补丁包含目标文件之外的路径");
    }
    const modeLine = lines.find((line) =>
      metadataAddsEmptyFile ? /^new file mode\s/.test(line) : /^deleted file mode\s/.test(line)
    );
    if (!modeLine || !/^(?:new file mode|deleted file mode) 100(?:644|755)$/.test(modeLine)) {
      throw new Error("空文件补丁包含不支持的文件模式");
    }
    return [
      expectedHeader,
      modeLine,
      metadataAddsEmptyFile ? "index 0000000..e69de29" : "index e69de29..0000000",
    ].join("\n");
  }

  let oldPath: string;
  let newPath: string;
  if (oldHeaders.length === 0 && newHeaders.length === 0) {
    const normalizedStatus = normalizeStatus(status);
    const looksLikeWholeFileAdd = hunks.every((hunk) =>
      hunk.oldStart === 0
      && hunk.oldCount === 0
      && hunk.rows.every((row) => row.type === "add")
    );
    if (looksLikeWholeFileAdd && !(statusExplicit && normalizedStatus === "added")) {
      throw new Error("无文件头的纯新增补丁无法确认文件原本是否存在，已禁用撤销");
    }
    const looksLikeWholeFileDelete = hunks.every((hunk) =>
      hunk.newStart === 0
      && hunk.newCount === 0
      && hunk.rows.every((row) => row.type === "del")
    );
    if (looksLikeWholeFileDelete && !currentExists && !(statusExplicit && normalizedStatus === "deleted")) {
      throw new Error("无文件头的纯删除补丁无法确认文件原本是否存在，已禁用撤销");
    }
    const createsFile = statusExplicit && normalizedStatus === "added";
    const deletesFile = statusExplicit && normalizedStatus === "deleted";
    oldPath = createsFile ? "/dev/null" : `a/${normalizeSlashes(relativePath)}`;
    newPath = deletesFile ? "/dev/null" : `b/${normalizeSlashes(relativePath)}`;
  } else {
    if (oldHeaders.length !== 1 || newHeaders.length !== 1) {
      throw new Error("补丁文件头不完整或包含多个文件");
    }
    oldPath = decodeGitQuotedPath(oldHeaders[0].slice(4));
    newPath = decodeGitQuotedPath(newHeaders[0].slice(4));
    normalizePatchHeaderPath(oldPath, projectPath, relativePath);
    normalizePatchHeaderPath(newPath, projectPath, relativePath);
    if (oldPath === "/dev/null" && newPath === "/dev/null") {
      throw new Error("补丁文件头无效");
    }
  }

  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const body = lines.slice(firstHunk);
  const safeRelativePath = normalizeSlashes(relativePath);
  const fileModeLine = lines.slice(0, firstHunk).find((line) =>
    /^(?:new file mode|deleted file mode) 100(?:644|755)$/.test(line)
  );
  return [
    `diff --git ${formatGitPatchPath(`a/${safeRelativePath}`)} ${formatGitPatchPath(`b/${safeRelativePath}`)}`,
    ...(fileModeLine ? [fileModeLine] : []),
    `--- ${oldPath === "/dev/null" ? oldPath : formatGitPatchPath(`a/${safeRelativePath}`)}`,
    `+++ ${newPath === "/dev/null" ? newPath : formatGitPatchPath(`b/${safeRelativePath}`)}`,
    ...body,
  ].join("\n");
};

const generateCanonicalPatch = (
  relativePath: string,
  baseline: Snapshot,
  current: Snapshot,
) => {
  if (baseline.hash === current.hash) return "";
  const root = mkdtempSync(join(tmpdir(), "hpp-review-diff-"));
  try {
    const oldRoot = join(root, "old");
    const newRoot = join(root, "new");
    materializeSnapshot(oldRoot, relativePath, baseline);
    materializeSnapshot(newRoot, relativePath, current);
    const oldPath = baseline.exists ? normalizeSlashes(join("old", relativePath)) : "/dev/null";
    const newPath = current.exists ? normalizeSlashes(join("new", relativePath)) : "/dev/null";
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--",
        oldPath,
        newPath,
      ],
      {
        cwd: root,
        encoding: "utf-8",
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_PATCH_BYTES,
      },
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      const detail = result.error?.message || String(result.stderr || "Git diff failed").trim();
      throw new Error(detail || "Git diff failed");
    }
    // git diff 的 stdout 对 CRLF 文件以 "\r\n" 结尾，\r 属于最后一行内容，
    // trimEnd 会剥掉它。只去尾随换行符本身。
    const generated = String(result.stdout || "").replace(/\n+$/, "");
    const lines = generated.split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    const safeRelativePath = normalizeSlashes(relativePath);
    const metadata = !baseline.exists && current.exists
      ? [`new file mode ${current.mode === 0o755 ? "100755" : "100644"}`]
      : baseline.exists && !current.exists
        ? [`deleted file mode ${baseline.mode === 0o755 ? "100755" : "100644"}`]
        : [];
    const body = firstHunk >= 0 ? lines.slice(firstHunk) : [];
    if (body.length === 0 && metadata.length === 0) {
      throw new Error("无法生成文本内容差异");
    }
    return [
      `diff --git ${formatGitPatchPath(`a/${safeRelativePath}`)} ${formatGitPatchPath(`b/${safeRelativePath}`)}`,
      ...metadata,
      `--- ${baseline.exists ? formatGitPatchPath(`a/${safeRelativePath}`) : "/dev/null"}`,
      `+++ ${current.exists ? formatGitPatchPath(`b/${safeRelativePath}`) : "/dev/null"}`,
      ...body,
    ].join("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const applyPatchToSnapshot = (
  relativePath: string,
  snapshot: Snapshot,
  patch: string,
  reverse: boolean,
  runGitApply: RunGitApply,
) => {
  const worktree = mkdtempSync(join(tmpdir(), "hpp-review-apply-"));
  try {
    materializeSnapshot(worktree, relativePath, snapshot);
    const result = runGitApply(worktree, patch, reverse);
    if (result.error || result.status !== 0) {
      throw new Error(getFailureDetail(result));
    }
    const next = readMaterializedSnapshot(worktree, relativePath);
    if (next.exists) {
      const mode = snapshot.exists ? snapshot.mode : next.mode;
      return {
        ...next,
        mode,
        hash: snapshotHash(true, next.content, mode),
      };
    }
    return next;
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
};

const snapshotEquals = (left: Snapshot, right: Snapshot) => left.hash === right.hash;

const writeSnapshotAtomic = (
  filePath: string,
  snapshot: Snapshot,
  expectedCurrentHash?: string,
) => {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!snapshot.exists) {
    if (!existsSync(filePath)) {
      if (expectedCurrentHash && readSnapshot(filePath).hash !== expectedCurrentHash) {
        throw new Error("文件在最终提交前被外部修改");
      }
      return;
    }
    if (expectedCurrentHash && readSnapshot(filePath).hash !== expectedCurrentHash) {
      throw new Error("文件在最终提交前被外部修改");
    }
    const tombstone = join(dirname(filePath), `.${randomUUID()}.hpp-delete`);
    renameSync(filePath, tombstone);
    try {
      if (expectedCurrentHash && readSnapshot(tombstone).hash !== expectedCurrentHash) {
        renameSync(tombstone, filePath);
        throw new Error("文件在最终提交前被外部修改");
      }
    } catch (error) {
      if (existsSync(tombstone) && !existsSync(filePath)) renameSync(tombstone, filePath);
      throw error;
    }
    rmSync(tombstone, { force: true });
    return;
  }
  const tempPath = join(dirname(filePath), `.${randomUUID()}.hpp-write`);
  writeFileDurably(tempPath, snapshot.content as Buffer);
  try {
    try {
      chmodSync(tempPath, snapshot.mode);
    } catch {
      // See materializeSnapshot: chmod is best-effort on Windows.
    }
    if (expectedCurrentHash && readSnapshot(filePath).hash !== expectedCurrentHash) {
      throw new Error("文件在最终提交前被外部修改");
    }
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
};

export class ReviewUndoService {
  private readonly stateRoot: string;
  private readonly backupRoot: string;
  private readonly runGitApply: RunGitApply;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: ReviewUndoServiceOptions) {
    this.stateRoot = options.stateRoot;
    this.backupRoot = options.backupRoot;
    this.runGitApply = options.runGitApply || defaultRunGitApply;
  }

  load(request: PrepareReviewUndoRequest): Promise<ReviewUndoLoadResult> {
    let projectPath: string;
    let transactionId: string;
    try {
      ({ projectPath, transactionId } = this.validatePrepareRequest(request));
      void projectPath;
    } catch (error) {
      return Promise.resolve({ success: false, error: this.errorMessage(error) });
    }
    return this.enqueue(transactionId, () => {
      try {
        const stateDir = join(this.stateRoot, transactionId);
        if (!existsSync(join(stateDir, "manifest.json"))) {
          return { success: true, state: null };
        }
        const manifest = this.loadManifest(transactionId);
        this.recoverPending(stateDir, manifest);
        return { success: true, state: this.buildState(stateDir, manifest) };
      } catch (error) {
        return { success: false, error: this.errorMessage(error) };
      }
    });
  }

  prepare(request: PrepareReviewUndoRequest): Promise<ReviewUndoResult> {
    let projectPath: string;
    let transactionId: string;
    let sourceHash: string;
    try {
      ({ projectPath, transactionId, sourceHash } = this.validatePrepareRequest(request));
    } catch (error) {
      return Promise.resolve({ success: false, error: this.errorMessage(error) });
    }
    return this.enqueue(transactionId, () => {
      try {
        return this.prepareLocked(request, projectPath, transactionId, sourceHash);
      } catch (error) {
        return { success: false, error: this.errorMessage(error) };
      }
    });
  }

  apply(
    transactionId: string,
    expectedVersion: number,
    target: ReviewUndoTarget,
  ): Promise<ReviewUndoResult> {
    if (!/^[a-f\d]{64}$/.test(transactionId)) {
      return Promise.resolve({ success: false, error: "Invalid review transaction" });
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return Promise.resolve({ success: false, error: "Invalid review version" });
    }
    return this.enqueue(transactionId, () => {
      try {
        return this.applyLocked(transactionId, expectedVersion, target);
      } catch (error) {
        return { success: false, error: this.errorMessage(error) };
      }
    });
  }

  private enqueue<T>(key: string, action: () => T): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.queues.set(key, queued);
    return previous
      .catch(() => undefined)
      .then(action)
      .finally(() => {
        release();
        if (this.queues.get(key) === queued) this.queues.delete(key);
      });
  }

  private validatePrepareRequest(request: PrepareReviewUndoRequest) {
    if (!request || typeof request !== "object") throw new Error("Invalid review request");
    if (typeof request.reviewId !== "string" || !request.reviewId.trim() || request.reviewId.length > 2048) {
      throw new Error("Invalid review id");
    }
    if (typeof request.projectPath !== "string" || !request.projectPath.trim()) {
      throw new Error("Invalid project path");
    }
    if (!Array.isArray(request.files) || request.files.length === 0 || request.files.length > MAX_REVIEW_FILES) {
      throw new Error("Invalid review files");
    }
    const projectPath = realpathSync(resolve(request.projectPath));
    if (!statSync(projectPath).isDirectory()) throw new Error("Project path is not a directory");
    const sourceJson = JSON.stringify(request.files);
    if (Buffer.byteLength(sourceJson, "utf8") > MAX_PATCH_BYTES) throw new Error("Review patch data is too large");
    const sourceHash = hashBytes(sourceJson);
    const transactionId = hashBytes(`${projectPath}\0${request.reviewId}\0${sourceHash}`);
    return { projectPath, sourceHash, transactionId };
  }

  private prepareLocked(
    request: PrepareReviewUndoRequest,
    projectPath: string,
    transactionId: string,
    sourceHash: string,
  ): ReviewUndoResult {
    this.removeStaleTemporaryState(transactionId);
    mkdirSync(this.stateRoot, { recursive: true });
    mkdirSync(this.backupRoot, { recursive: true });
    const stateDir = join(this.stateRoot, transactionId);
    const manifestPath = join(stateDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = this.loadManifest(transactionId);
      this.recoverPending(stateDir, manifest);
      return { success: true, state: this.buildState(stateDir, manifest) };
    }

    const tempStateDir = `${stateDir}.${process.pid}.${randomUUID()}.tmp`;
    rmSync(tempStateDir, { recursive: true, force: true });
    mkdirSync(join(tempStateDir, "baseline"), { recursive: true });
    try {
      const grouped = this.groupSourceFiles(request.files, projectPath);
      const files = grouped.map((source, index) => this.prepareFile(
        tempStateDir,
        projectPath,
        source,
        index,
      ));
      const now = Date.now();
      const manifest: ReviewManifest = {
        schemaVersion: MANIFEST_VERSION,
        transactionId,
        reviewId: request.reviewId,
        sourceHash,
        projectPath,
        version: 0,
        createdAt: now,
        updatedAt: now,
        files,
      };
      writeJsonAtomic(join(tempStateDir, "manifest.json"), manifest);
      if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
      renameSync(tempStateDir, stateDir);
      return { success: true, state: this.buildState(stateDir, manifest) };
    } finally {
      rmSync(tempStateDir, { recursive: true, force: true });
    }
  }

  private removeStaleTemporaryState(transactionId: string) {
    if (!existsSync(this.stateRoot)) return;
    const prefix = `${transactionId}.`;
    for (const entry of readdirSync(this.stateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp")) {
        rmSync(join(this.stateRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  private groupSourceFiles(files: ReviewUndoSourceFile[], projectPath: string) {
    const grouped = new Map<string, ReviewUndoSourceFile & { relativePath: string }>();
    for (const source of files) {
      if (!source || typeof source.file !== "string" || !source.file.trim()) continue;
      const resolved = this.resolveTarget(projectPath, source.file, false);
      const key = process.platform === "win32" ? resolved.relativePath.toLowerCase() : resolved.relativePath;
      const existing = grouped.get(key);
      const patches = Array.isArray(source.patches)
        ? source.patches.filter((patch): patch is string => typeof patch === "string" && !!patch.trim())
        : [];
      if (existing) {
        for (const patch of patches) {
          if (!existing.patches.includes(patch)) existing.patches.push(patch);
        }
        if (source.status) existing.status = source.status;
        if (source.statusExplicit) existing.statusExplicit = true;
      } else {
        grouped.set(key, {
          file: source.file,
          patches: [...new Set(patches)],
          status: source.status,
          statusExplicit: source.statusExplicit === true,
          relativePath: resolved.relativePath,
        });
      }
    }
    if (grouped.size === 0) throw new Error("No review files");
    return [...grouped.values()];
  }

  private prepareFile(
    stateDir: string,
    projectPath: string,
    source: ReviewUndoSourceFile & { relativePath: string },
    index: number,
  ): ManifestFile {
    const base: ManifestFile = {
      sourceFile: source.file,
      relativePath: source.relativePath,
      status: source.status,
      statusExplicit: source.statusExplicit,
      supported: false,
    };
    try {
      if (source.patches.length === 0) {
        // provider 只回报了文件路径与增删计数却没给补丁时，后端本应在工具执行前
        // 抓快照、执行后自算差异。走到这里说明兜底也没算出补丁（例如文件是二进制、
        // 过大，或 provider 未流式下发 pending 状态导致快照抓晚了），只能诚实拒绝。
        throw new Error("当前变更没有文本补丁，且无法从磁盘内容推导出差异");
      }
      const target = this.resolveTarget(projectPath, source.relativePath, true);
      const current = readSnapshot(target.filePath);
      const normalized = source.patches.map((patch) => normalizePatchForFile(
        patch,
        projectPath,
        source.relativePath,
        source.status,
        source.statusExplicit === true,
        current.exists,
      ));

      const worktree = mkdtempSync(join(tmpdir(), "hpp-review-baseline-"));
      let baseline: Snapshot;
      let replayed: Snapshot;
      const selected = new Set<number>();
      try {
        materializeSnapshot(worktree, source.relativePath, current);
        // 记录每份补丁被拒的真实原因。空泛的「不匹配」对排查毫无帮助，
        // 必须把 git apply 的 stderr 带出来，否则只能靠猜。
        const rejections: string[] = [];
        for (let patchIndex = normalized.length - 1; patchIndex >= 0; patchIndex -= 1) {
          const candidate = readMaterializedSnapshot(worktree, source.relativePath);
          const forward = this.runGitApply(worktree, normalized[patchIndex], false);
          if (!forward.error && forward.status === 0) {
            // 当前处于这份 patch 的旧侧，说明其效果已被较新的累计快照逆向覆盖。
            // 恢复探测前快照并跳过，避免旧 patch 在重复文本处误反向应用。
            materializeSnapshot(worktree, source.relativePath, candidate);
            rejections.push(`补丁 #${patchIndex + 1} 正向可应用（文件尚未包含这份改动）`);
            continue;
          }
          const reverse = this.runGitApply(worktree, normalized[patchIndex], true);
          if (!reverse.error && reverse.status === 0) {
            selected.add(patchIndex);
            continue;
          }
          rejections.push(`补丁 #${patchIndex + 1} 正反向均失败：${getFailureDetail(reverse)}`);
        }
        if (selected.size === 0) {
          const detail = rejections.length > 0 ? `（${rejections.join("；")}）` : "";
          throw new Error(`当前文件与补丁不匹配，无法安全推导修改前内容${detail}`);
        }
        baseline = readMaterializedSnapshot(worktree, source.relativePath);
        for (let patchIndex = 0; patchIndex < normalized.length; patchIndex += 1) {
          if (!selected.has(patchIndex)) continue;
          const result = this.runGitApply(worktree, normalized[patchIndex], false);
          if (result.error || result.status !== 0) {
            throw new Error(`补丁日志无法从推导基线重放：${getFailureDetail(result)}`);
          }
        }
        replayed = readMaterializedSnapshot(worktree, source.relativePath);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }

      if (!snapshotEquals(replayed, current)) {
        throw new Error("补丁日志不是可验证的增量或累计快照，已禁用撤销");
      }

      const baselineFile = baseline.exists ? `baseline/${index}.bin` : undefined;
      if (baselineFile) writeFileDurably(join(stateDir, baselineFile), baseline.content as Buffer);
      const canonicalPatch = generateCanonicalPatch(source.relativePath, baseline, current);
      if (!canonicalPatch.trim() && baseline.hash !== current.hash) {
        throw new Error("变更只包含不受支持的文件元数据");
      }
      return {
        ...base,
        supported: true,
        baseline: toStoredSnapshot(baseline, baselineFile),
        expected: toStoredSnapshot(current),
      };
    } catch (error) {
      return { ...base, error: this.errorMessage(error) };
    }
  }

  private buildState(stateDir: string, manifest: ReviewManifest): ReviewUndoState {
    const files: ReviewUndoFileState[] = manifest.files.map((file) => {
      if (!file.supported || !file.baseline || !file.expected) {
        return {
          file: file.sourceFile,
          status: normalizeStatus(file.status),
          patch: "",
          additions: 0,
          deletions: 0,
          hunkCount: 0,
          undoable: false,
          reverted: false,
          error: file.error || "当前文件无法安全撤销",
        };
      }
      const target = this.resolveTarget(manifest.projectPath, file.relativePath, true);
      const current = readSnapshot(target.filePath);
      if (current.hash !== file.expected.hash) {
        throw new Error(`${file.relativePath} 在审核撤销之外发生了修改，已停止操作以避免覆盖`);
      }
      const baseline = storedSnapshotContent(stateDir, file.baseline);
      const patch = generateCanonicalPatch(file.relativePath, baseline, current);
      const counts = countPatchChanges(patch);
      const reverted = baseline.hash === current.hash;
      const status: ReviewUndoFileStatus = !baseline.exists && current.exists
        ? "added"
        : baseline.exists && !current.exists
          ? "deleted"
          : "modified";
      return {
        file: file.sourceFile,
        status,
        patch,
        additions: counts.additions,
        deletions: counts.deletions,
        hunkCount: parsePatchHunks(patch).length,
        undoable: !reverted,
        reverted,
      };
    });
    const unsupported = files.find((file) => !!file.error);
    const allReverted = files.length > 0 && files.every((file) => file.reverted);
    const canUndoAll = !unsupported && files.some((file) => file.undoable);
    const undoAllReason = unsupported
      ? `无法撤销全部修改：${unsupported.file}：${unsupported.error}`
      : allReverted
        ? "已撤销全部修改"
        : canUndoAll
          ? undefined
          : "没有可撤销的修改";
    return {
      transactionId: manifest.transactionId,
      version: manifest.version,
      files,
      canUndoAll,
      allReverted,
      undoAllReason,
    };
  }

  private applyLocked(
    transactionId: string,
    expectedVersion: number,
    target: ReviewUndoTarget,
  ): ReviewUndoResult {
    const stateDir = join(this.stateRoot, transactionId);
    const manifest = this.loadManifest(transactionId);
    this.recoverPending(stateDir, manifest);
    if (manifest.version !== expectedVersion) {
      return {
        success: false,
        stale: true,
        error: "审核状态已更新，请根据最新内容重试",
      };
    }
    const currentState = this.buildState(stateDir, manifest);
    const targetIndexes = this.resolveTargetIndexes(manifest, currentState, target);
    const changes = targetIndexes.map(({ fileIndex, hunkIndex, changeIndex }) => {
      const file = manifest.files[fileIndex];
      const baseline = storedSnapshotContent(stateDir, file.baseline as StoredSnapshot);
      const targetPath = this.resolveTarget(manifest.projectPath, file.relativePath, true).filePath;
      const before = readSnapshot(targetPath);
      let after = baseline;
      if (hunkIndex !== undefined) {
        const patch = generateCanonicalPatch(file.relativePath, baseline, before);
        const hunkPatch = changeIndex === undefined
          ? extractHunkPatch(patch, hunkIndex)
          : extractChangePatch(patch, hunkIndex, changeIndex);
        if (!hunkPatch) throw new Error("目标修改段已不存在，请刷新审核内容");
        try {
          after = applyPatchToSnapshot(
            file.relativePath,
            before,
            hunkPatch,
            true,
            this.runGitApply,
          );
        } catch (error) {
          throw new Error(`无法撤销该修改段：${this.errorMessage(error)}`);
        }
        if (after.exists && !before.exists && baseline.exists) {
          after = {
            ...after,
            mode: baseline.mode,
            hash: snapshotHash(true, after.content, baseline.mode),
          };
        }
      }
      return { fileIndex, file, targetPath, before, after };
    }).filter((change) => change.before.hash !== change.after.hash);
    if (changes.length === 0) return { success: false, error: "目标修改已撤销" };

    const operationId = `${Date.now()}-${randomUUID()}`;
    const pendingDirName = `pending-${operationId}`;
    const pendingDir = join(stateDir, pendingDirName);
    const backupPath = join(this.backupRoot, transactionId, operationId);
    mkdirSync(pendingDir, { recursive: true });
    mkdirSync(backupPath, { recursive: true });

    const pendingFiles: PendingFile[] = [];
    try {
      for (const change of changes) {
        const afterFile = change.after.exists ? `${pendingDirName}/${change.fileIndex}.bin` : undefined;
        if (afterFile) writeFileDurably(join(stateDir, afterFile), change.after.content as Buffer);
        if (change.before.exists) {
          writeFileDurably(
            join(backupPath, change.file.relativePath),
            change.before.content as Buffer,
          );
        } else {
          writeFileDurably(join(backupPath, `${change.file.relativePath}.missing`), "missing\n");
        }
        pendingFiles.push({
          fileIndex: change.fileIndex,
          before: toStoredSnapshot(change.before),
          after: toStoredSnapshot(change.after, afterFile),
        });
      }
    } catch (error) {
      rmSync(pendingDir, { recursive: true, force: true });
      rmSync(backupPath, { recursive: true, force: true });
      throw new Error(`创建撤销备份失败：${this.errorMessage(error)}`);
    }

    manifest.pending = {
      id: operationId,
      targetVersion: manifest.version + 1,
      snapshotDir: pendingDirName,
      files: pendingFiles,
    };
    manifest.updatedAt = Date.now();
    this.saveManifest(stateDir, manifest);

    const written: typeof changes = [];
    try {
      for (const change of changes) {
        this.assertCurrentSnapshot(manifest.projectPath, change.file.relativePath, change.before);
        writeSnapshotAtomic(change.targetPath, change.after, change.before.hash);
        const actual = readSnapshot(change.targetPath);
        if (actual.hash !== change.after.hash) throw new Error(`${change.file.relativePath} 写回校验失败`);
        written.push(change);
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        for (let index = written.length - 1; index >= 0; index -= 1) {
          const current = readSnapshot(written[index].targetPath);
          if (current.hash !== written[index].after.hash) {
            throw new Error(`${written[index].file.relativePath} 在自动恢复前被外部修改`);
          }
          writeSnapshotAtomic(
            written[index].targetPath,
            written[index].before,
            written[index].after.hash,
          );
        }
        delete manifest.pending;
        manifest.updatedAt = Date.now();
        this.saveManifest(stateDir, manifest);
        rmSync(pendingDir, { recursive: true, force: true });
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      if (rollbackError) {
        throw new Error(
          `撤销写回失败且自动恢复未完成：${this.errorMessage(error)}；${this.errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }

    for (const change of changes) {
      manifest.files[change.fileIndex].expected = toStoredSnapshot(change.after);
    }
    manifest.version += 1;
    manifest.updatedAt = Date.now();
    delete manifest.pending;
    this.saveManifest(stateDir, manifest);
    rmSync(pendingDir, { recursive: true, force: true });
    return {
      success: true,
      state: this.buildState(stateDir, manifest),
      backupPath,
    };
  }

  private resolveTargetIndexes(
    manifest: ReviewManifest,
    state: ReviewUndoState,
    target: ReviewUndoTarget,
  ): Array<{ fileIndex: number; hunkIndex?: number; changeIndex?: number }> {
    if (!target || typeof target !== "object") throw new Error("Invalid undo target");
    if (target.kind === "all") {
      if (!state.canUndoAll) throw new Error(state.undoAllReason || "无法撤销全部修改");
      return manifest.files.flatMap((file, fileIndex) =>
        file.supported && state.files[fileIndex]?.undoable ? [{ fileIndex }] : []
      );
    }
    if (typeof target.file !== "string" || !target.file) throw new Error("Invalid undo file");
    const fileIndex = manifest.files.findIndex((file) => file.sourceFile === target.file);
    if (fileIndex < 0) throw new Error("审核文件不存在");
    const fileState = state.files[fileIndex];
    if (!manifest.files[fileIndex].supported || !fileState.undoable) {
      throw new Error(fileState.error || "该文件没有可撤销的修改");
    }
    if (target.kind === "file") return [{ fileIndex }];
    if (target.kind !== "hunk" || !Number.isInteger(target.hunkIndex)) {
      throw new Error("Invalid undo hunk");
    }
    if (target.hunkIndex < 0 || target.hunkIndex >= fileState.hunkCount) {
      throw new Error("目标修改段已不存在，请刷新审核内容");
    }
    if (target.changeIndex !== undefined
      && (!Number.isInteger(target.changeIndex) || target.changeIndex < 0)
    ) {
      throw new Error("Invalid undo change");
    }
    return [{
      fileIndex,
      hunkIndex: target.hunkIndex,
      ...(target.changeIndex !== undefined ? { changeIndex: target.changeIndex } : {}),
    }];
  }

  private recoverPending(stateDir: string, manifest: ReviewManifest) {
    const pending = manifest.pending;
    if (!pending) return;
    for (const entry of pending.files) {
      const file = manifest.files[entry.fileIndex];
      if (!file?.supported) throw new Error("待恢复撤销事务引用了无效文件");
      const target = this.resolveTarget(manifest.projectPath, file.relativePath, true);
      const current = readSnapshot(target.filePath);
      if (current.hash === entry.after.hash) continue;
      if (current.hash !== entry.before.hash) {
        throw new Error(`${file.relativePath} 在撤销事务恢复期间被外部修改，已停止自动恢复`);
      }
      const after = storedSnapshotContent(stateDir, entry.after);
      writeSnapshotAtomic(target.filePath, after, entry.before.hash);
    }
    for (const entry of pending.files) {
      manifest.files[entry.fileIndex].expected = {
        exists: entry.after.exists,
        hash: entry.after.hash,
        mode: entry.after.mode,
      };
    }
    manifest.version = pending.targetVersion;
    manifest.updatedAt = Date.now();
    delete manifest.pending;
    this.saveManifest(stateDir, manifest);
    rmSync(join(stateDir, pending.snapshotDir), { recursive: true, force: true });
  }

  private assertCurrentSnapshot(projectPath: string, relativePath: string, expected: Snapshot) {
    const target = this.resolveTarget(projectPath, relativePath, true);
    const current = readSnapshot(target.filePath);
    if (current.hash !== expected.hash) {
      throw new Error(`${relativePath} 在撤销期间被外部修改，已中止`);
    }
  }

  private resolveTarget(projectPath: string, rawFile: string, allowMissing: boolean) {
    if (typeof rawFile !== "string" || !rawFile.trim() || /[\0\r\n\t]/.test(rawFile)) {
      throw new Error("Invalid file path");
    }
    const requested = isAbsolute(rawFile) ? resolve(rawFile) : resolve(projectPath, rawFile);
    if (!isPathInside(projectPath, requested) || requested === projectPath) {
      throw new Error("File is outside the project directory");
    }
    const relativePath = normalizeSlashes(relative(projectPath, requested));
    if (relativePath.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new Error("Git metadata files cannot be changed through review undo");
    }

    const parts = relativePath.split("/").filter(Boolean);
    let cursor = projectPath;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor = join(cursor, parts[index]);
      if (!existsSync(cursor)) {
        if (!allowMissing) throw new Error("Target parent directory does not exist");
        break;
      }
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) throw new Error("符号链接路径不支持审核撤销");
      if (!info.isDirectory()) throw new Error("目标文件父路径不是目录");
      if (!isPathInside(projectPath, realpathSync(cursor))) {
        throw new Error("File is outside the project directory");
      }
    }
    if (existsSync(requested)) {
      const info = lstatSync(requested);
      if (info.isSymbolicLink()) throw new Error("符号链接文件不支持审核撤销");
      if (!info.isFile()) throw new Error("目标路径不是普通文件");
      if (!isPathInside(projectPath, realpathSync(requested))) {
        throw new Error("File is outside the project directory");
      }
    } else if (!allowMissing && !existsSync(dirname(requested))) {
      throw new Error("Target path does not exist");
    }
    return { filePath: requested, relativePath: parts.join(sep) };
  }

  private loadManifest(transactionId: string): ReviewManifest {
    const manifestPath = join(this.stateRoot, transactionId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReviewManifest;
    if (
      manifest.schemaVersion !== MANIFEST_VERSION
      || manifest.transactionId !== transactionId
      || !Array.isArray(manifest.files)
    ) {
      throw new Error("审核撤销状态文件无效");
    }
    const canonicalProject = realpathSync(manifest.projectPath);
    if (canonicalProject !== manifest.projectPath) throw new Error("审核项目路径已变化");
    return manifest;
  }

  private saveManifest(stateDir: string, manifest: ReviewManifest) {
    writeJsonAtomic(join(stateDir, "manifest.json"), manifest);
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
