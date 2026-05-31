// src/tools/ai-systems/types.ts
// TypeScript result interfaces for the five AI system MCP tools (Phase 22).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 22-01.

// ---------------------------------------------------------------------------
// BehaviorTreeNode (recursive node type used by BehaviorTreeInspectResult)
// ---------------------------------------------------------------------------

/**
 * A single node in a Behavior Tree hierarchy.
 * Recursive: composite nodes contain children, decorators, and services.
 */
export interface BehaviorTreeNode {
  /** Display name of this node. */
  node_name: string;
  /** UE class name of this node, e.g. BTTask_BlueprintBase or BTComposite_Selector. */
  node_class: string;
  /** Node category within the BT hierarchy. */
  node_type: 'Composite' | 'Task' | 'Decorator' | 'Service';
  /** Decorator nodes attached to this node (present for Composite and Task nodes). */
  decorators?: BehaviorTreeNode[];
  /** Service nodes attached to this composite node (present for Composite nodes only). */
  services?: BehaviorTreeNode[];
  /** Child nodes of this composite node (present for Composite nodes only). */
  children?: BehaviorTreeNode[];
}

// ---------------------------------------------------------------------------
// BehaviorTreeInspectResult (AI-01: ai.behaviorTree)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_behavior_tree — satisfies requirement AI-01.
 * Returned when the C++ handler inspects a Behavior Tree asset's node hierarchy,
 * decorators, and services via ai.behaviorTree command.
 */
export interface BehaviorTreeInspectResult {
  /** UE long package path of the Behavior Tree asset. */
  asset_path: string;
  /** Root composite node of the tree, containing the full recursive hierarchy. */
  root_node: BehaviorTreeNode;
}

// ---------------------------------------------------------------------------
// StateTreeInspectResult (AI-02: ai.stateTree)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_state_tree — satisfies requirement AI-02.
 * Returned when the C++ handler reads a State Tree asset's states, transitions,
 * and tasks via ai.stateTree command.
 */
export interface StateTreeInspectResult {
  /** UE long package path of the State Tree asset. */
  asset_path: string;
  /** All states defined in this State Tree. */
  states: Array<{
    /** Display name of this state. */
    name: string;
    /** Type of state (e.g. State, Subtree, Linked). */
    type: string;
    /** Name of the parent state, or empty string if this is a root state. */
    parent_state: string;
    /** Names of tasks bound to this state. */
    tasks: string[];
    /** Outgoing transitions from this state. */
    transitions: Array<{
      /** Name of the target state for this transition. */
      target_state: string;
      /** Human-readable description of the transition condition. */
      condition: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// BlackboardInspectResult (AI-03: ai.blackboard)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_blackboard — satisfies requirement AI-03.
 * Returned when the C++ handler lists all Blackboard keys with types and
 * instance-sync status via ai.blackboard command.
 */
export interface BlackboardInspectResult {
  /** UE long package path of the Blackboard Data asset. */
  asset_path: string;
  /** All keys defined in this Blackboard. */
  keys: Array<{
    /** Display name of the key. */
    key_name: string;
    /** UE type name of the key (e.g. Object, Bool, Float, Int, String, Vector, Rotator, Name, Class, Enum). */
    key_type: string;
    /** Whether this key is instance-synced across all Behavior Tree instances sharing this Blackboard. */
    instance_synced: boolean;
  }>;
  /** UE long package path to the parent Blackboard asset, or empty string if none. */
  parent_asset: string;
}

// ---------------------------------------------------------------------------
// EQSInspectResult (AI-04: ai.eqs)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_eqs — satisfies requirement AI-04.
 * Returned when the C++ handler inspects an Environment Query System template's
 * generators, tests, and scoring configuration via ai.eqs command.
 */
export interface EQSInspectResult {
  /** UE long package path of the EQS query asset. */
  asset_path: string;
  /** Query options, each combining a point generator with a set of tests. */
  options: Array<{
    /** UE class name of the generator (e.g. EnvQueryGenerator_ActorsOfClass). */
    generator_class: string;
    /** Display name assigned to this generator in the EQS editor. */
    generator_name: string;
    /** Tests applied to candidate points produced by the generator. */
    tests: Array<{
      /** UE class name of the test (e.g. EnvQueryTest_Distance). */
      test_class: string;
      /** Purpose of this test: Filter | Score | FilterAndScore. */
      test_purpose: string;
      /** Scoring equation used: Constant | Linear | Square | InverseLinear | SquareRoot | Constant. */
      scoring_equation: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// NavMeshQueryResult (AI-05: ai.navmesh)
// ---------------------------------------------------------------------------

/**
 * Result of ue_query_navmesh — satisfies requirement AI-05.
 * Returned when the C++ handler queries NavMesh build status, bounds, and
 * optional point reachability via ai.navmesh command.
 */
export interface NavMeshQueryResult {
  /** Current build status of the navigation mesh. */
  build_status: 'built' | 'not_built' | 'building';
  /** World-space axis-aligned bounding box encompassing the navigation mesh. */
  bounds: {
    /** Minimum corner of the navigation bounds in world space (centimeters). */
    min: { x: number; y: number; z: number };
    /** Maximum corner of the navigation bounds in world space (centimeters). */
    max: { x: number; y: number; z: number };
  };
  /** UE class name of the navigation data (e.g. RecastNavMesh). */
  nav_data_class: string;
  /** Radius of the nav agent used to generate this mesh (centimeters). */
  agent_radius: number;
  /** Height of the nav agent used to generate this mesh (centimeters). */
  agent_height: number;
  /**
   * Reachability result — present only when both start_point and end_point were supplied.
   * Omitted entirely when no reachability test was requested.
   */
  reachability?: {
    /** Whether a navigable path exists between the two requested points. */
    is_reachable: boolean;
    /** Total path length in centimeters along the navigation mesh. */
    path_length: number;
    /** Path cost as computed by the navigation system. */
    path_cost: number;
  };
}
