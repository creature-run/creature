import type {
  CreateMessageRequestParams,
  ModelPreferences,
  SamplingMessageContentBlock,
  Tool,
  ToolChoice,
} from "@modelcontextprotocol/sdk/types.js";
import { getMainWindow } from "../window/mainWindow";

export type SamplingStage = "request" | "review";

export type SamplingRequestEvent = {
  requestId: string;
  stage: "request";
  serverName: string;
  modelId: string;
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  contextText?: string;
  messages: CreateMessageRequestParams["messages"];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  modelPreferences?: ModelPreferences;
  metadata?: Record<string, unknown>;
};

export type SamplingReviewEvent = {
  requestId: string;
  stage: "review";
  serverName: string;
  modelId: string;
  content: SamplingMessageContentBlock[];
};

export type SamplingEvent = SamplingRequestEvent | SamplingReviewEvent;

export type SamplingResponse = {
  requestId: string;
  stage: SamplingStage;
  action: "approve" | "reject";
  editedSystemPrompt?: string;
  editedMessages?: CreateMessageRequestParams["messages"];
  editedContent?: SamplingMessageContentBlock[];
  reason?: string;
};

const pendingResponses = new Map<string, { resolve: (value: SamplingResponse) => void; reject: (error: Error) => void }>();

const responseKey = (requestId: string, stage: SamplingStage) => `${requestId}:${stage}`;

export const requestSamplingApproval = async (event: SamplingEvent): Promise<SamplingResponse> => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    throw new Error("Main window unavailable");
  }
  const key = responseKey(event.requestId, event.stage);
  return new Promise((resolve, reject) => {
    pendingResponses.set(key, { resolve, reject });
    win.webContents.send("sampling:event", event);
  });
};

export const handleSamplingResponse = (response: SamplingResponse): { success: boolean; error?: string } => {
  const key = responseKey(response.requestId, response.stage);
  const pending = pendingResponses.get(key);
  if (!pending) {
    return { success: false, error: "No pending sampling request" };
  }
  pendingResponses.delete(key);
  if (response.action === "approve") {
    pending.resolve(response);
    return { success: true };
  }
  pending.reject(new Error(response.reason || "User rejected sampling request"));
  return { success: true };
};
