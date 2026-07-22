import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";

describe("app store file reveal", () => {
  beforeEach(() => {
    useAppStore.setState({
      sidebarTab: "settings",
      sidebarCollapsed: true,
      fileRevealRequest: null,
    });
  });

  it("opens the file tab and creates a fresh request for repeated paths", () => {
    useAppStore.getState().revealFile("C:\\work\\src\\App.tsx", { preview: true });
    expect(useAppStore.getState()).toMatchObject({
      sidebarTab: "files",
      sidebarCollapsed: false,
      fileRevealRequest: {
        path: "C:\\work\\src\\App.tsx",
        requestId: 1,
        preview: true,
      },
    });

    useAppStore.getState().revealFile("C:\\work\\src\\App.tsx");
    expect(useAppStore.getState().fileRevealRequest).toMatchObject({
      requestId: 2,
      preview: false,
    });
  });
});
