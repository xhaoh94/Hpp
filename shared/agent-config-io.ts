import type { AgentConfigState, AgentProviderConfig } from "../src/types";
import { createCopiedProviderId } from "./agent-provider-copy";

/**
 * Versioned on-disk format for exporting / importing agent channel
 * (provider) configurations. Kept in `shared/` so both the main process
 * (write/read + validation) and the renderer (selection UI) can share the
 * shape without drift.
 */

export const AGENT_CONFIG_EXPORT_TYPE = "hpp-agent-config-export";
export const AGENT_CONFIG_EXPORT_VERSION = 1;

export interface AgentConfigExportAgentEntry {
  activeProviderId?: string;
  providers: AgentProviderConfig[];
}

export interface AgentConfigExportData {
  type: typeof AGENT_CONFIG_EXPORT_TYPE;
  version: number;
  exportedAt: string;
  /** Whether the payload contains apiKey values. */
  includeApiKeys: boolean;
  agents: Record<string, AgentConfigExportAgentEntry>;
}

export interface AgentConfigImportConflictPlan {
  /** "overwrite" | "skip" | "create" (create as-new/copy provider id) */
  action: "overwrite" | "skip" | "create";
  /** Only for action "create": the new provider id to use. */
  newProviderId?: string;
}

/** Per-target-agent import decisions keyed by source provider id. */
export type AgentConfigImportDecision = Record<
  string,
  Record<string, AgentConfigImportConflictPlan>
>;

/** Per-agent import plan produced while parsing an import file. */
export interface AgentConfigImportAgent {
  targetAgentId: string;
  /** The raw provider entries parsed from the file for this agent. */
  providers: AgentProviderConfig[];
}

export function createAgentConfigExportData(
  agents: Record<string, AgentConfigExportAgentEntry>,
  includeApiKeys: boolean,
): AgentConfigExportData {
  return {
    type: AGENT_CONFIG_EXPORT_TYPE,
    version: AGENT_CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    includeApiKeys,
    agents,
  };
}

/**
 * Strip apiKey values (in place on copies) so a neutral export never leaks
 * secrets even if the caller forgot to filter.
 */
export function sanitizeAgentConfigExport(
  data: AgentConfigExportData,
  includeApiKeys: boolean,
): AgentConfigExportData {
  if (includeApiKeys) return data;
  return {
    ...data,
    includeApiKeys: false,
    agents: Object.fromEntries(
      Object.entries(data.agents).map(([agentId, entry]) => [
        agentId,
        {
          activeProviderId: entry.activeProviderId,
          providers: entry.providers.map((provider) => ({
            ...provider,
            apiKey: "",
          })),
        },
      ]),
    ),
  };
}

export function isValidAgentConfigExport(value: unknown): value is AgentConfigExportData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type !== AGENT_CONFIG_EXPORT_TYPE) return false;
  if (typeof record.version !== "number" || record.version !== AGENT_CONFIG_EXPORT_VERSION) {
    return false;
  }
  if (typeof record.includeApiKeys !== "boolean") return false;
  if (!record.agents || typeof record.agents !== "object") return false;
  return true;
}

/**
 * Resolve the conflict plan for a single in-coming provider against existing
 * provider ids of the target agent. `decision` is the user's per-item plan
 * when it was previously chosen (e.g. after an earlier pass), otherwise a
 * sensible default.
 */
export function resolveImportProviderId(
  incoming: AgentProviderConfig,
  existingProviderIds: Iterable<string>,
  plan?: AgentConfigImportConflictPlan,
): { providerId: string; action: "overwrite" | "create" | "skip" } {
  if (plan?.action === "skip") return { providerId: incoming.providerId, action: "skip" };
  if (plan?.action === "create") {
    return {
      providerId: plan.newProviderId || createCopiedProviderId(incoming.providerId, existingProviderIds),
      action: "create",
    };
  }
  const exists = Array.from(existingProviderIds).includes(incoming.providerId);
  if (exists) return { providerId: incoming.providerId, action: "overwrite" };
  return { providerId: incoming.providerId, action: "create" };
}
