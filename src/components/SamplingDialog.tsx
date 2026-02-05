import { useEffect, useMemo, useState } from "react";
import type {
  CreateMessageRequestParams,
  ModelPreferences,
  SamplingMessageContentBlock,
  Tool,
  ToolChoice,
} from "@modelcontextprotocol/sdk/types.js";
import { Button } from "./Button";
import { Textarea } from "./Textarea";

export type SamplingStage = "request";

export type SamplingRequestEvent = {
  requestId: string;
  stage: SamplingStage;
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

export type SamplingEvent = SamplingRequestEvent;

type SamplingDialogProps = {
  event: SamplingEvent;
  onApprove: (params: {
    requestId: string;
    stage: SamplingStage;
    editedSystemPrompt?: string;
    editedMessages?: CreateMessageRequestParams["messages"];
  }) => void;
  onReject: (params: { requestId: string; stage: SamplingStage }) => void;
};

type EditableSamplingMessage = Omit<CreateMessageRequestParams["messages"][number], "content"> & {
  content: SamplingMessageContentBlock[];
};

export const SamplingDialog = ({ event, onApprove, onReject }: SamplingDialogProps) => {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [messages, setMessages] = useState<EditableSamplingMessage[]>([]);
  const [editableText, setEditableText] = useState("");

  useEffect(() => {
    const req = event as SamplingRequestEvent;
    setSystemPrompt(req.systemPrompt || "");
    const normalized = req.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content) ? message.content : [message.content],
    }));
    setMessages(structuredClone(normalized));
  }, [event]);

  useEffect(() => {
    const { style } = document.body;
    const previousOverflow = style.overflow;
    style.overflow = "hidden";
    return () => {
      style.overflow = previousOverflow;
    };
  }, []);

  const editableSeed = useMemo(() => {
    const req = event as SamplingRequestEvent;
    const textBlocks = req.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
      .filter((block) => block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text")
      .map((block) => (block as { text?: string }).text)
      .filter((text): text is string => typeof text === "string");
    return textBlocks.join("\n\n");
  }, [event]);

  useEffect(() => {
    setEditableText(editableSeed);
  }, [editableSeed]);

  const applyTextToMessages = (value: string) => {
    let applied = false;
    return messages.map((message) => {
      const nextContent = message.content.map((block) => {
        if (!applied && block.type === "text") {
          applied = true;
          return { ...block, text: value };
        }
        return block;
      });
      if (!applied) {
        nextContent.push({ type: "text", text: value });
        applied = true;
      }
      return { ...message, content: nextContent };
    });
  };

  const handleApprove = () => {
    onApprove({
      requestId: event.requestId,
      stage: event.stage,
      editedSystemPrompt: systemPrompt,
      editedMessages: applyTextToMessages(editableText),
    });
  };

  const handleReject = () => {
    onReject({ requestId: event.requestId, stage: event.stage });
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-transparent" />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-x-0 bottom-0 border-t border-border-primary bg-background-primary"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-4">
          <Textarea
            value={editableText}
            onChange={(event) => setEditableText(event.target.value)}
            className="min-h-[120px] text-sm"
            placeholder="Edit the prompt before it runs..."
          />
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={handleReject}>
              Reject
            </Button>
            <Button onClick={handleApprove}>Approve</Button>
          </div>
        </div>
      </div>
    </div>
  );
};
