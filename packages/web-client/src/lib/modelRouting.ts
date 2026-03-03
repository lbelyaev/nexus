export interface ResolvedModel {
  requested: string;
  resolved: string;
}

export const parseModelRoutingString = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  const mappings: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const [model, runtime] = item.split("=").map((value) => value.trim());
    if (model && runtime) {
      mappings[model.toLowerCase()] = runtime;
    }
  }
  return mappings;
};

export const inferRuntimeFromModel = (
  model: string,
  gatewayRouting: Record<string, string>,
  routingEnv: string | undefined = process.env.NEXT_PUBLIC_NEXUS_MODEL_ROUTING,
): string | undefined => {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;

  const fromGateway = gatewayRouting[normalized];
  if (fromGateway) return fromGateway;

  const fromEnv = parseModelRoutingString(routingEnv)[normalized];
  if (fromEnv) return fromEnv;

  if (/(sonnet|opus|haiku|claude)/.test(normalized)) return "claude";
  if (/(gpt|codex|o1|o3|o4|o5)/.test(normalized)) return "codex";
  return undefined;
};

export const resolveModelAlias = (
  inputModel: string,
  localAliases: Record<string, string>,
  gatewayAliases: Record<string, string>,
): ResolvedModel => {
  const requested = inputModel.trim();
  const normalized = requested.toLowerCase();

  const local = localAliases[normalized];
  if (local) {
    return { requested, resolved: local };
  }

  const gateway = gatewayAliases[normalized];
  if (gateway) {
    return { requested, resolved: gateway };
  }

  return { requested, resolved: requested };
};
