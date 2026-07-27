import { describe, expect, it } from "vitest";
import { detectDesktopEnvironment, getLinuxChromiumSwitches } from "./linux-desktop";

describe("Linux desktop environment detection", () => {
  it("detects niri from its IPC socket in a Wayland session", () => {
    expect(detectDesktopEnvironment("linux", {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-1",
      NIRI_SOCKET: "/run/user/1000/niri.wayland-1.sock",
    })).toEqual({
      isWayland: true,
      isNiri: true,
      isX11: false,
      displayServer: "wayland",
    });
  });

  it("detects niri from XDG_CURRENT_DESKTOP without relying on the display name", () => {
    expect(detectDesktopEnvironment("linux", {
      XDG_CURRENT_DESKTOP: "niri:GNOME",
      WAYLAND_DISPLAY: "wayland-0",
    }).isNiri).toBe(true);
  });

  it("detects an X11 fallback from DISPLAY", () => {
    expect(detectDesktopEnvironment("linux", { DISPLAY: ":0" })).toMatchObject({
      isWayland: false,
      isX11: true,
      displayServer: "x11",
    });
  });

  it("does not report Linux display servers on other platforms", () => {
    expect(detectDesktopEnvironment("win32", {
      WAYLAND_DISPLAY: "wayland-0",
      NIRI_SOCKET: "/tmp/niri.sock",
    })).toEqual({
      isWayland: false,
      isNiri: false,
      isX11: false,
      displayServer: "unknown",
    });
  });
});

describe("Linux Chromium switches", () => {
  it("uses automatic Ozone selection without forcing IME, GPU, or scale overrides", () => {
    expect(getLinuxChromiumSwitches("linux", {})).toEqual([
      { name: "ozone-platform-hint", value: "auto" },
    ]);
  });

  it("allows explicit Wayland compatibility overrides", () => {
    expect(getLinuxChromiumSwitches("linux", {
      HPP_OZONE_PLATFORM: "wayland",
      HPP_DISABLE_WAYLAND_IME: "true",
      HPP_ENABLE_VAAPI: "1",
      HPP_FORCE_DEVICE_SCALE_FACTOR: "1.25",
    })).toEqual([
      { name: "ozone-platform", value: "wayland" },
      { name: "disable-features", value: "WaylandIme" },
      { name: "enable-features", value: "VaapiVideoDecodeLinuxGL,VaapiVideoEncoder" },
      { name: "force-device-scale-factor", value: "1.25" },
    ]);
  });

  it("ignores invalid scale overrides and all switches outside Linux", () => {
    expect(getLinuxChromiumSwitches("linux", {
      HPP_FORCE_DEVICE_SCALE_FACTOR: "0",
    })).toEqual([{ name: "ozone-platform-hint", value: "auto" }]);
    expect(getLinuxChromiumSwitches("darwin", {
      HPP_OZONE_PLATFORM: "wayland",
    })).toEqual([]);
  });
});
