import { useEffect, useRef, useState } from "react";
import {
  getAppDialogRequest,
  HPP_APP_DIALOG_EVENT,
  type AppDialogRequest,
} from "@/lib/app-dialog";

/**
 * Renders in-app alert/confirm dialogs queued through showAppAlert /
 * showAppConfirm. Mount once near the app root. Dialogs are shown one at a
 * time so overlapping requests cannot fight over focus.
 */
export function AppDialogHost() {
  const [queue, setQueue] = useState<AppDialogRequest[]>([]);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const active = queue[0] || null;

  useEffect(() => {
    const handleDialog = (event: Event) => {
      const request = getAppDialogRequest(event);
      if (request) setQueue((current) => [...current, request]);
    };
    window.addEventListener(HPP_APP_DIALOG_EVENT, handleDialog);
    return () => window.removeEventListener(HPP_APP_DIALOG_EVENT, handleDialog);
  }, []);

  useEffect(() => {
    if (!active) return;
    // Take focus into the dialog explicitly: the native popups this replaces
    // used to leave the window without usable focus afterwards.
    confirmButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      active.settle(false);
      setQueue((current) => current.slice(1));
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active]);

  if (!active) return null;

  const isConfirm = active.kind === "confirm";
  const title = active.title || (isConfirm ? "请确认" : "提示");
  const close = (confirmed: boolean) => {
    active.settle(confirmed);
    setQueue((current) => current.slice(1));
  };

  return (
    <div className="app-dialog-overlay" onClick={() => close(false)}>
      <div
        className="app-dialog"
        role={isConfirm ? "alertdialog" : "alert"}
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="app-dialog-title">{title}</h3>
        <p className="app-dialog-message">{active.message}</p>
        <div className="app-dialog-actions">
          {isConfirm && (
            <button type="button" className="app-dialog-btn" onClick={() => close(false)}>
              {active.cancelLabel || "取消"}
            </button>
          )}
          <button
            ref={confirmButtonRef}
            type="button"
            className="app-dialog-btn primary"
            onClick={() => close(true)}
          >
            {active.confirmLabel || "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
