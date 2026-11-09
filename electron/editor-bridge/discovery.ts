import { app } from "electron";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

import {
  EDITOR_BRIDGE_DISCOVERY_FILENAME,
  type EditorBridgeDiscovery,
} from "../../shared/editor-bridge-protocol";

export function getEditorBridgeDirectory() {
  return join(app.getPath("userData"), "hpp-data");
}

export function getEditorBridgeDiscoveryPath() {
  return join(getEditorBridgeDirectory(), EDITOR_BRIDGE_DISCOVERY_FILENAME);
}

/** 客户端随时可能读到这个文件，先写临时文件再 rename，避免读到半截 JSON。 */
export async function writeEditorBridgeDiscovery(record: EditorBridgeDiscovery) {
  const target = getEditorBridgeDiscoveryPath();
  const temporary = `${target}.tmp`;
  await mkdir(getEditorBridgeDirectory(), { recursive: true });
  await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeEditorBridgeDiscovery() {
  await rm(getEditorBridgeDiscoveryPath(), { force: true });
}
