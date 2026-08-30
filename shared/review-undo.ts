export type ReviewUndoFileStatus = "added" | "deleted" | "modified";

export interface ReviewUndoSourceFile {
  file: string;
  patches: string[];
  status?: string;
  statusExplicit?: boolean;
}

export interface PrepareReviewUndoRequest {
  reviewId: string;
  projectPath: string;
  files: ReviewUndoSourceFile[];
}

export interface ReviewUndoFileState {
  file: string;
  status: ReviewUndoFileStatus;
  patch: string;
  additions: number;
  deletions: number;
  hunkCount: number;
  undoable: boolean;
  reverted: boolean;
  error?: string;
}

export interface ReviewUndoState {
  transactionId: string;
  version: number;
  files: ReviewUndoFileState[];
  canUndoAll: boolean;
  allReverted: boolean;
  undoAllReason?: string;
}

export type ReviewUndoTarget =
  | { kind: "hunk"; file: string; hunkIndex: number; changeIndex?: number }
  | { kind: "file"; file: string }
  | { kind: "all" };

export type ReviewUndoResult =
  | { success: true; state: ReviewUndoState; backupPath?: string }
  | { success: false; error: string; stale?: boolean };

export type ReviewUndoLoadResult =
  | { success: true; state: ReviewUndoState | null }
  | { success: false; error: string };