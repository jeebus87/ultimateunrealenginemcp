// tests/gas-tools.test.ts
// Integration tests for Phase 25 Gameplay Ability System MCP tools (GAS-01 through GAS-04).
// Uses injected mock PluginBridgeClient — no TCP server needed; handlers accept an
// injected bridge parameter via registerGASTools.
//
// Port assignments (project-wide reference):
//   55557 — real UE Editor plugin (not running in tests)
//   55560 — plugin-bridge.test.ts mock server
//   55561 — blueprint-tools.test.ts mock server
//   55562 — bridge-cpp-tools.test.ts mock server
//   55563 — blueprint-write-tools.test.ts mock server
//   55564 — validation-tools.test.ts mock server
//   55565 — animation-tools.test.ts mock server
//   55566 — collision-physics-tools.test.ts (reserved)
//   55573 — gas-tools.test.ts (this file, Phase 25 GAS-01 through GAS-04)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../src/plugin-bridge/client.js';
import {
  registerGASTools,
  handleListAbilities,
  handleInspectGameplayEffect,
  handleReadAttributeSet,
  handleQueryGameplayTags,
} from '../src/tools/gas/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ToolResultContent = Array<{ type: string; text: string }>;
type ToolResultShape = { content: ToolResultContent; isError?: boolean };

/**
 * Create a minimal mock PluginBridgeClient for testing.
 * sendCommand resolves with success response by default.
 * Pass throwDisconnect:true to simulate a disconnected plugin.
 */
function makeMockBridge(opts: {
  connected?: boolean;
  responseData?: unknown;
  responseSuccess?: boolean;
  responseError?: string;
  throwDisconnect?: boolean;
}): PluginBridgeClient {
  const disconnectedError = {
    error: 'plugin_not_connected' as const,
    message: 'Test: plugin not connected',
    required_plugin: true as const,
  };

  const sendCommandImpl = opts.throwDisconnect
    ? vi.fn().mockRejectedValue(new PluginNotConnectedError(disconnectedError))
    : vi.fn().mockResolvedValue({
        success: opts.responseSuccess ?? true,
        correlationId: 'test-corr-id',
        data: opts.responseData,
        error: opts.responseError,
      });

  return {
    isConnected: vi.fn().mockReturnValue(opts.connected ?? true),
    getDisconnectedError: vi.fn().mockReturnValue(disconnectedError),
    sendCommand: sendCommandImpl,
    destroy: vi.fn(),
  } as unknown as PluginBridgeClient;
}

/**
 * Builds a stub McpServer that captures registered handlers by tool name.
 * Allows calling handlers directly without a real McpServer.
 */
function makeStubServer(): {
  server: McpServer;
  handlers: Map<string, (args: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const stubServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<unknown>
    ) => {
      handlers.set(_name, handler);
    },
  } as unknown as McpServer;
  return { server: stubServer, handlers };
}

// ---------------------------------------------------------------------------
// Realistic mock response data (per plan specification)
// ---------------------------------------------------------------------------

const ABILITY_LIST_DATA = {
  abilities: [
    {
      class_name: 'GA_MeleeAttack',
      asset_path: '/Game/Abilities/GA_MeleeAttack',
      ability_tags: ['Ability.Melee', 'Ability.Attack'],
      cancel_abilities_with_tag: ['Ability.Movement'],
      block_abilities_with_tag: ['Ability.Dash'],
      cost_gameplay_effect_class: 'GE_ManaCost',
      cooldown_gameplay_effect_class: 'GE_MeleeCooldown',
      instancing_policy: 'InstancedPerActor',
    },
    {
      class_name: 'GA_FireBall',
      asset_path: '/Game/Abilities/GA_FireBall',
      ability_tags: ['Ability.Ranged', 'Ability.Fire'],
      cancel_abilities_with_tag: [],
      block_abilities_with_tag: [],
      cost_gameplay_effect_class: 'GE_ManaCost',
      cooldown_gameplay_effect_class: 'None',
      instancing_policy: 'NonInstanced',
    },
  ],
};

const GAMEPLAY_EFFECT_DATA = {
  asset_path: '/Game/Effects/GE_DamageOverTime',
  duration_policy: 'HasDuration',
  modifiers: [
    {
      attribute: 'Health',
      attribute_set: 'UBaseAttributeSet',
      modifier_op: 'Additive',
      magnitude_value: '-5.0',
    },
    {
      attribute: 'Shield',
      attribute_set: 'UBaseAttributeSet',
      modifier_op: 'Override',
      magnitude_value: '0.0',
    },
  ],
  stacking_type: 'AggregateBySource',
  stack_limit_count: 3,
  period_interval: 1.0,
  gameplay_cue_tags: ['GameplayCue.Effect.Burning'],
};

const ATTRIBUTE_SET_DATA = {
  class_name: 'UBaseAttributeSet',
  attributes: [
    { attribute_name: 'Health', base_value: 100.0, is_replicated: true, has_clamping: true, clamp_note: 'check_implementation' },
    { attribute_name: 'MaxHealth', base_value: 100.0, is_replicated: true, has_clamping: false, clamp_note: '' },
    { attribute_name: 'Mana', base_value: 50.0, is_replicated: true, has_clamping: true, clamp_note: 'check_implementation' },
    { attribute_name: 'AttackPower', base_value: 10.0, is_replicated: false, has_clamping: false, clamp_note: '' },
  ],
};

const GAMEPLAY_TAG_DATA = {
  tags: ['Ability', 'Ability.Melee', 'Ability.Melee.Slash', 'Ability.Ranged', 'Ability.Ranged.Fire'],
  tagged_assets: [
    { asset_path: '/Game/Abilities/GA_MeleeAttack', asset_class: 'Blueprint' },
    { asset_path: '/Game/Effects/GE_MeleeCooldown', asset_class: 'Blueprint' },
  ],
  capped: false,
};

// ---------------------------------------------------------------------------
// describe('GAS tools')
// ---------------------------------------------------------------------------

describe('GAS tools', () => {

  // -------------------------------------------------------------------------
  // ue_list_abilities (GAS-01)
  // -------------------------------------------------------------------------
  describe('ue_list_abilities', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: ABILITY_LIST_DATA });
    });

    it('success: returns ability list matching ABILITY_LIST_DATA', async () => {
      const result = await handleListAbilities({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.abilities)).toBe(true);
      expect(parsed.abilities).toHaveLength(2);
      expect(parsed.abilities[0].class_name).toBe('GA_MeleeAttack');
      expect(parsed.abilities[0].asset_path).toBe('/Game/Abilities/GA_MeleeAttack');
      expect(parsed.abilities[0].ability_tags).toEqual(['Ability.Melee', 'Ability.Attack']);
      expect(parsed.abilities[1].class_name).toBe('GA_FireBall');
      expect(parsed.abilities[1].instancing_policy).toBe('NonInstanced');
    });

    it('success: sends gas.abilities command type to bridge', async () => {
      await handleListAbilities({}, mockBridge);
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'gas.abilities' })
      );
    });

    it('success: passes class_filter in payload when provided', async () => {
      await handleListAbilities({ class_filter: 'Melee' }, mockBridge);
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.abilities',
          payload: expect.objectContaining({ class_filter: 'Melee' }),
        })
      );
    });

    it('success: sends empty payload when no class_filter provided', async () => {
      await handleListAbilities({}, mockBridge);
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('class_filter');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const result = await handleListAbilities({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('error: bridge reports failure -> returns isError:true with error string', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'ability_scan_failed',
      });
      const result = await handleListAbilities({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('ability_scan_failed');
    });

    it('success: handles empty abilities array gracefully', async () => {
      mockBridge = makeMockBridge({ responseData: { abilities: [] } });
      const result = await handleListAbilities({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.abilities)).toBe(true);
      expect(parsed.abilities).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ue_inspect_gameplay_effect (GAS-02)
  // -------------------------------------------------------------------------
  describe('ue_inspect_gameplay_effect', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: GAMEPLAY_EFFECT_DATA });
    });

    it('success: returns effect data matching GAMEPLAY_EFFECT_DATA', async () => {
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.asset_path).toBe('/Game/Effects/GE_DamageOverTime');
      expect(parsed.duration_policy).toBe('HasDuration');
      expect(Array.isArray(parsed.modifiers)).toBe(true);
      expect(parsed.modifiers).toHaveLength(2);
      expect(parsed.stacking_type).toBe('AggregateBySource');
      expect(parsed.stack_limit_count).toBe(3);
      expect(parsed.period_interval).toBe(1.0);
    });

    it('success: sends gas.effects command type with asset_path in payload', async () => {
      await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      );
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.effects',
          payload: expect.objectContaining({ asset_path: '/Game/Effects/GE_DamageOverTime' }),
        })
      );
    });

    it('success: returns all modifier fields including attribute_set and magnitude_value', async () => {
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      ) as ToolResultShape;
      const parsed = JSON.parse(result.content[0].text);
      const modifier = parsed.modifiers[0];
      expect(modifier.attribute).toBe('Health');
      expect(modifier.attribute_set).toBe('UBaseAttributeSet');
      expect(modifier.modifier_op).toBe('Additive');
      expect(modifier.magnitude_value).toBe('-5.0');
    });

    it('success: returns stacking and period info', async () => {
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      ) as ToolResultShape;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.stacking_type).toBe('AggregateBySource');
      expect(parsed.stack_limit_count).toBe(3);
      expect(parsed.period_interval).toBe(1.0);
      expect(parsed.gameplay_cue_tags).toEqual(['GameplayCue.Effect.Burning']);
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('error: bridge reports missing asset -> returns isError:true with error', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'asset_not_found',
      });
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_Missing' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('asset_not_found');
    });

    it('success: handles effect with zero modifiers', async () => {
      mockBridge = makeMockBridge({
        responseData: { ...GAMEPLAY_EFFECT_DATA, modifiers: [] },
      });
      const result = await handleInspectGameplayEffect(
        { asset_path: '/Game/Effects/GE_DamageOverTime' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.modifiers)).toBe(true);
      expect(parsed.modifiers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ue_read_attribute_set (GAS-03)
  // -------------------------------------------------------------------------
  describe('ue_read_attribute_set', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: ATTRIBUTE_SET_DATA });
    });

    it('success: returns attribute set data matching ATTRIBUTE_SET_DATA', async () => {
      const result = await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_BaseCharacter' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.class_name).toBe('UBaseAttributeSet');
      expect(Array.isArray(parsed.attributes)).toBe(true);
      expect(parsed.attributes).toHaveLength(4);
      expect(parsed.attributes[0].attribute_name).toBe('Health');
    });

    it('success: sends gas.attributes command type with asset_path in payload', async () => {
      await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_BaseCharacter' },
        mockBridge
      );
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.attributes',
          payload: expect.objectContaining({ asset_path: '/Game/GAS/AS_BaseCharacter' }),
        })
      );
    });

    it('success: returns base_value as number for each attribute', async () => {
      const result = await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_BaseCharacter' },
        mockBridge
      ) as ToolResultShape;
      const parsed = JSON.parse(result.content[0].text);
      for (const attr of parsed.attributes) {
        expect(typeof attr.base_value).toBe('number');
      }
      expect(parsed.attributes[0].base_value).toBe(100.0);
      expect(parsed.attributes[2].base_value).toBe(50.0);
      expect(parsed.attributes[3].base_value).toBe(10.0);
    });

    it('success: returns replication and clamping flags', async () => {
      const result = await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_BaseCharacter' },
        mockBridge
      ) as ToolResultShape;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.attributes[0].is_replicated).toBe(true);
      expect(parsed.attributes[0].has_clamping).toBe(true);
      expect(parsed.attributes[0].clamp_note).toBe('check_implementation');
      expect(parsed.attributes[3].is_replicated).toBe(false);
      expect(parsed.attributes[3].has_clamping).toBe(false);
      expect(parsed.attributes[3].clamp_note).toBe('');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const result = await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_BaseCharacter' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('error: bridge reports invalid asset path -> returns isError:true with error', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'invalid_asset_path',
      });
      const result = await handleReadAttributeSet(
        { asset_path: '/Invalid/Path' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('invalid_asset_path');
    });

    it('success: handles attribute set with no attributes', async () => {
      mockBridge = makeMockBridge({
        responseData: { class_name: 'UEmptySet', attributes: [] },
      });
      const result = await handleReadAttributeSet(
        { asset_path: '/Game/GAS/AS_Empty' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.class_name).toBe('UEmptySet');
      expect(Array.isArray(parsed.attributes)).toBe(true);
      expect(parsed.attributes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ue_query_gameplay_tags (GAS-04)
  // -------------------------------------------------------------------------
  describe('ue_query_gameplay_tags', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: GAMEPLAY_TAG_DATA });
    });

    it('success: returns tag hierarchy matching GAMEPLAY_TAG_DATA', async () => {
      const result = await handleQueryGameplayTags({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.tags)).toBe(true);
      expect(parsed.tags).toHaveLength(5);
      expect(parsed.tags).toContain('Ability.Melee.Slash');
      expect(parsed.capped).toBe(false);
    });

    it('success: sends gas.tags command type with tag_filter in payload', async () => {
      await handleQueryGameplayTags({ tag_filter: 'Ability.Melee' }, mockBridge);
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.tags',
          payload: expect.objectContaining({ tag_filter: 'Ability.Melee' }),
        })
      );
    });

    it('success: sends empty tag_filter for full hierarchy query', async () => {
      await handleQueryGameplayTags({}, mockBridge);
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.tags',
          payload: expect.objectContaining({ tag_filter: '' }),
        })
      );
    });

    it('success: includes find_assets_with_tag in payload when provided', async () => {
      await handleQueryGameplayTags(
        { find_assets_with_tag: 'Ability.Melee' },
        mockBridge
      );
      expect(mockBridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gas.tags',
          payload: expect.objectContaining({ find_assets_with_tag: 'Ability.Melee' }),
        })
      );
    });

    it('success: omits find_assets_with_tag from payload when not provided', async () => {
      await handleQueryGameplayTags({}, mockBridge);
      const call = (mockBridge.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.payload).not.toHaveProperty('find_assets_with_tag');
    });

    it('error: plugin not connected -> returns plugin_not_connected error', async () => {
      mockBridge = makeMockBridge({ throwDisconnect: true });
      const result = await handleQueryGameplayTags({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('plugin_not_connected');
      expect(parsed.required_plugin).toBe(true);
    });

    it('error: bridge reports tag query failure -> returns isError:true with error', async () => {
      mockBridge = makeMockBridge({
        responseSuccess: false,
        responseError: 'tag_query_failed',
      });
      const result = await handleQueryGameplayTags(
        { tag_filter: 'Ability.Melee' },
        mockBridge
      ) as ToolResultShape;
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('tag_query_failed');
    });

    it('success: handles capped results (capped: true)', async () => {
      mockBridge = makeMockBridge({
        responseData: { ...GAMEPLAY_TAG_DATA, capped: true },
      });
      const result = await handleQueryGameplayTags({}, mockBridge) as ToolResultShape;
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.capped).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool registration
  // -------------------------------------------------------------------------
  describe('registerGASTools', () => {
    let mockBridge: PluginBridgeClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockBridge = makeMockBridge({ responseData: ABILITY_LIST_DATA });
    });

    it('registers all four GAS tools on the server', () => {
      const { server, handlers } = makeStubServer();
      registerGASTools(server, mockBridge);
      expect(handlers.has('ue_list_abilities')).toBe(true);
      expect(handlers.has('ue_inspect_gameplay_effect')).toBe(true);
      expect(handlers.has('ue_read_attribute_set')).toBe(true);
      expect(handlers.has('ue_query_gameplay_tags')).toBe(true);
    });

    it('registered ue_list_abilities handler is callable and returns a result', async () => {
      const { server, handlers } = makeStubServer();
      registerGASTools(server, mockBridge);
      const handler = handlers.get('ue_list_abilities')!;
      const result = await handler({}) as ToolResultShape;
      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.abilities)).toBe(true);
    });
  });

});
