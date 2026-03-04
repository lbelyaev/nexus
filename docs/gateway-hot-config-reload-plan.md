# Gateway Hot Config Reload Plan

Status: Proposed  
Last updated: 2026-03-04  
Owner: Gateway

## Goal

Add safe hot config reload for Nexus gateway without breaking in-flight turns or session determinism.

## Non-goals

- No full live rewire of runtime processes.
- No hot swap of auth token, host/port, or storage location.
- No mutation of active session runtime/model binding.

## Reloadability Matrix

Hot-reloadable fields:

- `modelRouting`
- `modelAliases`
- `modelCatalog`
- `sessionSweepIntervalMs`
- `wsPingIntervalMs`
- `wsPongGraceMs`
- Channel route and behavior fields:
  - `channels.<id>.runtimeId`
  - `channels.<id>.model`
  - `channels.<id>.workspaceId`
  - `channels.<id>.typingIndicator`
  - `channels.<id>.streamingMode`
  - `channels.<id>.steeringMode`

Restart-required fields:

- `runtime`
- `runtimes`
- `defaultRuntimeId`
- `auth.token`
- `host`
- `port`
- `dataDir`
- Channel identity/credentials:
  - `channels.<id>.kind`
  - `channels.<id>.botToken`
  - `channels.<id>.applicationId`
  - `channels.<id>.apiBaseUrl`

## Runtime Semantics

- Existing sessions keep their current runtime session and effective model.
- New sessions use the latest reloaded routing/alias/catalog state.
- In-flight prompts are never interrupted by config apply.
- Invalid reload attempts do not change active state.

## Implementation Plan

### Phase 1: Reload Core (Gateway)

1. Add `ConfigRuntimeState` in `packages/gateway/src/start.ts`.
2. Keep mutable references for:
   - normalized runtime registry fields (`modelRouting`, `modelAliases`, `modelCatalog`, `runtimeDefaults`)
   - selected runtime timers (`sessionSweepIntervalMs`, WS ping/pong values)
   - metadata (`configVersion`, `loadedAt`)
3. Route session model/runtime resolution through this state instead of immutable boot snapshot.
4. Add reload trigger using `SIGHUP`.
5. On reload:
   - parse and validate with existing `loadConfig()`
   - diff old/new config
   - classify changes as hot-reloadable or restart-required
   - reject with structured reason if any restart-required field changed
   - atomically apply allowed fields
6. Emit logs:
   - `config_reload_started`
   - `config_reload_succeeded`
   - `config_reload_rejected`
   - `config_reload_failed`

### Phase 2: Channel Route Reload

1. Add route-update support in `@nexus/channels` manager:
   - Option A: new `updateRoutes()` API
   - Option B: controlled manager restart with same adapters
2. Apply only route/behavior changes hot.
3. Reject reload when channel credentials or adapter identity changes.

### Phase 3: Operator Feedback

1. Add runtime-visible config version in gateway status output.
2. Optionally broadcast a `config_reloaded` event for connected clients.
3. Extend docs with operational commands and expected logs.

## Testing Plan

Unit tests:

- Diff/classification logic for hot vs restart-required fields.
- Reload apply is atomic.
- Invalid config keeps prior active state.

Integration tests:

- Start gateway, create session A, reload aliases/catalog, create session B.
- Verify session A behavior is unchanged; session B uses new config.
- Verify `SIGHUP` reload logs and version bump.

Channel tests:

- Route behavior changes apply without dropping adapter connectivity.
- Credential change in channel config is rejected as restart-required.

## Rollout Strategy

1. Ship Phase 1 behind env flag: `NEXUS_ENABLE_CONFIG_RELOAD=true`.
2. Validate in multi-runtime staging profile.
3. Enable by default after one release cycle without regressions.
4. Ship Phase 2 and Phase 3 incrementally.

## Risks and Mitigations

- Risk: Partial apply causes inconsistent routing state.
  - Mitigation: build next state object first, then single reference swap.
- Risk: Session behavior changes mid-flight.
  - Mitigation: only use new config for new sessions; preserve existing bindings.
- Risk: Operator confusion on rejected reloads.
  - Mitigation: structured rejection reasons and restart guidance in logs.

## Acceptance Criteria

1. Reloading `modelAliases` and `modelCatalog` via `SIGHUP` affects new sessions only.
2. Reload rejects runtime topology, auth, and storage changes with explicit reason.
3. No in-flight turn interruption during reload.
4. Test coverage added for classification and integration behavior.
