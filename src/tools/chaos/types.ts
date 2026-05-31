// src/tools/chaos/types.ts
// TypeScript result interfaces for the four Chaos physics MCP tools (Phase 26).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 26-01.

// ---------------------------------------------------------------------------
// GeometryCollectionHierarchyNode (used by GeometryCollectionInspectResult)
// ---------------------------------------------------------------------------

/**
 * A single node in a geometry collection fracture hierarchy.
 * Used as elements in GeometryCollectionInspectResult.hierarchy.
 */
export interface GeometryCollectionHierarchyNode {
  /** Zero-based index of this bone in the geometry collection. */
  index: number;
  /** Index of the parent bone; -1 for root-level bones. */
  parent: number;
  /** Indices of child bones. Empty array for leaf bones. */
  children: number[];
  /** Fracture level depth — 0 is the root cluster, higher numbers are deeper fracture levels. */
  level: number;
  /** Display name of this bone in the geometry collection hierarchy. */
  name: string;
}

// ---------------------------------------------------------------------------
// GeometryCollectionInspectResult (CHAOS-01: chaos.geometryCollection)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_geometry_collection — satisfies requirement CHAOS-01.
 * Returned when the C++ handler inspects a Chaos geometry collection's fracture
 * hierarchy, bone count, level breakdown, and damage thresholds via the
 * chaos.geometryCollection command.
 */
export interface GeometryCollectionInspectResult {
  /** UE long package path of the geometry collection asset, or empty string if accessed via actor_label. */
  asset_path: string;
  /** Editor actor label of a placed geometry collection actor, or empty string if accessed via asset_path. */
  actor_label: string;
  /** Total number of bones (fracture pieces) in the geometry collection. */
  bone_count: number;
  /** Per-level bone count breakdown for understanding fracture hierarchy depth. */
  levels: Array<{
    /** Fracture level index (0 = root cluster). */
    level: number;
    /** Number of bones at this level. */
    bone_count: number;
  }>;
  /** Full bone hierarchy with parent/child relationships and level assignments. */
  hierarchy: GeometryCollectionHierarchyNode[];
  /** Damage threshold values per fracture level — controls when fractures activate. */
  damage_thresholds: number[];
}

// ---------------------------------------------------------------------------
// DestructionResetResult (CHAOS-02: chaos.resetDestruction)
// ---------------------------------------------------------------------------

/**
 * Result of ue_reset_destruction — satisfies requirement CHAOS-02.
 * Returned when the C++ handler resets a geometry collection actor to its
 * initial unfractured state via the chaos.resetDestruction command.
 */
export interface DestructionResetResult {
  /** Editor actor label of the geometry collection actor that was reset. */
  actor_label: string;
  /** Whether the destruction state was successfully reset to initial unfractured state. */
  success: boolean;
  /** Number of bones in the geometry collection after reset. */
  bone_count: number;
}

// ---------------------------------------------------------------------------
// ClothAssetParams (used by ClothParamsResult)
// ---------------------------------------------------------------------------

/**
 * Simulation parameters for a single cloth asset attached to a skeletal mesh.
 * Used as elements in ClothParamsResult.cloth_assets.
 */
export interface ClothAssetParams {
  /** Name of the cloth asset within the skeletal mesh. */
  asset_name: string;
  /** Minimum distance between cloth particles before self-collision response activates (centimeters). */
  self_collision_thickness: number;
  /** Friction coefficient between cloth and colliders (0–1). */
  friction: number;
  /** Velocity damping coefficient applied to cloth particles each frame (0–1). */
  damping: number;
  /** Scale applied to world gravity for this cloth simulation (1.0 = full gravity). */
  gravity_scale: number;
  /** Wind drag coefficient — higher values make the cloth respond more to wind force. */
  wind_drag: number;
  /** Wind lift coefficient — higher values add aerodynamic lift to the cloth. */
  wind_lift: number;
  /** Resistance to bending between adjacent cloth panels (0–1, higher = stiffer). */
  bend_stiffness: number;
  /** Resistance to stretching along cloth triangles (0–1, higher = less elastic). */
  stretch_stiffness: number;
  /** Resistance to shear deformation (0–1, higher = more rigid). */
  shear_stiffness: number;
}

// ---------------------------------------------------------------------------
// ClothParamsResult (CHAOS-03: chaos.cloth)
// ---------------------------------------------------------------------------

/**
 * Result of ue_read_cloth_params — satisfies requirement CHAOS-03.
 * Returned when the C++ handler reads Chaos cloth simulation parameters
 * from a skeletal mesh actor or cloth asset via the chaos.cloth command.
 * Requires the ChaosCloth plugin to be enabled in the project.
 */
export interface ClothParamsResult {
  /** Editor actor label of the actor with cloth simulation, or empty string if accessed via asset_path. */
  actor_label: string;
  /** UE long package path of the cloth asset, or empty string if accessed via actor_label. */
  asset_path: string;
  /** Per-cloth-asset simulation parameters for all cloth assets on the target. */
  cloth_assets: ClothAssetParams[];
}

// ---------------------------------------------------------------------------
// PhysicsCacheResult (CHAOS-04: chaos.physicsCache)
// ---------------------------------------------------------------------------

/**
 * Result of ue_manage_physics_cache — satisfies requirement CHAOS-04.
 * Returned when the C++ handler starts, stops, or queries Chaos physics cache
 * recording state via the chaos.physicsCache command.
 */
export interface PhysicsCacheResult {
  /** The action that was performed: 'start', 'stop', or 'query'. */
  action: string;
  /** Current recording status of the physics cache. */
  status: 'recording' | 'stopped' | 'not_available';
  /** Number of simulation frames currently stored in the cache (0 if not recording or empty). */
  frame_count: number;
  /** Time range of cached simulation frames (both 0 if cache is empty). */
  time_range: {
    /** Start time of the cached simulation range (seconds). */
    start: number;
    /** End time of the cached simulation range (seconds). */
    end: number;
  };
}
