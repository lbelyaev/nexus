import type { PolicyConfig, PolicyAction } from "@nexus/types";

export const evaluatePolicy = (
  config: PolicyConfig,
  tool: string,
  params?: string,
): PolicyAction => {
  for (const rule of config.rules) {
    const toolMatches = rule.tool === "*" || rule.tool === tool;
    if (!toolMatches) continue;

    if (rule.pattern !== undefined) {
      if (params === undefined || !params.includes(rule.pattern)) continue;
    }

    return rule.action;
  }

  return "ask";
};
