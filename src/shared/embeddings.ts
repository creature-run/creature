export type EmbeddingsProviderType = "openai";

export interface OpenAiEmbeddingsCredentials {
  type: "openai";
  apiKey: string;
  model?: string;
}

export type EmbeddingsCredentials = OpenAiEmbeddingsCredentials;
