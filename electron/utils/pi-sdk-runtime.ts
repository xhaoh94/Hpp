import { app } from "electron";
import { join } from "path";

export const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export const getPiSDKUserRuntimeRoot = () =>
  join(app.getPath("userData"), "hpp-data", "pi-sdk-runtime");

export const getPiSDKPackageJsonPath = (packageRoot: string) =>
  join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

export const getPiSDKPackageRoot = (packageRoot: string) =>
  join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
