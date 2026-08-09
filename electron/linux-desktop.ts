export type DesktopEnvironment = {
  isWayland: boolean;
  isNiri: boolean;
  isX11: boolean;
  displayServer: "wayland" | "x11" | "unknown";
};

export type ChromiumSwitch = {
  name: string;
  value?: string;
};

type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

const enabled = (value: string | undefined) =>
  /^(?:1|true|yes|on)$/i.test(value?.trim() || "");

const containsDesktop = (value: string | undefined, desktop: string) =>
  (value || "")
    .toLowerCase()
    .split(/[:;,]/)
    .map((part) => part.trim())
    .includes(desktop);

export function detectDesktopEnvironment(
  platform = process.platform,
  variables: EnvironmentVariables = process.env,
): DesktopEnvironment {
  if (platform !== "linux") {
    return { isWayland: false, isNiri: false, isX11: false, displayServer: "unknown" };
  }

  const sessionType = variables.XDG_SESSION_TYPE?.trim().toLowerCase();
  const isWayland = sessionType === "wayland" || !!variables.WAYLAND_DISPLAY?.trim();
  const isX11 = sessionType === "x11" || (!isWayland && !!variables.DISPLAY?.trim());
  const isNiri = !!variables.NIRI_SOCKET?.trim()
    || containsDesktop(variables.XDG_CURRENT_DESKTOP, "niri")
    || containsDesktop(variables.DESKTOP_SESSION, "niri");

  return {
    isWayland,
    isNiri,
    isX11,
    displayServer: isWayland ? "wayland" : isX11 ? "x11" : "unknown",
  };
}

export function getLinuxChromiumSwitches(
  platform = process.platform,
  variables: EnvironmentVariables = process.env,
  desktop: DesktopEnvironment = detectDesktopEnvironment(platform, variables),
): ChromiumSwitch[] {
  if (platform !== "linux") return [];

  const switches: ChromiumSwitch[] = [];
  const requestedPlatform = variables.HPP_OZONE_PLATFORM?.trim().toLowerCase();
  if (requestedPlatform === "wayland" || requestedPlatform === "x11") {
    switches.push({ name: "ozone-platform", value: requestedPlatform });
  } else {
    switches.push({ name: "ozone-platform-hint", value: "auto" });
  }

  // Use the maintained text-input-v3 protocol for Wayland IME. Chromium's
  // legacy text-input-v1 implementation races on fast typing and drops keys
  // with fcitx5: letters bypass the composition and leak as plain text.
  // HPP_DISABLE_WAYLAND_IME opts out entirely; HPP_WAYLAND_TEXT_INPUT_VERSION
  // overrides the protocol version for compositors with incompatible v3 support.
  if (enabled(variables.HPP_DISABLE_WAYLAND_IME)) {
    switches.push({ name: "disable-features", value: "WaylandIme" });
  } else if (desktop.isWayland) {
    switches.push({ name: "enable-wayland-ime" });
    const requestedVersion = variables.HPP_WAYLAND_TEXT_INPUT_VERSION?.trim();
    const textInputVersion = requestedVersion === "1" || requestedVersion === "2"
      ? requestedVersion
      : "3";
    switches.push({ name: "wayland-text-input-version", value: textInputVersion });
  }
  if (enabled(variables.HPP_ENABLE_VAAPI)) {
    switches.push({
      name: "enable-features",
      value: "VaapiVideoDecodeLinuxGL,VaapiVideoEncoder",
    });
  }

  const requestedScale = variables.HPP_FORCE_DEVICE_SCALE_FACTOR?.trim();
  if (requestedScale
    && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(requestedScale)
    && Number(requestedScale) > 0) {
    switches.push({ name: "force-device-scale-factor", value: requestedScale });
  }

  return switches;
}
