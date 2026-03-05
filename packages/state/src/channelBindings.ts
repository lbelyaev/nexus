import type { ChannelBindingRecord } from "@nexus/types";
import type { DatabaseAdapter } from "./database.js";

export interface ChannelBindingStore {
  upsertChannelBinding: (binding: ChannelBindingRecord) => void;
  getChannelBinding: (adapterId: string, conversationId: string) => ChannelBindingRecord | null;
  deleteChannelBinding: (adapterId: string, conversationId: string) => void;
}

interface ChannelBindingRow {
  adapterId: string;
  conversationId: string;
  sessionId: string;
  principalType: ChannelBindingRecord["principalType"];
  principalId: string;
  runtimeId: string | null;
  model: string | null;
  workspaceId: string | null;
  typingIndicator: number;
  streamingMode: ChannelBindingRecord["streamingMode"];
  steeringMode: ChannelBindingRecord["steeringMode"];
  createdAt: string;
  updatedAt: string;
}

const rowToRecord = (row: ChannelBindingRow): ChannelBindingRecord => ({
  adapterId: row.adapterId,
  conversationId: row.conversationId,
  sessionId: row.sessionId,
  principalType: row.principalType,
  principalId: row.principalId,
  ...(row.runtimeId ? { runtimeId: row.runtimeId } : {}),
  ...(row.model ? { model: row.model } : {}),
  ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
  typingIndicator: row.typingIndicator === 1,
  streamingMode: row.streamingMode,
  steeringMode: row.steeringMode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createChannelBindingStore = (
  db: DatabaseAdapter,
): ChannelBindingStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO channel_bindings (
      adapterId,
      conversationId,
      sessionId,
      principalType,
      principalId,
      runtimeId,
      model,
      workspaceId,
      typingIndicator,
      streamingMode,
      steeringMode,
      createdAt,
      updatedAt
    ) VALUES (
      @adapterId,
      @conversationId,
      @sessionId,
      @principalType,
      @principalId,
      @runtimeId,
      @model,
      @workspaceId,
      @typingIndicator,
      @streamingMode,
      @steeringMode,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(adapterId, conversationId) DO UPDATE SET
      sessionId = excluded.sessionId,
      principalType = excluded.principalType,
      principalId = excluded.principalId,
      runtimeId = excluded.runtimeId,
      model = excluded.model,
      workspaceId = excluded.workspaceId,
      typingIndicator = excluded.typingIndicator,
      streamingMode = excluded.streamingMode,
      steeringMode = excluded.steeringMode,
      createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt
  `);
  const getStmt = db.prepare(
    "SELECT * FROM channel_bindings WHERE adapterId = @adapterId AND conversationId = @conversationId",
  );
  const deleteStmt = db.prepare(
    "DELETE FROM channel_bindings WHERE adapterId = @adapterId AND conversationId = @conversationId",
  );

  const upsertChannelBinding = (binding: ChannelBindingRecord): void => {
    upsertStmt.run({
      adapterId: binding.adapterId,
      conversationId: binding.conversationId,
      sessionId: binding.sessionId,
      principalType: binding.principalType,
      principalId: binding.principalId,
      runtimeId: binding.runtimeId ?? null,
      model: binding.model ?? null,
      workspaceId: binding.workspaceId ?? null,
      typingIndicator: binding.typingIndicator ? 1 : 0,
      streamingMode: binding.streamingMode,
      steeringMode: binding.steeringMode,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
  };

  const getChannelBinding = (adapterId: string, conversationId: string): ChannelBindingRecord | null => {
    const row = getStmt.get({
      adapterId,
      conversationId,
    }) as ChannelBindingRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const deleteChannelBinding = (adapterId: string, conversationId: string): void => {
    deleteStmt.run({
      adapterId,
      conversationId,
    });
  };

  return {
    upsertChannelBinding,
    getChannelBinding,
    deleteChannelBinding,
  };
};
