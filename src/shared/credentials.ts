/**
 * Shared Credential Types
 *
 * Type definitions for multi-provider authentication.
 * Supports Anthropic API, AWS Bedrock, and Google Vertex AI.
 */

export type ProviderType = "anthropic" | "bedrock" | "vertex";

export type ChatModelPreference = "haiku-4-5" | "sonnet-4-5" | "opus-4-6";

export const DEFAULT_CHAT_MODEL: ChatModelPreference = "sonnet-4-5";

export interface AnthropicCredentials {
  type: "anthropic";
  apiKey: string;
  chatModel?: ChatModelPreference;
}

export interface BedrockCredentials {
  type: "bedrock";
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  chatModel?: ChatModelPreference;
}

export interface VertexCredentials {
  type: "vertex";
  projectId: string;
  location: string;
  clientEmail: string;
  privateKey: string;
  chatModel?: ChatModelPreference;
}

export type ProviderCredentials =
  | AnthropicCredentials
  | BedrockCredentials
  | VertexCredentials;

/**
 * AWS regions that support Bedrock with Claude models.
 */
export const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
] as const;

export type BedrockRegion = (typeof BEDROCK_REGIONS)[number];

/**
 * Google Cloud regions that support Vertex AI with Claude models.
 */
export const VERTEX_LOCATIONS = [
  "us-central1",
  "us-east5",
  "europe-west1",
  "europe-west4",
  "asia-southeast1",
] as const;

export type VertexLocation = (typeof VERTEX_LOCATIONS)[number];

/**
 * Provider display information for UI.
 */
export const PROVIDER_INFO: Record<
  ProviderType,
  { name: string; helpUrl: string }
> = {
  anthropic: {
    name: "Anthropic API",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  bedrock: {
    name: "AWS Bedrock",
    helpUrl:
      "https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html",
  },
  vertex: {
    name: "Google Vertex AI",
    helpUrl:
      "https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude",
  },
};
