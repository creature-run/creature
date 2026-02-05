import { loadEmbeddingsCredentials } from "./credentialsStore";

const DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MAX_TEXT_LENGTH = 20000;

export const embedText = async (text: string): Promise<{ embedding: Float32Array; model: string }> => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Text cannot be empty");
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text exceeds maximum length of ${MAX_TEXT_LENGTH}`);
  }

  const credentials = await loadEmbeddingsCredentials();
  if (!credentials || credentials.type !== "openai" || !credentials.apiKey) {
    throw new Error("OpenAI embeddings not configured. Add key in Settings > Embeddings.");
  }

  const model = credentials.model?.trim() || DEFAULT_MODEL;

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: trimmed,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || `OpenAI error: ${response.status}`;
    throw new Error(message);
  }

  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embeddings response is missing embedding data");
  }

  return { embedding: Float32Array.from(embedding), model };
};
