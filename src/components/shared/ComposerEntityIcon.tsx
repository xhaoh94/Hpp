import { FileText, Folder, Link2 } from "lucide-react";
import type { ComposerNode } from "@shared/composer-document";

type ComposerReferenceNode = Exclude<ComposerNode, { type: "text" | "image" }>;

export function ComposerEntityIcon({ node }: { node: ComposerReferenceNode }) {
  if (node.type === "session") return <Link2 className="composer-entity-icon session" size={14} />;
  if (node.type === "path" && node.kind === "folder") {
    return <Folder className="composer-entity-icon folder" size={14} />;
  }
  return <FileText className="composer-entity-icon file" size={14} />;
}
