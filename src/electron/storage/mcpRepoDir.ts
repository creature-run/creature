/**
 * MCP Repo Directory Helper
 *
 * Computes and creates per-project/per-MCP repo directories under Electron's userData.
 *
 * Directory structure:
 *   userData/projects/<projectId>/mcps/<mcpKey>/
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getUserDataProjectDir } from "./projectSettings";

const sanitizeServerName = (serverName: string): string => {
  return serverName
    .replace(/[@/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .substring(0, 64);
};

const shortHash = (serverName: string): string => {
  return crypto.createHash("sha256").update(serverName).digest("hex").substring(0, 8);
};

const getMcpKey = (serverName: string): string => {
  const sanitized = sanitizeServerName(serverName);
  const hash = shortHash(serverName);
  return sanitized ? `${sanitized}--${hash}` : hash;
};

export const getMcpRepoDir = ({
  projectId,
  serverName,
}: {
  projectId: string;
  serverName: string;
}): string => {
  const projectDir = getUserDataProjectDir(projectId);
  const reposRoot = path.join(projectDir, "mcps");
  const repoDir = path.join(reposRoot, getMcpKey(serverName));

  if (!fs.existsSync(reposRoot)) {
    fs.mkdirSync(reposRoot, { recursive: true });
  }

  return repoDir;
};
