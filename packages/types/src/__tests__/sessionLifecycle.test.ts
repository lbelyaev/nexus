import { describe, it, expect } from "vitest";
import {
  applySessionLifecycleTransition,
  canAutoResumeSession,
  canOwnerResumeParkedSession,
  canTakeoverParkedSession,
  getSessionLifecycleNextState,
  isSessionLifecycleEventRecord,
  isSessionLifecycleEventType,
  isSessionLifecycleState,
  isSessionParkedReason,
} from "../sessionLifecycle.js";

describe("session lifecycle types", () => {
  it("validates lifecycle states, events, and parked reasons", () => {
    expect(isSessionLifecycleState("live")).toBe(true);
    expect(isSessionLifecycleState("parked")).toBe(true);
    expect(isSessionLifecycleState("closed")).toBe(true);
    expect(isSessionLifecycleState("active")).toBe(false);

    expect(isSessionLifecycleEventType("TRANSFER_REQUESTED")).toBe(true);
    expect(isSessionLifecycleEventType("UNKNOWN")).toBe(false);

    expect(isSessionParkedReason("transfer_pending")).toBe(true);
    expect(isSessionParkedReason("invalid")).toBe(false);
  });

  it("computes next states from transition table", () => {
    expect(getSessionLifecycleNextState("live", "TRANSFER_REQUESTED")).toBe("parked");
    expect(getSessionLifecycleNextState("parked", "TRANSFER_REQUESTED")).toBe("parked");
    expect(getSessionLifecycleNextState("parked", "OWNER_DISCONNECTED")).toBe("parked");
    expect(getSessionLifecycleNextState("parked", "OWNER_RESUMED")).toBe("live");
    expect(getSessionLifecycleNextState("closed", "OWNER_RESUMED")).toBeNull();
  });

  it("applies lifecycle transitions with parked reason defaults", () => {
    expect(applySessionLifecycleTransition("live", "TRANSFER_REQUESTED")).toEqual({
      fromState: "live",
      toState: "parked",
      eventType: "TRANSFER_REQUESTED",
      parkedReason: "transfer_pending",
    });
    expect(applySessionLifecycleTransition("parked", "TRANSFER_EXPIRED")).toEqual({
      fromState: "parked",
      toState: "parked",
      eventType: "TRANSFER_EXPIRED",
      parkedReason: "transfer_expired",
    });
    expect(applySessionLifecycleTransition("parked", "OWNER_RESUMED")).toEqual({
      fromState: "parked",
      toState: "live",
      eventType: "OWNER_RESUMED",
    });
    expect(applySessionLifecycleTransition("closed", "SESSION_CLOSED")).toBeNull();
  });

  it("validates lifecycle event records", () => {
    expect(isSessionLifecycleEventRecord({
      sessionId: "sess-1",
      eventType: "TRANSFER_REQUESTED",
      fromState: "live",
      toState: "parked",
      parkedReason: "transfer_pending",
      actorPrincipalType: "user",
      actorPrincipalId: "user:web:1",
      metadata: "{\"foo\":true}",
      createdAt: "2026-01-01T00:00:00Z",
    })).toBe(true);

    expect(isSessionLifecycleEventRecord({
      sessionId: "sess-1",
      eventType: "TRANSFER_REQUESTED",
      fromState: "live",
      toState: "parked",
      parkedReason: "bad_reason",
      createdAt: "2026-01-01T00:00:00Z",
    })).toBe(false);
  });

  it("applies shared parked-session policy helpers", () => {
    expect(canOwnerResumeParkedSession("owner_disconnected")).toBe(true);
    expect(canOwnerResumeParkedSession("runtime_timeout")).toBe(true);
    expect(canOwnerResumeParkedSession("transfer_pending")).toBe(false);

    expect(canTakeoverParkedSession("manual")).toBe(true);
    expect(canTakeoverParkedSession("transfer_expired")).toBe(true);
    expect(canTakeoverParkedSession("transfer_pending")).toBe(false);

    expect(canAutoResumeSession("live", undefined)).toBe(true);
    expect(canAutoResumeSession("parked", "owner_disconnected")).toBe(true);
    expect(canAutoResumeSession("parked", "transfer_expired")).toBe(true);
    expect(canAutoResumeSession("parked", "transfer_pending")).toBe(false);
    expect(canAutoResumeSession("closed", undefined)).toBe(false);
  });
});
