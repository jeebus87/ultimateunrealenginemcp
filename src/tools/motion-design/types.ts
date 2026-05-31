// src/tools/motion-design/types.ts
// TypeScript result interfaces for the four Motion Design MCP tools (Phase 28).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 28-01.
// Tools: ue_list_scene_states, ue_trigger_scene_transition, ue_inspect_transition_logic,
//        ue_manage_remote_control.

// ---------------------------------------------------------------------------
// SceneStatesResult (MD-01: motiondesign.sceneStates)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_scene_states — satisfies requirement MD-01.
 * Returned when the C++ handler lists Scene State machines with their states and
 * categories via motiondesign.sceneStates command.
 */
export interface SceneStatesResult {
  /** All Scene State machines found in the rundown (or all rundowns if no path supplied). */
  machines: Array<{
    /** Display name of this Scene State machine. */
    machine_name: string;
    /** Name of the currently active state in this machine. */
    current_state: string;
    /** All states defined in this machine. */
    states: Array<{
      /** Display name of this state. */
      name: string;
      /** Category group this state belongs to. */
      category: string;
      /** Whether this state is currently active. */
      is_active: boolean;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// SceneTransitionResult (MD-02: motiondesign.transition)
// ---------------------------------------------------------------------------

/**
 * Result of ue_trigger_scene_transition — satisfies requirement MD-02.
 * Returned when the C++ handler triggers a Scene State transition with optional
 * property overrides via motiondesign.transition command.
 */
export interface SceneTransitionResult {
  /** The state that was transitioned to. */
  new_state: string;
  /** Properties that were applied during the transition. */
  applied_properties: Array<{
    /** Property name that was applied. */
    name: string;
    /** Value that was applied to this property. */
    value: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// TransitionLogicResult (MD-03: motiondesign.transitionLogic)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_transition_logic — satisfies requirement MD-03.
 * Returned when the C++ handler inspects a Transition Logic asset's sequences,
 * in/out labels, and layer changes via motiondesign.transitionLogic command.
 */
export interface TransitionLogicResult {
  /** UE long package path of the Transition Logic asset. */
  asset_path: string;
  /** All transitions defined in this Transition Logic asset. */
  transitions: Array<{
    /** Label of the incoming state for this transition. */
    in_label: string;
    /** Label of the outgoing state for this transition. */
    out_label: string;
    /** UE path to the Level Sequence associated with this transition. */
    level_sequence_path: string;
    /** Layer visibility changes applied during this transition. */
    layer_changes: Array<{
      /** Name of the layer being modified. */
      layer_name: string;
      /** Visibility state applied to this layer (e.g. "Visible" | "Hidden"). */
      visibility: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// RemoteControlResult (MD-04: motiondesign.remoteControl)
// ---------------------------------------------------------------------------

/**
 * Result of ue_manage_remote_control — satisfies requirement MD-04.
 * Returned when the C++ handler reads or modifies Remote Control preset properties,
 * or triggers exposed functions via motiondesign.remoteControl command.
 */
export interface RemoteControlResult {
  /** UE path to the Remote Control preset asset. */
  preset_path: string;
  /** The action that was performed: list | get | set | call. */
  action: string;
  /**
   * All exposed properties in the preset — present when action is "list".
   * Contains property names, types, and their current values.
   */
  properties?: Array<{
    /** Display name of the exposed property. */
    name: string;
    /** UE type name of this property. */
    type: string;
    /** Current value of this property. */
    value: unknown;
  }>;
  /**
   * All exposed functions in the preset — present when action is "list".
   */
  functions?: Array<{
    /** Display name of the exposed function. */
    name: string;
  }>;
  /**
   * The property that was read or written — present when action is "get" or "set".
   */
  property?: {
    /** Display name of the property. */
    name: string;
    /** UE type name of this property. */
    type: string;
    /** Current value of the property (after set, reflects the new value). */
    value: unknown;
  };
  /**
   * The result of a function call — present when action is "call".
   */
  call_result?: {
    /** Name of the function that was called. */
    function_name: string;
    /** Whether the function call succeeded. */
    success: boolean;
    /** Return value from the function, if any. */
    result?: unknown;
  };
}
