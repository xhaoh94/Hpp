import { formatModelSwitchToastText } from "../../shared/model-switch";
import { requiresProviderActivation } from "@/lib/agents";

export const HPP_FLOATING_TOAST_EVENT = "hpp-floating-toast";

export function showFloatingToastMessage(text: string) {
  window.dispatchEvent(new CustomEvent(HPP_FLOATING_TOAST_EVENT, { detail: { text } }));
}

export function getModelSwitchToastText(agentId: string, provider: string, modelName: string) {
  return formatModelSwitchToastText(requiresProviderActivation(agentId), provider, modelName);
}

export function getFloatingToastText(event: Event) {
  const detail = (event as CustomEvent<{ text?: unknown }>).detail;
  return typeof detail?.text === "string" ? detail.text : "";
}
