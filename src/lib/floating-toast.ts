import { formatModelSwitchToastText } from "../../shared/model-switch";
import { requiresProviderActivation } from "@/lib/agents";

export const HPP_FLOATING_TOAST_EVENT = "hpp-floating-toast";
export type FloatingToastTone = "success" | "error" | "warning";

export function showFloatingToastMessage(text: string, tone: FloatingToastTone = "success") {
  window.dispatchEvent(new CustomEvent(HPP_FLOATING_TOAST_EVENT, { detail: { text, tone } }));
}

export function getModelSwitchToastText(agentId: string, provider: string, modelName: string) {
  return formatModelSwitchToastText(requiresProviderActivation(agentId), provider, modelName);
}

export function getFloatingToastDetail(event: Event): { text: string; tone: FloatingToastTone } {
  const detail = (event as CustomEvent<{ text?: unknown; tone?: unknown }>).detail;
  const text = typeof detail?.text === "string" ? detail.text : "";
  const tone: FloatingToastTone = detail?.tone === "error" || detail?.tone === "warning" ? detail.tone : "success";
  return { text, tone };
}
