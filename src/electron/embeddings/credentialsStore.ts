import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmbeddingsCredentials } from "../../shared/embeddings";
import { getRuntimeAppName } from "../utils/appIdentity";

const getEncryptionKey = (): Buffer => {
  const appName = getRuntimeAppName();
  return crypto.createHash("sha256").update(appName).digest();
};

const encrypt = (text: string): Buffer => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
};

const decrypt = (data: Buffer): string => {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
  return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
};

const getStoragePath = (): string => {
  return path.join(app.getPath("userData"), "embeddings.enc");
};

export const saveEmbeddingsCredentials = async (credentials: EmbeddingsCredentials): Promise<void> => {
  const data = JSON.stringify(credentials);
  const encryptedData = encrypt(data);
  fs.writeFileSync(getStoragePath(), encryptedData);
};

export const loadEmbeddingsCredentials = async (): Promise<EmbeddingsCredentials | null> => {
  try {
    const storagePath = getStoragePath();
    if (!fs.existsSync(storagePath)) {
      return null;
    }
    const encryptedData = fs.readFileSync(storagePath);
    const decryptedData = decrypt(encryptedData);
    const credentials = JSON.parse(decryptedData) as EmbeddingsCredentials;
    if (!credentials.type) {
      throw new Error("Invalid credentials structure");
    }
    return credentials;
  } catch {
    await clearEmbeddingsCredentials();
    return null;
  }
};

export const clearEmbeddingsCredentials = async (): Promise<void> => {
  const storagePath = getStoragePath();
  if (fs.existsSync(storagePath)) {
    fs.unlinkSync(storagePath);
  }
};

export const hasEmbeddingsCredentials = async (): Promise<boolean> => {
  const credentials = await loadEmbeddingsCredentials();
  return credentials !== null;
};
