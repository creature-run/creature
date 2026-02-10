const ALLOWED_NODE_COMMANDS = new Set([
  "node",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "tsx",
  "corepack",
]);

const COREPACK_ALLOWED_RUNNERS = new Set(["npm", "npx", "yarn", "pnpm", "bun", "bunx"]);

const WINDOWS_EXECUTABLE_SUFFIX_RE = /\.(exe|cmd|bat|ps1)$/i;

const SUPPORTED_COMMANDS_TEXT =
  "node, npm, npx, yarn, pnpm, bun, bunx, tsx, corepack";

const COREPACK_USAGE_TEXT =
  "When using corepack, the first argument must be one of: npm, npx, yarn, pnpm, bun, bunx.";

const toStringOrEmpty = (value: unknown): string => {
  return typeof value === "string" ? value : "";
};

export const normalizeExecutableName = (command: string): string => {
  const trimmed = toStringOrEmpty(command).trim();
  if (!trimmed) return "";

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const basename = normalizedSeparators.split("/").pop() || normalizedSeparators;

  return basename.replace(WINDOWS_EXECUTABLE_SUFFIX_RE, "").toLowerCase();
};

export const isAllowedNodeCommand = (command: string): boolean => {
  return ALLOWED_NODE_COMMANDS.has(normalizeExecutableName(command));
};

export const buildNodeCommandPolicyError = ({
  command,
  context,
}: {
  command: string;
  context?: string;
}): string => {
  const prefix = context ? `${context}: ` : "";
  return `${prefix}Unsupported MCP command "${command}". Only Node-based launchers are allowed: ${SUPPORTED_COMMANDS_TEXT}. ${COREPACK_USAGE_TEXT}`;
};

export const splitCommandLine = (input: string): string[] => {
  const result: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;

  for (const char of input.trim()) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
};

export const parseCommandLine = (commandLine: string): { command: string; args: string[] } => {
  const parts = splitCommandLine(commandLine);
  if (parts.length === 0) {
    throw new Error("Command is empty.");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
};

export const validateNodeBasedLaunch = ({
  command,
  args,
  context,
}: {
  command: string;
  args?: string[];
  context?: string;
}): void => {
  const normalizedCommand = normalizeExecutableName(command);
  if (!normalizedCommand || !isAllowedNodeCommand(command)) {
    throw new Error(buildNodeCommandPolicyError({ command, context }));
  }

  if (normalizedCommand !== "corepack") {
    return;
  }

  const firstArgRaw = args?.[0]?.trim() || "";
  const firstArgCommand =
    firstArgRaw && !firstArgRaw.startsWith("@") && firstArgRaw.includes("@")
      ? firstArgRaw.split("@")[0]
      : firstArgRaw;
  const firstArg = firstArgCommand ? normalizeExecutableName(firstArgCommand) : "";
  if (!firstArg || !COREPACK_ALLOWED_RUNNERS.has(firstArg)) {
    throw new Error(buildNodeCommandPolicyError({ command, context }));
  }
};

export const validateCommandLineString = ({
  commandLine,
  context,
}: {
  commandLine: string;
  context?: string;
}): { command: string; args: string[] } => {
  const parsed = parseCommandLine(commandLine);
  validateNodeBasedLaunch({
    command: parsed.command,
    args: parsed.args,
    context,
  });
  return parsed;
};
