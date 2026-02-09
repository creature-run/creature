/**
 * AI Provider Configuration
 *
 * Multi-provider support for the agent system.
 * Supports Anthropic API, AWS Bedrock, and Google Vertex AI.
 * Used by both the main agent and context compaction.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import {
  DEFAULT_CHAT_MODEL,
  type ChatModelPreference,
  type ProviderCredentials,
} from "../../shared/credentials";

/**
 * Chat model IDs across providers.
 */
export const MODEL_IDS: Record<ChatModelPreference, { anthropic: string; bedrock: string; vertex: string }> = {
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5",
    bedrock: "anthropic.claude-haiku-4-5-20250514-v1:0",
    vertex: "claude-haiku-4-5@20250514",
  },
  "sonnet-4-5": {
    anthropic: "claude-sonnet-4-5",
    bedrock: "anthropic.claude-sonnet-4-5-20250514-v1:0",
    vertex: "claude-sonnet-4-5@20250514",
  },
  "opus-4-6": {
    anthropic: "claude-opus-4-6",
    bedrock: "anthropic.claude-sonnet-4-5-20250514-v1:0",
    vertex: "claude-sonnet-4-5@20250514",
  },
} as const;

/**
 * Model IDs for Claude Haiku 4.5 (used for context compaction).
 */
export const HAIKU_MODEL_IDS = {
  anthropic: "claude-haiku-4-5",
  bedrock: "anthropic.claude-haiku-4-5-20250514-v1:0",
  vertex: "claude-haiku-4-5@20250514",
} as const;

/**
 * Creates an Anthropic provider configured with the user's API key.
 * Connects directly to the Anthropic API.
 */
export const createAnthropicProvider = ({ apiKey }: { apiKey: string }) => {
  return createAnthropic({ apiKey })
};

/**
 * Creates an AWS Bedrock provider configured with the user's AWS credentials.
 */
export const createBedrockProvider = ({
  accessKeyId,
  secretAccessKey,
  region,
}: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}) => {
  return createAmazonBedrock({
    region,
    accessKeyId,
    secretAccessKey,
  });
};

/**
 * Creates a Google Vertex AI provider configured with the user's service account.
 */
export const createVertexProvider = ({
  projectId,
  location,
  clientEmail,
  privateKey,
}: {
  projectId: string;
  location: string;
  clientEmail: string;
  privateKey: string;
}) => {
  return createVertex({
    project: projectId,
    location,
    googleAuthOptions: {
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
    },
  });
};

/**
 * Creates a provider based on the credentials type.
 * Returns both the provider and the appropriate model ID.
 */
export const createProvider = (credentials: ProviderCredentials) => {
  const selectedModel: ChatModelPreference =
    credentials.chatModel === "opus-4-6" || credentials.chatModel === "sonnet-4-5"
      ? credentials.chatModel
      : DEFAULT_CHAT_MODEL;

  switch (credentials.type) {
    case "anthropic":
      return {
        provider: createAnthropicProvider({ apiKey: credentials.apiKey }),
        modelId: MODEL_IDS[selectedModel].anthropic,
        haikuModelId: HAIKU_MODEL_IDS.anthropic,
      };
    case "bedrock":
      return {
        provider: createBedrockProvider({
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          region: credentials.region,
        }),
        modelId: MODEL_IDS[selectedModel].bedrock,
        haikuModelId: HAIKU_MODEL_IDS.bedrock,
      };
    case "vertex":
      return {
        provider: createVertexProvider({
          projectId: credentials.projectId,
          location: credentials.location,
          clientEmail: credentials.clientEmail,
          privateKey: credentials.privateKey,
        }),
        modelId: MODEL_IDS[selectedModel].vertex,
        haikuModelId: HAIKU_MODEL_IDS.vertex,
      };
  }
};
