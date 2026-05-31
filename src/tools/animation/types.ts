// src/tools/animation/types.ts
// TypeScript result interfaces for the five animation MCP tools (Phase 17).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 01.

// ---------------------------------------------------------------------------
// AnimationListResult (ANIM-01: animation.list)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_animation_assets — satisfies requirement ANIM-01.
 * Returned when the C++ handler queries IAssetRegistry for animation assets.
 */
export interface AnimationListResult {
  /** Array of animation assets found in the project. */
  assets: Array<{
    /** UE long package path, e.g. /Game/Animations/MyAnim */
    asset_path: string;
    /** Short asset name, e.g. MyAnim */
    asset_name: string;
    /** UE class name: AnimBlueprint | AnimMontage | BlendSpace | BlendSpace1D | AnimSequence */
    asset_type: string;
  }>;
  /** Total number of animation assets found. */
  count: number;
}

// ---------------------------------------------------------------------------
// AnimBlueprintInspectResult (ANIM-02: animation.inspectAnimBP)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_anim_blueprint — satisfies requirement ANIM-02.
 * Returned when the C++ handler inspects an Animation Blueprint's state machines.
 */
export interface AnimBlueprintInspectResult {
  /** UE long package path of the Animation Blueprint asset. */
  asset_path: string;
  /** UE long package path to the skeleton asset used by this AnimBP. */
  skeleton: string;
  /** State machines defined in this Animation Blueprint. */
  state_machines: Array<{
    /** Name of the state machine. */
    name: string;
    /** States within this state machine. */
    states: Array<{
      /** State name. */
      name: string;
      /** UE long package path to the animation asset played in this state. */
      animation_asset: string;
    }>;
    /** Transitions between states in this state machine. */
    transitions: Array<{
      /** Name of the source state. */
      source_state: string;
      /** Name of the target state. */
      target_state: string;
      /** Blend duration of this transition in seconds. */
      duration: number;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// MontageInspectResult (ANIM-03: animation.inspectMontage)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_montage — satisfies requirement ANIM-03.
 * Returned when the C++ handler reads montage sections, notifies, and slots.
 */
export interface MontageInspectResult {
  /** UE long package path of the Animation Montage asset. */
  asset_path: string;
  /** Composite sections in this montage. */
  sections: Array<{
    /** Section name. */
    name: string;
    /** UE long package path to the AnimSequence played in this section. */
    linked_sequence: string;
  }>;
  /** AnimNotify events in this montage. */
  notifies: Array<{
    /** Notify name. */
    name: string;
    /** Time in seconds at which this notify fires. */
    trigger_time: number;
  }>;
  /** Slot names assigned to tracks in this montage. */
  slots: string[];
}

// ---------------------------------------------------------------------------
// BlendSpaceInspectResult (ANIM-04: animation.inspectBlendSpace)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_blend_space — satisfies requirement ANIM-04.
 * Returned when the C++ handler reads blend space axes, samples, and grid config.
 */
export interface BlendSpaceInspectResult {
  /** UE long package path of the BlendSpace or BlendSpace1D asset. */
  asset_path: string;
  /** True when this is a BlendSpace1D (single axis); false for standard 2D BlendSpace. */
  is_1d: boolean;
  /** Blend axes definitions (one for 1D, two for 2D blend spaces). */
  axes: Array<{
    /** Axis display name. */
    name: string;
    /** Minimum value of this axis. */
    min: number;
    /** Maximum value of this axis. */
    max: number;
    /** Number of grid divisions along this axis. */
    grid_divisions: number;
  }>;
  /** Sample points defined in this blend space. */
  samples: Array<{
    /** UE long package path to the animation played at this sample point. */
    animation: string;
    /** X-axis coordinate of this sample. */
    x: number;
    /** Y-axis coordinate of this sample (0 for BlendSpace1D). */
    y: number;
    /** Z-axis coordinate (reserved, always 0). */
    z: number;
  }>;
}

// ---------------------------------------------------------------------------
// RetargetMappingsResult (ANIM-05: animation.retargetMappings)
// ---------------------------------------------------------------------------

/**
 * Result of ue_read_retarget_mappings — satisfies requirement ANIM-05.
 * Returned when the C++ handler reads an IK Retargeter asset's chain mappings.
 */
export interface RetargetMappingsResult {
  /** UE long package path of the IK Retargeter asset. */
  asset_path: string;
  /** UE long package path to the source IK Rig asset. */
  source_rig: string;
  /** UE long package path to the target IK Rig asset. */
  target_rig: string;
  /** Chain-to-chain mappings defined in this retargeter. */
  chain_mappings: Array<{
    /** Name of the source chain in the source rig. */
    source_chain: string;
    /** Name of the target chain in the target rig. */
    target_chain: string;
  }>;
}
