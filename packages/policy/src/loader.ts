import { isPolicyConfig } from "@nexus/types";
import type { PolicyConfig } from "@nexus/types";

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);
const VALID_PRINCIPAL_TYPES = new Set(["user", "service_account"]);
const VALID_SOURCES = new Set(["interactive", "schedule", "hook", "api"]);

export const validatePolicyConfig = (value: unknown): string[] => {
  const errors: string[] = [];

  if (value === null || value === undefined || typeof value !== "object") {
    errors.push("Policy config must be a non-null object");
    return errors;
  }

  const obj = value as Record<string, unknown>;

  if (!Array.isArray(obj.rules)) {
    errors.push("Policy config must have a 'rules' array");
    return errors;
  }

  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i] as Record<string, unknown>;

    if (typeof rule.tool !== "string") {
      errors.push(`Rule ${i}: missing or invalid 'tool' field`);
    }

    if (typeof rule.action !== "string" || !VALID_ACTIONS.has(rule.action)) {
      errors.push(`Rule ${i}: invalid action '${String(rule.action)}', must be allow|deny|ask`);
    }

    if (
      rule.principalType !== undefined
      && (typeof rule.principalType !== "string" || !VALID_PRINCIPAL_TYPES.has(rule.principalType))
    ) {
      errors.push(`Rule ${i}: invalid principalType '${String(rule.principalType)}', must be user|service_account`);
    }

    if (rule.principalIdPattern !== undefined && typeof rule.principalIdPattern !== "string") {
      errors.push(`Rule ${i}: principalIdPattern must be a string`);
    }

    if (rule.source !== undefined && (typeof rule.source !== "string" || !VALID_SOURCES.has(rule.source))) {
      errors.push(`Rule ${i}: invalid source '${String(rule.source)}', must be interactive|schedule|hook|api`);
    }

    if (rule.workspaceIdPattern !== undefined && typeof rule.workspaceIdPattern !== "string") {
      errors.push(`Rule ${i}: workspaceIdPattern must be a string`);
    }
  }

  return errors;
};

export const loadPolicyFromString = (json: string): PolicyConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON");
  }

  const errors = validatePolicyConfig(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid policy config: ${errors.join("; ")}`);
  }

  if (!isPolicyConfig(parsed)) {
    throw new Error("Policy config failed type validation");
  }

  return parsed;
};
