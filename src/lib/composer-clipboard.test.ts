import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerDocument } from "@shared/composer-document";
import {
  COMPOSER_CLIPBOARD_MIME,
  parseComposerClipboard,
  readCopiedComposer,
  serializeComposerClipboard,
  writeComposerClipboard,
} from "./composer-clipboard";

const sampleDocument = () => createComposerDocument([
  { id: "t1", type: "text", text: "看看这个\n第二行" },
  { id: "p1", type: "path", name: "a.ts", path: "src/a.ts", kind: "file" },
  { id: "s1", type: "session", reference: { sourceSessionId: "s-1", sourceTitle: "会话标题" } },
]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("serializeComposerClipboard / parseComposerClipboard", () => {
  it("round-trips through parseComposerClipboard", () => {
    const document = sampleDocument();
    expect(parseComposerClipboard(serializeComposerClipboard(document))).toEqual(document);
  });

  it("drops image nodes when the payload exceeds the size cap", () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const document = createComposerDocument([
      { id: "t1", type: "text", text: "带图" },
      { id: "i1", type: "image", name: "big.png", src: `data:image/png;base64,${big}`, mimeType: "image/png" },
    ]);
    const parsed = parseComposerClipboard(serializeComposerClipboard(document));
    expect(parsed?.nodes.map((node) => node.type)).toEqual(["text"]);
  });

  it("rejects foreign or malformed payloads", () => {
    expect(parseComposerClipboard(null)).toBeNull();
    expect(parseComposerClipboard("")).toBeNull();
    expect(parseComposerClipboard("不是 JSON")).toBeNull();
    expect(parseComposerClipboard(JSON.stringify({ kind: "other" }))).toBeNull();
    expect(parseComposerClipboard(JSON.stringify({ kind: "hpp-composer-document" }))).toBeNull();
    expect(parseComposerClipboard(JSON.stringify({ kind: "hpp-composer-document", document: { version: 1, nodes: [] } }))).toBeNull();
  });
});

class StubClipboardItem {
  constructor(public types: Record<string, Blob>) {}
}

describe("writeComposerClipboard / readCopiedComposer", () => {
  it("restores the document from the in-memory copy when the plain text matches", async () => {
    const document = sampleDocument();
    vi.stubGlobal("navigator", {});
    await writeComposerClipboard(document, "第一行\n第二行");
    // 系统剪贴板里拿不到自定义格式时，纯文本指纹命中内存副本。
    expect(readCopiedComposer("第一行\n第二行", null)).toEqual(document);
    // \r\n 差异（跨进程剪贴板归一化）不破坏指纹匹配。
    expect(readCopiedComposer("第一行\r\n第二行", null)).toEqual(document);
  });

  it("prefers the custom clipboard flavor over the in-memory copy", async () => {
    vi.stubGlobal("navigator", {});
    await writeComposerClipboard(sampleDocument(), "纯文本");
    const other = createComposerDocument([{ id: "t9", type: "text", text: "另一份" }]);
    const flavor = serializeComposerClipboard(other);
    expect(readCopiedComposer("纯文本", flavor)).toEqual(other);
  });

  it("stops matching after the clipboard plain text changes or write times out", async () => {
    vi.useFakeTimers();
    // clipboard.write 永久挂起（Electron 实测）：2 秒超时后退回 writeText，复制不挂住。
    vi.stubGlobal("navigator", { clipboard: { write: () => new Promise(() => {}) } });
    vi.stubGlobal("ClipboardItem", StubClipboardItem);
    const pending = writeComposerClipboard(sampleDocument(), "纯文本");
    await vi.advanceTimersByTimeAsync(2100);
    await pending;
    expect(readCopiedComposer("纯文本", null)).toEqual(sampleDocument());

    // 用户复制了别的内容后指纹失配，普通粘贴不再注入芯片。
    expect(readCopiedComposer("别的文本", null)).toBeNull();
  });

  it("never writes when the document is empty", async () => {
    const write = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    await writeComposerClipboard(createComposerDocument([]), "");
    expect(write).not.toHaveBeenCalled();
    expect(readCopiedComposer("", null)).toBeNull();
  });

  it("writes both flavors through ClipboardItem when available", async () => {
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", StubClipboardItem);
    await writeComposerClipboard(sampleDocument(), "纯文本");
    const [written] = write.mock.calls[0];
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0].types)).toContain("text/plain");
    expect(Object.keys(written[0].types)).toContain(COMPOSER_CLIPBOARD_MIME);
  });
});
