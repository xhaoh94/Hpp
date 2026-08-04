import type { ComposerNode } from "@shared/composer-document";

export const COMPOSER_INSERT_EVENT = "hpp:composer-insert";

export type ComposerInsertEventDetail = {
  node: Exclude<ComposerNode, { type: "text" }>;
  sessionId?: string;
};

export function requestComposerInsert(detail: ComposerInsertEventDetail) {
  const event = new CustomEvent<ComposerInsertEventDetail>(COMPOSER_INSERT_EVENT, {
    detail,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
