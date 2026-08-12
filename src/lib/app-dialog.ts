// In-app replacements for window.alert / window.confirm.
//
// Electron renders these as native OS popups that steal focus from the
// BrowserWindow and never hand it back correctly on Windows
// (electron/electron#41602): after such a popup closes, clicking any input in
// the window — including the chat composer's contentEditable — no longer
// focuses it. All confirmations and notices must therefore stay inside the
// page (see AppDialogHost).

export const HPP_APP_DIALOG_EVENT = "hpp-app-dialog";

export type AppDialogKind = "alert" | "confirm";

export type AppDialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type AppDialogRequest = AppDialogOptions & {
  kind: AppDialogKind;
  message: string;
  settle: (confirmed: boolean) => void;
};

/** Fire-and-forget notice; replaces window.alert without breaking focus. */
export function showAppAlert(message: string, options?: AppDialogOptions): void {
  window.dispatchEvent(new CustomEvent<AppDialogRequest>(HPP_APP_DIALOG_EVENT, {
    detail: { kind: "alert", message, settle: () => undefined, ...options },
  }));
}

/** Promise-based confirmation; replaces window.confirm without breaking focus. */
export function showAppConfirm(message: string, options?: AppDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<AppDialogRequest>(HPP_APP_DIALOG_EVENT, {
      detail: { kind: "confirm", message, settle: resolve, ...options },
    }));
  });
}

export function getAppDialogRequest(event: Event): AppDialogRequest | null {
  const detail = (event as CustomEvent<AppDialogRequest>).detail;
  if (!detail || typeof detail.message !== "string" || typeof detail.settle !== "function") {
    return null;
  }
  return detail;
}
