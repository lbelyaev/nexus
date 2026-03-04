import type {
  PolicyConfig,
  PolicyAction,
  PrincipalType,
  PromptSource,
} from "@nexus/types";

export interface PolicyEvaluationContext {
  principalType?: PrincipalType;
  principalId?: string;
  source?: PromptSource;
  workspaceId?: string;
}

export const evaluatePolicy = (
  config: PolicyConfig,
  tool: string,
  params?: string,
  context?: PolicyEvaluationContext,
): PolicyAction => {
  for (const rule of config.rules) {
    const toolMatches = rule.tool === "*" || rule.tool === tool;
    if (!toolMatches) continue;

    if (rule.principalType !== undefined && context?.principalType !== rule.principalType) continue;
    if (rule.source !== undefined && context?.source !== rule.source) continue;
    if (rule.principalIdPattern !== undefined) {
      if (context?.principalId === undefined || !context.principalId.includes(rule.principalIdPattern)) continue;
    }
    if (rule.workspaceIdPattern !== undefined) {
      if (context?.workspaceId === undefined || !context.workspaceId.includes(rule.workspaceIdPattern)) continue;
    }

    if (rule.pattern !== undefined) {
      if (params === undefined || !params.includes(rule.pattern)) continue;
    }

    return rule.action;
  }

  return "ask";
};
