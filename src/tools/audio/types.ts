// src/tools/audio/types.ts
// TypeScript result interfaces for the four audio MCP tools (Phase 23).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 23-01.

// ---------------------------------------------------------------------------
// SoundAssetListResult (AUD-01: audio.list)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_sound_assets — satisfies requirement AUD-01.
 * Returned when the C++ handler queries IAssetRegistry for sound assets via audio.list command.
 * duration, sample_rate, num_channels, and compression_name are populated for SoundWave assets;
 * for SoundCue and MetaSound, these fields will be 0/"Unknown".
 */
export interface SoundAssetListResult {
  /** Array of sound assets found in the project. */
  assets: Array<{
    /** UE long package path, e.g. /Game/Audio/SFX_Explosion */
    asset_path: string;
    /** Short asset name, e.g. SFX_Explosion */
    asset_name: string;
    /** UE sound asset class: SoundWave | SoundCue | MetaSound */
    asset_type: 'SoundWave' | 'SoundCue' | 'MetaSound';
    /** Duration in seconds. Populated for SoundWave; 0 for SoundCue and MetaSound. */
    duration: number;
    /** Sample rate in Hz. Populated for SoundWave; 0 for SoundCue and MetaSound. */
    sample_rate: number;
    /** Number of audio channels. Populated for SoundWave; 0 for SoundCue and MetaSound. */
    num_channels: number;
    /** Compression format name. Populated for SoundWave; "Unknown" for SoundCue and MetaSound. */
    compression_name: string;
  }>;
  /** Total number of sound assets found. */
  count: number;
}

// ---------------------------------------------------------------------------
// MetaSoundNode, MetaSoundEdge, MetaSoundVertex (AUD-02: audio.metasound)
// ---------------------------------------------------------------------------

/**
 * A single node in a MetaSound patch graph.
 * Used within MetaSoundInspectResult.
 */
export interface MetaSoundNode {
  /** Unique identifier for this node within the patch graph. */
  node_id: string;
  /** UE MetaSound node class name, e.g. MetasoundOscillator or MetasoundGain. */
  node_class_name: string;
  /** Display name assigned to this node in the MetaSound editor. */
  node_name: string;
}

/**
 * A directed connection between two nodes in a MetaSound patch graph.
 * Used within MetaSoundInspectResult.
 */
export interface MetaSoundEdge {
  /** node_id of the source (upstream) node. */
  from_node: string;
  /** Name of the output pin on the source node. */
  from_output: string;
  /** node_id of the destination (downstream) node. */
  to_node: string;
  /** Name of the input pin on the destination node. */
  to_input: string;
}

/**
 * A named input or output vertex (pin) on a MetaSound patch.
 * Used for both input and output pin definitions in MetaSoundInspectResult.
 */
export interface MetaSoundVertex {
  /** Display name of this input or output pin. */
  name: string;
  /** MetaSound data type of this pin, e.g. Float, Int32, Bool, Audio, Trigger. */
  type_name: string;
}

// ---------------------------------------------------------------------------
// MetaSoundInspectResult (AUD-02: audio.metasound)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_metasound — satisfies requirement AUD-02.
 * Returned when the C++ handler inspects a MetaSound patch's graph structure
 * via audio.metasound command.
 */
export interface MetaSoundInspectResult {
  /** UE long package path of the MetaSound asset. */
  asset_path: string;
  /** All nodes defined in this MetaSound patch graph. */
  nodes: MetaSoundNode[];
  /** All directed edges (connections) between nodes in this patch graph. */
  edges: MetaSoundEdge[];
  /** Input pins exposed on this MetaSound patch. */
  inputs: MetaSoundVertex[];
  /** Output pins exposed on this MetaSound patch. */
  outputs: MetaSoundVertex[];
}

// ---------------------------------------------------------------------------
// SoundAttenuationInfo (shared by SoundCueNode and SoundCueInspectResult)
// ---------------------------------------------------------------------------

/**
 * Attenuation (distance model) settings for a sound.
 * Used within SoundCueNode and SoundCueInspectResult.
 */
export interface SoundAttenuationInfo {
  /** Inner radius in Unreal units — sound plays at full volume within this radius. */
  inner_radius: number;
  /** Distance over which volume falls off from inner_radius to zero. */
  falloff_distance: number;
  /** Distance falloff curve model, e.g. Linear, NaturalSound, Logarithmic, Inverse. */
  falloff_model: string;
  /** Spatialization method used for this sound, e.g. Panning, Binaural, HRTF. */
  spatialization_method: string;
}

// ---------------------------------------------------------------------------
// SoundCueNode (recursive node type used by SoundCueInspectResult)
// ---------------------------------------------------------------------------

/**
 * A single node in a SoundCue graph.
 * Recursive: most nodes can have children pointing to upstream nodes.
 */
export interface SoundCueNode {
  /** Display name of this node. */
  node_name: string;
  /** UE class name of this node, e.g. SoundNodeModulator, SoundNodeWavePlayer, SoundNodeAttenuation. */
  node_class: string;
  /** Child nodes feeding into this node (upstream in the graph). */
  children: SoundCueNode[];
  /** Wave asset path for SoundNodeWavePlayer nodes. Omitted for non-wave-player nodes. */
  wave_asset_path?: string;
  /** Minimum pitch multiplier for SoundNodeModulator nodes. */
  pitch_min?: number;
  /** Maximum pitch multiplier for SoundNodeModulator nodes. */
  pitch_max?: number;
  /** Minimum volume multiplier for SoundNodeModulator nodes. */
  volume_min?: number;
  /** Maximum volume multiplier for SoundNodeModulator nodes. */
  volume_max?: number;
  /** Whether this node has a custom SoundAttenuation asset override. */
  has_custom_attenuation?: boolean;
  /** Attenuation settings for SoundNodeAttenuation nodes. */
  attenuation?: SoundAttenuationInfo;
}

// ---------------------------------------------------------------------------
// SoundCueInspectResult (AUD-03: audio.soundcue)
// ---------------------------------------------------------------------------

/**
 * Result of ue_inspect_sound_cue — satisfies requirement AUD-03.
 * Returned when the C++ handler reads a SoundCue's recursive node graph
 * via audio.soundcue command.
 */
export interface SoundCueInspectResult {
  /** UE long package path of the SoundCue asset. */
  asset_path: string;
  /** The first (root output) node in the SoundCue graph, containing the full recursive tree. */
  first_node: SoundCueNode;
  /** Attenuation override applied at the SoundCue level. Omitted if no cue-level attenuation. */
  cue_attenuation?: SoundAttenuationInfo;
}

// ---------------------------------------------------------------------------
// AudioInsightsResult (AUD-04: audio.insights)
// ---------------------------------------------------------------------------

/**
 * Result of ue_query_audio_insights — satisfies requirement AUD-04.
 * Returned when the C++ handler queries Audio Insights monitoring data
 * via audio.insights command.
 * When the Audio Insights plugin is not enabled, available is false and message describes how to enable it.
 */
export interface AudioInsightsResult {
  /** Whether the Audio Insights plugin is enabled and returning data. */
  available: boolean;
  /** Human-readable message — present only when available is false, explaining how to enable the plugin. */
  message?: string;
  /** Number of sounds currently playing. Present when available is true. */
  active_sound_count?: number;
  /** Maximum number of concurrent audio channels configured. Present when available is true. */
  max_channels?: number;
  /** Recent audio events from the monitoring system. */
  recent_events: Array<{
    /** Name of the audio event (e.g. asset name or event label). */
    event_name: string;
    /** Unix timestamp (seconds since epoch) when this event occurred. */
    timestamp: number;
  }>;
}
