import type { PrincipalType, PromptSource } from "@nexus/types";

export interface LoggerLike {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ChannelInboundMessage {
  adapterId: string;
  conversationId: string;
  senderId: string;
  senderDisplayName?: string;
  text: string;
}

export interface ChannelOutboundMessage {
  conversationId: string;
  text: string;
}

export type ChannelStreamingMode = "off" | "edit";

export interface ChannelTypingState {
  conversationId: string;
  active: boolean;
}

export interface ChannelStreamingState {
  conversationId: string;
  streamId: string;
  text: string;
  done?: boolean;
}

export interface ChannelAdapterContext {
  onMessage: (message: ChannelInboundMessage) => Promise<void>;
  log: LoggerLike;
}

export interface ChannelAdapter {
  id: string;
  start: (context: ChannelAdapterContext) => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (message: ChannelOutboundMessage) => Promise<void>;
  setTyping?: (state: ChannelTypingState) => Promise<void>;
  upsertStreamingMessage?: (state: ChannelStreamingState) => Promise<void>;
}

export interface ChannelRouteConfig {
  runtimeId?: string;
  model?: string;
  workspaceId?: string;
  principalType?: PrincipalType;
  source?: PromptSource;
  typingIndicator?: boolean;
  streamingMode?: ChannelStreamingMode;
}

export interface ChannelAdapterRegistration {
  adapter: ChannelAdapter;
  route?: ChannelRouteConfig;
}
