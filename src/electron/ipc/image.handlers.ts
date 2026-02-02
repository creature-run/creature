/**
 * Image Upload IPC Handlers
 *
 * Handles image file processing for use in AI chat messages.
 * Validates image types and returns data URLs for local-first operation.
 */

import { ipcMain, app } from "electron";
import { readFile, mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";

/**
 * Maximum file size: 5MB (Anthropic's limit)
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Allowed image extensions and their MIME types.
 */
const ALLOWED_IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Uploaded image result.
 */
export interface UploadedImage {
  url: string;
  filename: string;
  size: number;
  contentType: string;
  localPath: string;
}

/**
 * Get the local images directory path.
 */
const getImagesDir = (): string => {
  return path.join(app.getPath("userData"), "images");
};

/**
 * Ensure the images directory exists.
 */
const ensureImagesDir = async (): Promise<void> => {
  const dir = getImagesDir();
  await mkdir(dir, { recursive: true });
};

/**
 * Registers image upload IPC handlers.
 */
export const registerImageHandlers = () => {
  /**
   * Process an image file for use in AI messages.
   * Stores locally and returns a data URL.
   * Can accept either a file path or a buffer with filename.
   */
  ipcMain.handle(
    "image:upload",
    async (_, { filePath, buffer, filename, projectId }: {
      filePath?: string;
      buffer?: Uint8Array;
      filename?: string;
      projectId: string
    }) => {
      try {
        // Get file buffer - either from file path or provided buffer
        let fileBuffer: Buffer;
        let finalFilename: string;

        if (filePath) {
          // Read from file path
          fileBuffer = await readFile(filePath);
          finalFilename = filePath.split("/").pop() || "image";
        } else if (buffer && filename) {
          // Use provided buffer
          fileBuffer = Buffer.from(buffer);
          finalFilename = filename;
        } else {
          return { success: false, error: "Either filePath or buffer+filename must be provided" };
        }

        // Check file size
        if (fileBuffer.length > MAX_FILE_SIZE) {
          return { success: false, error: "File size exceeds 5MB limit (Anthropic's maximum)" };
        }

        // Detect content type from file extension
        const extension = finalFilename.split(".").pop()?.toLowerCase();
        const contentType = extension ? ALLOWED_IMAGE_EXTENSIONS[extension] : undefined;

        if (!contentType) {
          return { success: false, error: "Invalid image type. Only JPEG, PNG, GIF, and WebP are allowed" };
        }

        // Generate a unique filename for local storage
        const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex").slice(0, 12);
        const localFilename = `${projectId}_${hash}_${finalFilename}`;

        // Store the image locally
        await ensureImagesDir();
        const localPath = path.join(getImagesDir(), localFilename);
        await writeFile(localPath, fileBuffer);

        // Create a data URL for the image
        const base64Data = fileBuffer.toString("base64");
        const dataUrl = `data:${contentType};base64,${base64Data}`;

        const result: UploadedImage = {
          url: dataUrl,
          filename: finalFilename,
          size: fileBuffer.length,
          contentType,
          localPath,
        };

        return { success: true, image: result };
      } catch (error) {
        console.error("[Image Upload] Error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Processing failed",
        };
      }
    }
  );
};
