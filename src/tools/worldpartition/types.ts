// src/tools/worldpartition/types.ts
// TypeScript result interfaces for the four World Partition MCP tools (Phase 18).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 01.

// ---------------------------------------------------------------------------
// WorldPartitionSettingsResult (WP-01: worldpartition.settings)
// ---------------------------------------------------------------------------

/**
 * Result of ue_read_world_partition — satisfies requirement WP-01.
 * Returned when the C++ handler reads World Partition configuration from the open world.
 */
export interface WorldPartitionSettingsResult {
  /** Cell size in UE units (typically Unreal units, e.g. 12800). */
  grid_size: number;
  /** Loading range in UE units — how far from streaming sources cells are loaded. */
  loading_range: number;
  /** Whether runtime streaming is enabled for this world. */
  enable_streaming: boolean;
  /** Name of the runtime spatial hash used for cell lookup. */
  runtime_hash_name: string;
}

// ---------------------------------------------------------------------------
// DataLayersResult (WP-02: worldpartition.dataLayers)
// ---------------------------------------------------------------------------

/**
 * Shared data layer info sub-interface — used across WP-02 response shapes.
 */
export interface DataLayerInfo {
  /** Data layer asset name. */
  name: string;
  /** Layer type: "Runtime" (visible in packaged game) or "Editor" (editor-only). */
  type: string;
  /** Initial runtime state: "Unloaded" | "Loaded" | "Activated". */
  initial_runtime_state: string;
  /** Whether the layer is initially visible in the editor viewport. */
  is_initially_visible: boolean;
}

/**
 * Result for action="list" — satisfies requirement WP-02 list variant.
 * Returned when listing all data layers in the world.
 */
export interface DataLayersListResult {
  /** Array of data layers defined in this World Partition world. */
  layers: Array<DataLayerInfo>;
  /** Total number of data layers found. */
  count: number;
}

/**
 * Result for action="create" or action="toggle" — satisfies requirement WP-02 single variant.
 * Returned after creating a new data layer or toggling its runtime state.
 */
export interface DataLayerSingleResult {
  /** The data layer that was created or modified. */
  layer: DataLayerInfo;
}

/**
 * Result for action="assign_actor" — satisfies requirement WP-02 assign variant.
 * Returned after assigning an actor to a data layer.
 */
export interface DataLayerAssignResult {
  /** Label of the actor that was assigned. */
  actor_label: string;
  /** Name of the data layer the actor was assigned to. */
  layer_name: string;
  /** Whether the assignment succeeded. */
  success: boolean;
}

/**
 * Union result type for ue_manage_data_layers — satisfies requirement WP-02.
 * The shape depends on the action parameter used in the tool call.
 */
export type DataLayersResult = DataLayersListResult | DataLayerSingleResult | DataLayerAssignResult;

// ---------------------------------------------------------------------------
// StreamingSourcesResult (WP-03: worldpartition.streamingSources)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_streaming_sources — satisfies requirement WP-03.
 * Returned when the C++ handler reads streaming source components from actors in the world.
 */
export interface StreamingSourcesResult {
  /** Array of streaming source components found in the world. */
  streaming_sources: Array<{
    /** Label of the actor hosting this streaming source component. */
    actor_label: string;
    /** Name of the streaming source component. */
    component_name: string;
    /** Target streaming state: e.g. "Loaded" | "Activated". */
    target_state: string;
    /** Shape names used for this streaming source's influence volume. */
    shapes: string[];
    /** Load priority — higher values load sooner. */
    priority: number;
  }>;
  /** Total number of streaming source components found. */
  count: number;
}

// ---------------------------------------------------------------------------
// HlodResult (WP-04: worldpartition.hlod)
// ---------------------------------------------------------------------------

/**
 * Result for action="inspect" — satisfies requirement WP-04 inspect variant.
 * Returned when the C++ handler reads HLOD layer configuration from the world.
 */
export interface HlodInspectResult {
  /** HLOD layers defined for this world. */
  hlod_layers: Array<{
    /** Name of the HLOD layer asset. */
    layer_name: string;
    /** Cell size in UE units for cells covered by this HLOD layer. */
    cell_size: number;
    /** Loading range in UE units at which this HLOD level becomes active. */
    loading_range: number;
    /** HLOD level index (0 = coarsest, higher = finer detail). */
    hlod_level: number;
    /** Whether actors in this layer are spatially loaded. */
    is_spatially_loaded: boolean;
  }>;
  /** Total number of HLOD layers found. */
  count: number;
}

/**
 * Result for action="generate" — satisfies requirement WP-04 generate variant.
 * Returned after triggering the HLOD build process.
 */
export interface HlodGenerateResult {
  /** Status of the generation request: e.g. "started" | "queued" | "error". */
  status: string;
  /** Human-readable message describing the outcome or next steps. */
  message: string;
}

/**
 * Union result type for ue_trigger_hlod_generation — satisfies requirement WP-04.
 * The shape depends on the action parameter used in the tool call.
 */
export type HlodResult = HlodInspectResult | HlodGenerateResult;
