// Policy types

export type PolicyAction = "allow" | "deny" | "ask";

export interface PolicyRule {
  tool: string;
  pattern?: string;
  action: PolicyAction;
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

const POLICY_ACTIONS = new Set(["allow", "deny", "ask"]);

export const isPolicyConfig = (value: unknown): value is PolicyConfig => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.rules)) return false;
  return obj.rules.every((rule: unknown) => {
    if (typeof rule !== "object" || rule === null) return false;
    const r = rule as Record<string, unknown>;
    return (
      typeof r.tool === "string" &&
      typeof r.action === "string" &&
      POLICY_ACTIONS.has(r.action) &&
      (r.pattern === undefined || typeof r.pattern === "string")
    );
  });
};
