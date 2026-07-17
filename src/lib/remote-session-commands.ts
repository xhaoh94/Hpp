import {
  SessionCommandCoordinator,
} from "@/lib/session-command-coordinator";
import type { ProjectSession } from "@/stores/project-store";
import type { PendingUIResponse } from "@/components/layout/agentEventTypes";
import type {
  AgentImagePayload,
  RemoteRendererCommand,
  RemoteSession,
  RemoteSessionConfig,
  RemoteSessionCreateResult,
} from "@/types";
import { MAX_REMOTE_SESSION_REFERENCES } from "@shared/remote-protocol";

export type RemoteCommandContext = {
  pendingInteraction: PendingUIResponse;
  abortSession: (sessionId: string) => Promise<boolean>;
  clearPendingInteraction: (sessionId: string) => void;
};

const getString = (value: unknown) => typeof value === "string" ? value : "";

async function getSessionConfig(sessionId: string, includeModels = false): Promise<RemoteSessionConfig> {
  const state = await SessionCommandCoordinator.getSessionCommandConfig(sessionId, includeModels);
  const settings = await window.electronAPI.loadData("settings").catch(() => null) as
    { general?: { planModeEnabled?: unknown } } | null;
  return {
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    planModeEnabled: settings?.general?.planModeEnabled === true,
    availableModels: state.availableModels,
  };
}

async function publishSessionConfig(sessionId: string, includeModels = false) {
  const config = await getSessionConfig(sessionId, includeModels);
  window.electronAPI.remotePublish({ type: "session.config", sessionId, config });
  return config;
}

function toRemoteSession(session: ProjectSession, config: RemoteSessionConfig): RemoteSession {
  return {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    closed: session.closed === true,
    status: SessionCommandCoordinator.getSessionCommandStatus(session.id),
    ...(session.forkedFrom ? {
      forkedFrom: {
        sourceSessionId: session.forkedFrom.sourceSessionId,
        sourceTitle: session.forkedFrom.sourceTitle,
      },
    } : {}),
    config,
  };
}

async function serializeSessionResult(
  result: { project: { id: string }; session: ProjectSession; warning?: string },
  includeModels = false,
): Promise<RemoteSessionCreateResult> {
  const config = await getSessionConfig(result.session.id, includeModels);
  return {
    projectId: result.project.id,
    session: toRemoteSession(result.session, config),
    config,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

async function createRemoteSession(payload: Record<string, unknown>) {
  const result = await SessionCommandCoordinator.createSession({
    projectId: getString(payload.projectId),
    agentId: getString(payload.agentId),
    sessionId: getString(payload.clientSessionId),
    activate: false,
  });
  const serialized = await serializeSessionResult(result, true);
  window.electronAPI.remotePublish({
    type: "session.config",
    sessionId: result.session.id,
    config: serialized.config,
  });
  return serialized;
}

async function forkRemoteSession(payload: Record<string, unknown>) {
  const result = await SessionCommandCoordinator.forkSession({
    sourceSessionId: getString(payload.sessionId),
    throughMessageId: getString(payload.throughMessageId),
    sessionId: getString(payload.clientSessionId),
    activate: false,
  });
  return serializeSessionResult(result);
}

async function closeRemoteSession(payload: Record<string, unknown>, context: RemoteCommandContext) {
  const result = await SessionCommandCoordinator.closeSession(getString(payload.sessionId), {
    clearPendingInteraction: context.clearPendingInteraction,
  });
  return serializeSessionResult(result);
}

async function reopenRemoteSession(payload: Record<string, unknown>) {
  const result = await SessionCommandCoordinator.reopenSession(getString(payload.sessionId));
  return serializeSessionResult(result);
}

async function sendRemoteMessage(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  const clientMessageId = getString(payload.clientMessageId);
  if (!sessionId || !clientMessageId) throw new Error("INVALID_REQUEST");
  await SessionCommandCoordinator.initializeSession(sessionId);
  const content = getString(payload.content).trim();
  const rawReferenceIds = Array.isArray(payload.sessionReferences)
    ? payload.sessionReferences.map((value) => getString(
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).sourceSessionId
          : undefined,
      )).filter(Boolean)
    : [];
  const referenceContext = SessionCommandCoordinator.prepareSessionReferenceContext(
    sessionId,
    rawReferenceIds,
    MAX_REMOTE_SESSION_REFERENCES,
  );
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const messageImages = rawImages.map((image) => {
    const raw = image as { id: string; name: string; mimeType: string; data: string };
    return { id: raw.id, name: raw.name, src: `data:${raw.mimeType};base64,${raw.data}` };
  });
  const agentImages: AgentImagePayload = rawImages.map((image) => {
    const raw = image as { mimeType: string; data: string };
    return { type: "image", mimeType: raw.mimeType, data: raw.data };
  });
  const displayContent = content || (rawImages.length > 0 ? "请查看附件图片。" : "");
  const contextBlocks = referenceContext.contextBlocks;
  if (!displayContent && contextBlocks.length === 0) throw new Error("INVALID_REQUEST");
  const sendContent = contextBlocks.length > 0
    ? [...contextBlocks, "", "<current_user_message>", displayContent, "</current_user_message>"].join("\n")
    : displayContent;
  const result = await SessionCommandCoordinator.sendMessage({
    sessionId,
    clientMessageId,
    throwOnFailure: true,
    message: {
      displayContent: displayContent || referenceContext.displayText,
      sendContent,
      messageImages: messageImages.length > 0 ? messageImages : undefined,
      sessionReferences: referenceContext.messageReferences.length > 0 ? referenceContext.messageReferences : undefined,
      agentImages: agentImages.length > 0 ? agentImages : undefined,
      planModeEnabled: payload.planModeEnabled === true,
      forkContextUsed: !!referenceContext.session.forkContext,
    },
  });
  return { ...result, agentId: referenceContext.session.agentId };
}

async function setRemoteModel(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  await SessionCommandCoordinator.setModel(sessionId, {
    provider: getString(payload.provider),
    id: getString(payload.modelId),
  });
  return publishSessionConfig(sessionId, true);
}

async function setRemoteThinking(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  await SessionCommandCoordinator.setThinking(sessionId, getString(payload.level));
  return publishSessionConfig(sessionId, true);
}

async function setRemotePlanMode(payload: Record<string, unknown>) {
  const result = await SessionCommandCoordinator.setPlanMode(payload.enabled === true);
  for (const sessionId of SessionCommandCoordinator.getAllSessionCommandIds()) void publishSessionConfig(sessionId);
  return result;
}

async function respondToRemoteInteraction(payload: Record<string, unknown>, context: RemoteCommandContext) {
  return SessionCommandCoordinator.respondToInteraction({
    sessionId: getString(payload.sessionId),
    cancelled: payload.cancelled === true,
    answers: Array.isArray(payload.answers) ? payload.answers : undefined,
    text: getString(payload.text),
  }, {
    pendingInteraction: context.pendingInteraction,
    clearPendingInteraction: context.clearPendingInteraction,
  });
}

export async function abortRemoteSession(sessionId: string, context: RemoteCommandContext) {
  const success = await context.abortSession(sessionId);
  if (!success) throw new Error("ABORT_FAILED");
  context.clearPendingInteraction(sessionId);
  return { success: true };
}

export async function executeRemoteSessionCommand(
  command: RemoteRendererCommand,
  context: RemoteCommandContext,
): Promise<unknown> {
  const payload = command.payload;
  switch (command.name) {
    case "session.create": return createRemoteSession(payload);
    case "session.fork": return forkRemoteSession(payload);
    case "session.close": return closeRemoteSession(payload, context);
    case "session.reopen": return reopenRemoteSession(payload);
    case "session.send": return sendRemoteMessage(payload);
    case "session.abort": {
      const sessionId = getString(payload.sessionId);
      await SessionCommandCoordinator.initializeSession(sessionId);
      return abortRemoteSession(sessionId, context);
    }
    case "session.reload": {
      const sessionId = getString(payload.sessionId);
      const result = await SessionCommandCoordinator.reloadSession(sessionId);
      return {
        reloaded: result.reloadedSessionIds?.includes(sessionId) === true,
        config: await publishSessionConfig(sessionId, true),
      };
    }
    case "session.queue.guide":
      return SessionCommandCoordinator.guideQueuedMessage(getString(payload.sessionId), getString(payload.queueItemId));
    case "session.queue.remove":
      return SessionCommandCoordinator.removeQueuedMessage(getString(payload.sessionId), getString(payload.queueItemId));
    case "session.setModel": return setRemoteModel(payload);
    case "session.setThinking": return setRemoteThinking(payload);
    case "session.models.get": {
      const sessionId = getString(payload.sessionId);
      return publishSessionConfig(sessionId, true);
    }
    case "settings.setPlanMode": return setRemotePlanMode(payload);
    case "interaction.respond": return respondToRemoteInteraction(payload, context);
    default: throw new Error("UNSUPPORTED_REMOTE_COMMAND");
  }
}
