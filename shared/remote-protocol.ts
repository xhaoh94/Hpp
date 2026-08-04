import { z } from "zod";
import type { DiffLike } from "./diff-summary";
import type { SharedModel } from "./models";
import type { ProcessEntryView } from "./process-view";
import type { QuestionnaireQuestion } from "./questionnaire";
import type { AgentActionCatalogEntry, AgentActionInvocation } from "./agent-actions";
import type { AgentPermissionMode } from "./agent-permissions";
import type { ComposerDocument, ComposerNode } from "./composer-document";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_REMOTE_PORT = 47831;
export const REMOTE_HISTORY_PAGE_SIZE = 50;
export const MAX_REMOTE_IMAGES = 4;
export const MAX_REMOTE_SESSION_REFERENCES = 8;
export const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REMOTE_REQUEST_BYTES = 8 * 1024 * 1024;

export const REMOTE_REQUEST_NAMES = [
  "catalog.get",
  "session.get",
  "session.create",
  "session.fork",
  "session.close",
  "session.reopen",
  "session.send",
  "session.abort",
  "session.reload",
  "session.queue.guide",
  "session.queue.edit",
  "session.queue.reorder",
  "session.queue.remove",
  "session.setModel",
  "session.setThinking",
  "session.models.get",
  "session.actions.get",
  "settings.setPlanMode",
  "settings.setPermissionMode",
  "interaction.respond",
] as const;

export const REMOTE_EVENT_NAMES = [
  "catalog.updated",
  "session.message.upsert",
  "session.messages.replace",
  "session.runtime.updated",
  "session.queue.updated",
  "session.interaction.updated",
  "session.config.updated",
] as const;

export type RemoteRequestName = typeof REMOTE_REQUEST_NAMES[number];
export type RemoteEventName = typeof REMOTE_EVENT_NAMES[number];

const nonEmptyString = z.string().trim().min(1).max(4096);
const requestIdSchema = z.string().trim().min(1).max(128);
const sessionIdSchema = z.string().trim().min(1).max(256);

export const remoteImageSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  data: z.string().min(1),
}).superRefine((image, ctx) => {
  const estimatedBytes = Math.floor(image.data.length * 0.75);
  if (estimatedBytes > MAX_REMOTE_IMAGE_BYTES) {
    ctx.addIssue({ code: "custom", message: "Image exceeds the 2 MB limit." });
  }
});

const remoteComposerNodeSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1).max(128), type: z.literal("text"), text: z.string().max(200_000) }),
  z.object({
    id: z.string().min(1).max(128), type: z.literal("image"), name: z.string().max(256),
    mimeType: z.string().max(128), src: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1).max(128), type: z.literal("path"), name: z.string().max(512),
    path: z.string().max(4096), kind: z.enum(["file", "folder"]),
  }),
  z.object({
    id: z.string().min(1).max(128), type: z.literal("snippet"), fileName: z.string().max(512),
    filePath: z.string().max(4096), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  }).refine((node) => node.endLine >= node.startLine, "Invalid line range"),
  z.object({
    id: z.string().min(1).max(128), type: z.literal("session"),
    reference: z.object({
      sourceSessionId: sessionIdSchema,
      sourceTitle: z.string().max(512),
      sourceAgentId: z.string().max(256).optional(),
      sourceUpdatedAt: z.string().max(128).optional(),
      addedAt: z.string().max(128).optional(),
      summary: z.string().max(12_000).optional(),
    }),
  }),
]);

const remoteComposerDocumentSchema = z.object({
  version: z.literal(1),
  nodes: z.array(remoteComposerNodeSchema).max(512),
});

const sessionGetPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  before: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(REMOTE_HISTORY_PAGE_SIZE).default(REMOTE_HISTORY_PAGE_SIZE),
});

const sessionCreatePayloadSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  agentId: z.string().trim().min(1).max(256),
  clientSessionId: sessionIdSchema,
});

const sessionForkPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  throughMessageId: z.string().trim().min(1).max(256),
  clientSessionId: sessionIdSchema,
});

const remoteSessionReferenceSchema = z.object({
  sourceSessionId: sessionIdSchema,
});

const remoteAgentActionSchema = z.object({
  kind: z.enum(["skill", "command"]),
  name: z.string().trim().min(1).max(128),
});

const sessionSendPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  clientMessageId: z.string().trim().min(1).max(128),
  content: z.string().max(200_000).default(""),
  planModeEnabled: z.boolean().default(false),
  permissionMode: z.enum(["ask", "auto", "full-access"]).default("auto"),
  images: z.array(remoteImageSchema).max(MAX_REMOTE_IMAGES).default([]),
  sessionReferences: z.array(remoteSessionReferenceSchema).max(MAX_REMOTE_SESSION_REFERENCES).default([]),
  action: remoteAgentActionSchema.optional(),
  composerDocument: remoteComposerDocumentSchema.optional(),
}).superRefine((value, context) => {
  if (value.content.trim() || value.images.length > 0 || value.sessionReferences.length > 0 || value.action || value.composerDocument?.nodes.length) return;
  context.addIssue({ code: "custom", message: "A message, image, or session reference is required." });
});

const sessionIdPayloadSchema = z.object({ sessionId: sessionIdSchema });

const sessionActionsPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  reload: z.boolean().default(false),
});

const sessionQueueItemPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  queueItemId: z.string().trim().min(1).max(128),
});

const sessionQueueEditPayloadSchema = sessionQueueItemPayloadSchema.extend({
  content: z.string().max(200_000),
  images: z.array(remoteImageSchema).max(MAX_REMOTE_IMAGES).default([]),
  sessionReferences: z.array(remoteSessionReferenceSchema).max(MAX_REMOTE_SESSION_REFERENCES).default([]),
  retainedAttachmentIds: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  action: remoteAgentActionSchema.nullable().optional(),
  composerDocument: remoteComposerDocumentSchema.optional(),
});

const sessionQueueReorderPayloadSchema = sessionQueueItemPayloadSchema.extend({
  toIndex: z.number().int().nonnegative(),
});

const sessionSetModelPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  provider: nonEmptyString,
  modelId: nonEmptyString,
});

const sessionSetThinkingPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  level: z.string().trim().min(1).max(64),
});

const planModePayloadSchema = z.object({ enabled: z.boolean() });
const permissionModePayloadSchema = z.object({ mode: z.enum(["ask", "auto", "full-access"]) });

const interactionRespondPayloadSchema = z.object({
  sessionId: sessionIdSchema,
  requestId: z.string().trim().max(256).optional(),
  method: z.string().trim().max(256).optional(),
  cancelled: z.boolean().default(false),
  confirmed: z.boolean().optional(),
  text: z.string().max(200_000).optional(),
  answers: z.array(z.unknown()).max(20).optional(),
});

const requestEnvelopeBaseSchema = z.object({
  version: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("request"),
  requestId: requestIdSchema,
  name: z.enum(REMOTE_REQUEST_NAMES),
  payload: z.unknown().default({}),
});

export const remoteAuthEnvelopeSchema = z.object({
  version: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("auth"),
  requestId: requestIdSchema,
  deviceId: z.string().trim().min(1).max(128),
  token: z.string().trim().min(32).max(256),
});

export const remotePairRequestSchema = z.object({
  pairingId: z.string().trim().min(1).max(128),
  secret: z.string().trim().min(32).max(256),
  deviceName: z.string().trim().min(1).max(80),
});

export type RemoteRequestEnvelope = {
  version: typeof REMOTE_PROTOCOL_VERSION;
  kind: "request";
  requestId: string;
  name: RemoteRequestName;
  payload: Record<string, unknown>;
};

export function parseRemoteRequest(value: unknown): RemoteRequestEnvelope {
  const envelope = requestEnvelopeBaseSchema.parse(value);
  let payload: Record<string, unknown>;
  switch (envelope.name) {
    case "catalog.get":
      payload = z.object({}).parse(envelope.payload);
      break;
    case "session.get":
      payload = sessionGetPayloadSchema.parse(envelope.payload);
      break;
    case "session.create":
      payload = sessionCreatePayloadSchema.parse(envelope.payload);
      break;
    case "session.fork":
      payload = sessionForkPayloadSchema.parse(envelope.payload);
      break;
    case "session.close":
    case "session.reopen":
      payload = sessionIdPayloadSchema.parse(envelope.payload);
      break;
    case "session.send":
      payload = sessionSendPayloadSchema.parse(envelope.payload);
      break;
    case "session.abort":
    case "session.reload":
    case "session.models.get":
      payload = sessionIdPayloadSchema.parse(envelope.payload);
      break;
    case "session.actions.get":
      payload = sessionActionsPayloadSchema.parse(envelope.payload);
      break;
    case "session.queue.guide":
    case "session.queue.remove":
      payload = sessionQueueItemPayloadSchema.parse(envelope.payload);
      break;
    case "session.queue.edit":
      payload = sessionQueueEditPayloadSchema.parse(envelope.payload);
      break;
    case "session.queue.reorder":
      payload = sessionQueueReorderPayloadSchema.parse(envelope.payload);
      break;
    case "session.setModel":
      payload = sessionSetModelPayloadSchema.parse(envelope.payload);
      break;
    case "session.setThinking":
      payload = sessionSetThinkingPayloadSchema.parse(envelope.payload);
      break;
    case "settings.setPlanMode":
      payload = planModePayloadSchema.parse(envelope.payload);
      break;
    case "settings.setPermissionMode":
      payload = permissionModePayloadSchema.parse(envelope.payload);
      break;
    case "interaction.respond":
      payload = interactionRespondPayloadSchema.parse(envelope.payload);
      break;
    default:
      throw new Error("Unsupported remote request.");
  }
  return { ...envelope, payload };
}

export interface RemoteModel extends SharedModel {}

export interface RemoteSessionConfig {
  model: RemoteModel | null;
  thinkingLevel: string;
  planModeEnabled: boolean;
  permissionMode: AgentPermissionMode;
  availableModels?: RemoteModel[];
}

export interface RemoteAgent {
  id: string;
  name: string;
  description?: string;
  runtime: "cli" | "sdk" | "plugin";
  requiresProviderActivation?: boolean;
  supportsGuidance?: boolean;
  supportsActions?: boolean;
  supportsPermissions?: boolean;
}

export interface RemoteAgentAction extends AgentActionCatalogEntry {}
export interface RemoteAgentActionInvocation extends AgentActionInvocation {}

export interface RemoteSession {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  closed: boolean;
  status: "idle" | "running" | "completed" | "error";
  forkedFrom?: { sourceSessionId: string; sourceTitle: string };
  config?: RemoteSessionConfig;
}

export interface RemoteProject {
  id: string;
  name: string;
  createdAt: string;
  sessions: RemoteSession[];
}

export interface RemoteProcessEntry extends ProcessEntryView {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question" | "subagent";
  title: string;
  toolKind?: string;
  detail?: string;
  command?: string;
  exitCode?: number;
  timestamp: number;
  state?: "running" | "completed" | "warning" | "error" | "interrupted";
  files?: Array<Record<string, unknown>>;
  phase?: "started" | "completed";
  action?: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "started" | "interacted" | "interrupted";
  tool?: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
  activityKind?: "started" | "interacted" | "interrupted";
  startedAt?: number;
  completedAt?: number;
  guidanceDocument?: RemoteComposerDocument;
  guidanceImages?: Array<{ id: string; src: string; name: string }>;
  subagents?: Array<{
    id: string;
    label: string;
    status?: "pending" | "running" | "completed" | "error" | "interrupted";
    model?: string;
    path?: string;
    message?: string;
  }>;
}

export interface RemoteChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  systemType?: string;
  compactionState?: "running" | "completed" | "interrupted";
  images?: Array<{ id: string; src: string; name: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  diffs?: DiffLike[];
  process?: {
    startedAt: number;
    endedAt?: number;
    entries: RemoteProcessEntry[];
    planSteps?: Array<{ id: string; title: string; status: string }>;
    changeSummary?: { filesChanged: number; additions: number; deletions: number };
  };
  commentary?: Array<{
    id: string;
    content: string;
    timestamp: number;
    isStreaming?: boolean;
  }>;
  nativeTurnId?: string;
  action?: RemoteAgentActionInvocation;
  composerDocument?: RemoteComposerDocument;
}

export type RemoteComposerNode = Exclude<ComposerNode, { type: "image" }> |
  (Omit<Extract<ComposerNode, { type: "image" }>, "src"> & { src?: string });
export type RemoteComposerDocument = Omit<ComposerDocument, "nodes"> & { nodes: RemoteComposerNode[] };

export interface RemoteQueuedMessage {
  id: string;
  sessionId: string;
  editableContent?: string;
  displayContent: string;
  status: "queued" | "sending" | "failed";
  createdAt: number;
  error?: string;
  action?: RemoteAgentActionInvocation;
  images?: Array<{ id: string; name: string; src: string; mimeType: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  attachments?: Array<{ id: string; name: string; kind: "file" | "folder" | "snippet" }>;
  composerDocument?: RemoteComposerDocument;
}

export interface RemoteInteraction {
  sessionId: string;
  requestId?: string;
  method?: string;
  title?: string;
  description?: string;
  questions: QuestionnaireQuestion[];
}

export interface RemoteCatalogSnapshot {
  projects: RemoteProject[];
  agents: RemoteAgent[];
  hostEpoch: string;
}

export interface RemoteSessionCreateResult {
  projectId: string;
  session: RemoteSession;
  config: RemoteSessionConfig;
  warning?: string;
}

export type RemoteServerEnvelope =
  | {
      version: typeof REMOTE_PROTOCOL_VERSION;
      kind: "response";
      requestId: string;
      name: string;
      ok: true;
      payload: unknown;
      hostEpoch: string;
    }
  | {
      version: typeof REMOTE_PROTOCOL_VERSION;
      kind: "response";
      requestId: string;
      name: string;
      ok: false;
      error: { code: string; message: string };
      hostEpoch: string;
    }
  | {
      version: typeof REMOTE_PROTOCOL_VERSION;
      kind: "event";
      name: RemoteEventName;
      payload: unknown;
      revision?: number;
      hostEpoch: string;
    };

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastConnectedAt?: string;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  bindAddress: string;
  port: number;
  advertiseAddress: string;
  hostId: string;
  hostName: string;
  addresses: string[];
  devices: RemoteDeviceInfo[];
  error?: string;
}

export interface RemotePairingOffer {
  pairingUri: string;
  webPairingUrl: string;
  qrDataUrl: string;
  expiresAt: string;
}

export type RemoteRendererPublish =
  | {
      type: "snapshot";
      catalog: RemoteProject[];
      agents: RemoteAgent[];
      messages: Record<string, RemoteChatMessage[]>;
      queues: Record<string, RemoteQueuedMessage[]>;
      interactions: Record<string, RemoteInteraction | null>;
      configs: Record<string, RemoteSessionConfig>;
    }
  | { type: "catalog"; catalog: RemoteProject[]; agents: RemoteAgent[] }
  | { type: "session.message.upsert"; sessionId: string; message: RemoteChatMessage }
  | { type: "session.messages.replace"; sessionId: string; messages: RemoteChatMessage[] }
  | { type: "session.queue"; sessionId: string; queue: RemoteQueuedMessage[] }
  | { type: "session.interaction"; sessionId: string; interaction: RemoteInteraction | null }
  | { type: "session.config"; sessionId: string; config: RemoteSessionConfig };

export interface RemoteRendererCommand {
  commandId: string;
  name: RemoteRequestName;
  payload: Record<string, unknown>;
}

export interface RemoteRendererCommandResult {
  commandId: string;
  success: boolean;
  payload?: unknown;
  error?: string;
}
