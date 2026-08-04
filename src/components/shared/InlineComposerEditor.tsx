import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $setSelection,
  $insertNodes,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";
import { X } from "lucide-react";
import {
  createComposerDocument,
  getComposerNodeLabel,
  type ComposerDocument,
  type ComposerNode,
  type ComposerTextNode,
} from "@shared/composer-document";
import { ComposerEntityIcon } from "./ComposerEntityIcon";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

type EntityNodeValue = Exclude<ComposerNode, ComposerTextNode>;

type SerializedComposerEntityNode = Spread<{
  type: "composer-entity";
  version: 1;
  entity: EntityNodeValue;
}, SerializedLexicalNode>;

const EditorCallbacksContext = createContext<{
  disabled: boolean;
  onOpenImage?: (src: string) => void;
}>({ disabled: false });

class ComposerEntityNode extends DecoratorNode<ReactNode> {
  __entity: EntityNodeValue;

  static getType() { return "composer-entity"; }
  static clone(node: ComposerEntityNode) { return new ComposerEntityNode(node.__entity, node.__key); }
  static importJSON(serialized: SerializedComposerEntityNode) { return new ComposerEntityNode(serialized.entity); }

  constructor(entity: EntityNodeValue, key?: NodeKey) {
    super(key);
    this.__entity = entity.type === "session"
      ? { ...entity, reference: { ...entity.reference } }
      : { ...entity };
  }

  exportJSON(): SerializedComposerEntityNode {
    return { type: "composer-entity", version: 1, entity: this.__entity };
  }

  createDOM() {
    const element = document.createElement("span");
    element.className = "inline-composer-entity-host";
    return element;
  }

  updateDOM() { return false; }
  isInline() { return true; }
  getTextContent() { return "\uFFFC"; }
  getEntity() { return this.getLatest().__entity; }
  decorate() { return <ComposerEntityView entity={this.__entity} nodeKey={this.__key} />; }
}

const $createComposerEntityNode = (entity: EntityNodeValue) => new ComposerEntityNode(entity);
const $isComposerEntityNode = (node: LexicalNode | null | undefined): node is ComposerEntityNode =>
  node instanceof ComposerEntityNode;

function ComposerEntityView({ entity, nodeKey }: { entity: EntityNodeValue; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { disabled, onOpenImage } = useContext(EditorCallbacksContext);
  const remove = useCallback(() => {
    if (disabled) return;
    editor.update(() => $getNodeByKey(nodeKey)?.remove());
  }, [disabled, editor, nodeKey]);

  useEffect(() => {
    const removeSelected = (event: globalThis.KeyboardEvent | null) => {
      if (!selected || disabled) return false;
      event?.preventDefault();
      remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_DELETE_COMMAND, removeSelected, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, removeSelected, COMMAND_PRIORITY_LOW),
    );
  }, [disabled, editor, remove, selected]);

  const label = entity.type === "image"
    ? "Image"
    : entity.type === "session"
      ? entity.reference.sourceTitle
      : entity.type === "snippet"
        ? `${entity.fileName}:${entity.startLine}-${entity.endLine}`
        : entity.name;

  return (
    <span
      className={`inline-composer-entity ${entity.type}${selected ? " selected" : ""}`}
      contentEditable={false}
      data-composer-node-id={entity.id}
      title={entity.type === "path" ? entity.path : getComposerNodeLabel(entity)}
      onMouseDown={(event) => {
        event.preventDefault();
        if (!event.shiftKey) clearSelection();
        setSelected(!selected);
      }}
    >
      {entity.type === "image" ? (
        <img
          src={entity.src}
          alt={entity.name}
          title="点击查看大图"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenImage?.(entity.src);
          }}
        />
      ) : <ComposerEntityIcon node={entity} />}
      <span>{label}</span>
      {!disabled && (
        <button type="button" tabIndex={-1} aria-label="移除引用" onMouseDown={(event) => event.preventDefault()} onClick={remove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function appendDocumentToRoot(documentValue: ComposerDocument) {
  const root = $getRoot();
  root.clear();
  let paragraph = $createParagraphNode();
  root.append(paragraph);
  for (const node of documentValue.nodes) {
    if (node.type !== "text") {
      paragraph.append($createComposerEntityNode(node));
      continue;
    }
    const parts = node.text.split("\n");
    parts.forEach((part, index) => {
      if (part) paragraph.append($createTextNode(part));
      if (index < parts.length - 1) {
        paragraph = $createParagraphNode();
        root.append(paragraph);
      }
    });
  }
}

function documentFromEditor(): ComposerDocument {
  const nodes: ComposerNode[] = [];
  const appendText = (text: string) => {
    if (!text) return;
    const previous = nodes.at(-1);
    if (previous?.type === "text") previous.text += text;
    else nodes.push({ id: crypto.randomUUID(), type: "text", text });
  };
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node)) appendText(node.getTextContent());
    else if ($isLineBreakNode(node)) appendText("\n");
    else if ($isComposerEntityNode(node)) nodes.push(node.getEntity());
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  const children = $getRoot().getChildren();
  children.forEach((child, index) => {
    visit(child);
    if (index < children.length - 1) appendText("\n");
  });
  return createComposerDocument(nodes);
}

function SyncDocumentPlugin({ value, onChange }: { value: ComposerDocument; onChange: (value: ComposerDocument) => void }) {
  const [editor] = useLexicalComposerContext();
  const appliedRef = useRef("");
  const signature = JSON.stringify(value);

  useEffect(() => {
    if (signature === appliedRef.current) return;
    editor.update(() => appendDocumentToRoot(value));
    appliedRef.current = signature;
  }, [editor, signature, value]);

  return <OnChangePlugin ignoreSelectionChange onChange={(state) => {
    state.read(() => {
      const next = documentFromEditor();
      const nextSignature = JSON.stringify(next);
      appliedRef.current = nextSignature;
      onChange(next);
    });
  }} />;
}

type SelectionPointType = "text" | "element";
type SelectionSnapshot = {
  anchorKey: NodeKey;
  anchorOffset: number;
  anchorType: SelectionPointType;
  focusKey: NodeKey;
  focusOffset: number;
  focusType: SelectionPointType;
};

function CaptureEditorPlugin({
  editorRef,
  selectionRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
  selectionRef: React.MutableRefObject<SelectionSnapshot | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    const unregister = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selectionRef.current = {
            anchorKey: selection.anchor.key,
            anchorOffset: selection.anchor.offset,
            anchorType: selection.anchor.type,
            focusKey: selection.focus.key,
            focusOffset: selection.focus.offset,
            focusType: selection.focus.type,
          };
        }
      });
      return false;
    }, COMMAND_PRIORITY_LOW);
    return () => { unregister(); editorRef.current = null; };
  }, [editor, editorRef, selectionRef]);
  return null;
}

export type InlineComposerEditorHandle = {
  focus: () => void;
  insertNode: (node: EntityNodeValue) => boolean;
  insertLineBreak: () => void;
  getActiveText: () => { text: string; start: number; end: number } | null;
  replaceActiveText: (start: number, end: number, node: EntityNodeValue) => boolean;
};

export type InlineComposerEditorProps = {
  value: ComposerDocument;
  onChange: (value: ComposerDocument) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onOpenImage?: (src: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onKeyUp?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onBlur?: (event: React.FocusEvent<HTMLDivElement>) => void;
};

export const InlineComposerEditor = forwardRef<InlineComposerEditorHandle, InlineComposerEditorProps>(function InlineComposerEditor({
  value,
  onChange,
  placeholder,
  disabled = false,
  className = "",
  onOpenImage,
  onKeyDown,
  ...events
}, ref) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const selectionRef = useRef<SelectionSnapshot | null>(null);
  const initialConfig = useMemo(() => ({
    namespace: "HppInlineComposer",
    nodes: [ComposerEntityNode],
    editable: !disabled,
    editorState: () => appendDocumentToRoot(value),
    theme: { paragraph: "inline-composer-paragraph" },
    onError(error: Error) { throw error; },
  }), []);

  useEffect(() => { editorRef.current?.setEditable(!disabled); }, [disabled]);

  const captureSelection = useCallback(() => {
    editorRef.current?.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selectionRef.current = {
          anchorKey: selection.anchor.key,
          anchorOffset: selection.anchor.offset,
          anchorType: selection.anchor.type,
          focusKey: selection.focus.key,
          focusOffset: selection.focus.offset,
          focusType: selection.focus.type,
        };
      }
    });
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertNode: (node) => {
      const editor = editorRef.current;
      if (!editor) return false;
      let inserted = false;
      editor.update(() => {
        const entityNode = $createComposerEntityNode(node);
        let selection = $getSelection();
        const snapshot = selectionRef.current;
        const root = $getRoot();
        const isValidPoint = (key: NodeKey, offset: number, type: SelectionPointType) => {
          const target = $getNodeByKey(key);
          if (type === "text") return $isTextNode(target) && offset <= target.getTextContentSize();
          return $isElementNode(target) && offset <= target.getChildrenSize();
        };
        const isUsableRangeSelection = (candidate: typeof selection) => (
          $isRangeSelection(candidate)
          && candidate.anchor.key !== root.getKey()
          && candidate.focus.key !== root.getKey()
          && isValidPoint(candidate.anchor.key, candidate.anchor.offset, candidate.anchor.type)
          && isValidPoint(candidate.focus.key, candidate.focus.offset, candidate.focus.type)
        );
        if (!$isRangeSelection(selection) && snapshot) {
          if (
            snapshot.anchorKey !== root.getKey()
            && snapshot.focusKey !== root.getKey()
            && isValidPoint(snapshot.anchorKey, snapshot.anchorOffset, snapshot.anchorType)
            && isValidPoint(snapshot.focusKey, snapshot.focusOffset, snapshot.focusType)
          ) {
            const restored = $createRangeSelection();
            restored.anchor.set(snapshot.anchorKey, snapshot.anchorOffset, snapshot.anchorType);
            restored.focus.set(snapshot.focusKey, snapshot.focusOffset, snapshot.focusType);
            $setSelection(restored);
            selection = restored;
          }
        }
        if (isUsableRangeSelection(selection)) {
          $insertNodes([entityNode]);
          inserted = true;
        } else {
          const children = root.getChildren();
          if (children.length > 0 && children.every((child) => child.getTextContentSize() === 0)) {
            root.clear();
          }
          const lastChild = root.getLastChild();
          const container = lastChild && $isElementNode(lastChild) ? lastChild : $createParagraphNode();
          if (!lastChild || !$isElementNode(lastChild)) root.append(container);
          container.append(entityNode);
          entityNode.selectNext(0, 0);
          inserted = true;
        }
      }, { discrete: true });
      requestAnimationFrame(() => editor.focus());
      return inserted;
    },
    insertLineBreak: () => editorRef.current?.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertParagraph();
    }),
    getActiveText: () => {
      let result: { text: string; start: number; end: number } | null = null;
      editorRef.current?.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.anchor.key !== selection.focus.key) return;
        const node = selection.anchor.getNode();
        if (!$isTextNode(node)) return;
        result = { text: node.getTextContent(), start: selection.anchor.offset, end: selection.focus.offset };
      });
      return result;
    },
    replaceActiveText: (start, end, entity) => {
      let replaced = false;
      editorRef.current?.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const node = selection.anchor.getNode();
        if (!$isTextNode(node) || selection.anchor.key !== selection.focus.key) return;
        const text = node.getTextContent();
        if (start < 0 || end < start || end > text.length) return;
        const before = text.slice(0, start);
        const after = text.slice(end);
        node.setTextContent(before);
        const entityNode = $createComposerEntityNode(entity);
        node.insertAfter(entityNode);
        if (after) {
          const afterNode = $createTextNode(after);
          entityNode.insertAfter(afterNode);
          afterNode.select(0, 0);
        } else {
          entityNode.selectNext(0, 0);
        }
        replaced = true;
      }, { discrete: true });
      return replaced;
    },
  }), []);

  return (
    <EditorCallbacksContext.Provider value={{ disabled, onOpenImage }}>
      <LexicalComposer initialConfig={initialConfig}>
        <div className={`inline-composer-editor ${className}`}>
          <RichTextPlugin
            contentEditable={<ContentEditable
              className="inline-composer-content"
              aria-placeholder={placeholder || ""}
              placeholder={<span />}
              {...events}
              onKeyDownCapture={onKeyDown}
              onBlur={(event) => { captureSelection(); events.onBlur?.(event); }}
            />}
            placeholder={<div className="inline-composer-placeholder">{placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <SyncDocumentPlugin value={value} onChange={onChange} />
          <CaptureEditorPlugin editorRef={editorRef} selectionRef={selectionRef} />
        </div>
      </LexicalComposer>
    </EditorCallbacksContext.Provider>
  );
});
