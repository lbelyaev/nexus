export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

const isMergeableRole = (role: ChatRole): boolean => role === "assistant" || role === "system";

export const mergeContiguousMessages = (
  previous: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  if (incoming.length === 0) return previous;

  const result = [...previous];

  for (const message of incoming) {
    const last = result[result.length - 1];
    if (last && last.role === message.role && isMergeableRole(message.role)) {
      result[result.length - 1] = {
        ...last,
        text: `${last.text}\n${message.text}`,
      };
      continue;
    }

    result.push(message);
  }

  return result;
};
