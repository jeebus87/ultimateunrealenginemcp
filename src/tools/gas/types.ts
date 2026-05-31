// src/tools/gas/types.ts
// TypeScript result interfaces for the four Gameplay Ability System MCP tools (Phase 25).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 25-01.
// Requirements covered: GAS-01, GAS-02, GAS-03, GAS-04.

// ---------------------------------------------------------------------------
// AbilityListResult (GAS-01: gas.abilities)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_abilities — satisfies requirement GAS-01.
 * Returned when the C++ handler lists all Gameplay Ability classes with tags,
 * costs, cooldowns, and instancing configuration via gas.abilities command.
 */
export interface AbilityListResult {
  /** All discovered Gameplay Ability classes in the project. */
  abilities: Array<{
    /** UE class name of the ability (e.g. GA_MeleeAttack). */
    class_name: string;
    /** UE long package path to the ability asset. */
    asset_path: string;
    /** Gameplay tags that identify this ability (AbilityTags container). */
    ability_tags: string[];
    /** Tags that cancel this ability when another ability with any of these tags activates. */
    cancel_abilities_with_tag: string[];
    /** Tags that block other abilities while this ability is active. */
    block_abilities_with_tag: string[];
    /** UE class name of the cost Gameplay Effect, or empty string if none. */
    cost_gameplay_effect_class: string;
    /** UE class name of the cooldown Gameplay Effect, or empty string if none. */
    cooldown_gameplay_effect_class: string;
    /** How multiple instances of this ability are managed (e.g. NonInstanced | InstancedPerActor | InstancedPerExecution). */
    instancing_policy: string;
  }>;
}

// ---------------------------------------------------------------------------
// GameplayEffectInspectResult (GAS-02: gas.effects)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_gameplay_effect — satisfies requirement GAS-02.
 * Returned when the C++ handler inspects a Gameplay Effect asset's modifiers,
 * duration policy, stacking rules, and period via gas.effects command.
 */
export interface GameplayEffectInspectResult {
  /** UE long package path to the Gameplay Effect asset. */
  asset_path: string;
  /** How long the effect lasts: Instant | HasDuration | Infinite. */
  duration_policy: string;
  /** All attribute modifiers defined on this Gameplay Effect. */
  modifiers: Array<{
    /** Full attribute reference including set and property (e.g. HealthSet.Health). */
    attribute: string;
    /** UE class name of the Attribute Set that owns this attribute. */
    attribute_set: string;
    /** Modification operation: Additive | Multiplicative | Division | Override | etc. */
    modifier_op: string;
    /** Magnitude as a numeric string, or "Calculated" for curve-based, or "Custom" for custom calculation. */
    magnitude_value: string;
  }>;
  /** How stacking is aggregated: None | AggregateBySource | AggregateByTarget. */
  stacking_type: string;
  /** Maximum number of stacks allowed (0 means no limit when stacking is None). */
  stack_limit_count: number;
  /** Interval in seconds at which the effect is applied periodically (0.0 for non-periodic effects). */
  period_interval: number;
  /** Gameplay Cue tags triggered by this effect. */
  gameplay_cue_tags: string[];
}

// ---------------------------------------------------------------------------
// AttributeSetReadResult (GAS-03: gas.attributes)
// ---------------------------------------------------------------------------

/**
 * Result of ue_read_attribute_set — satisfies requirement GAS-03.
 * Returned when the C++ handler reads an Attribute Set class's attributes
 * with base values, replication status, and clamping info via gas.attributes command.
 */
export interface AttributeSetReadResult {
  /** UE class name of the Attribute Set (e.g. UHealthAttributeSet). */
  class_name: string;
  /** All UPROPERTY attributes defined in this Attribute Set. */
  attributes: Array<{
    /** Property name of the attribute (e.g. Health, MaxHealth, Stamina). */
    attribute_name: string;
    /** Default base value of the attribute as defined in the CDO. */
    base_value: number;
    /** Whether this attribute is replicated to clients. */
    is_replicated: boolean;
    /** Whether this attribute has min/max clamping configured via PreAttributeChange or GetLifetimeReplicatedProps. */
    has_clamping: boolean;
    /** Human-readable description of the clamping rule, or empty string if no clamping. */
    clamp_note: string;
  }>;
}

// ---------------------------------------------------------------------------
// GameplayTagQueryResult (GAS-04: gas.tags)
// ---------------------------------------------------------------------------

/**
 * Result of ue_query_gameplay_tags — satisfies requirement GAS-04.
 * Returned when the C++ handler queries the Gameplay Tag hierarchy and
 * optionally finds assets that reference a specific tag via gas.tags command.
 */
export interface GameplayTagQueryResult {
  /** Full tag paths matching the requested filter (e.g. ["Ability.Melee.Slash", "Ability.Melee.Kick"]). */
  tags: string[];
  /**
   * Assets that reference the queried tag — present only when find_assets_with_tag was requested.
   * Omitted entirely when no reverse asset lookup was requested.
   */
  tagged_assets?: Array<{
    /** UE long package path to the asset. */
    asset_path: string;
    /** UE class name of the asset (e.g. GameplayAbility_BP, GameplayEffect). */
    asset_class: string;
  }>;
  /** True if results were truncated due to a maximum result count limit. */
  capped?: boolean;
}
