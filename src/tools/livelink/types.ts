// src/tools/livelink/types.ts
// TypeScript result interfaces for the four Live Link MCP tools (Phase 27).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 27-01.

// ---------------------------------------------------------------------------
// LiveLinkSource (used within LiveLinkSourcesResult)
// ---------------------------------------------------------------------------

/**
 * A single Live Link source with its connection status.
 * Used as an element in LiveLinkSourcesResult.sources.
 * Satisfies requirement LL-01 (livelink.sources command).
 */
export interface LiveLinkSource {
  /** GUID of the Live Link source as a string. */
  source_id: string;
  /** UE class name of the source type, e.g. "LiveLinkMessageBusSource". */
  source_type: string;
  /** Hostname or IP address of the source machine. */
  machine_name: string;
  /** Connection status of the source. */
  status: 'Active' | 'Inactive' | 'Error';
}

// ---------------------------------------------------------------------------
// LiveLinkSourcesResult (LL-01: livelink.sources)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_livelink_sources — satisfies requirement LL-01.
 * Returned when the C++ handler lists all active Live Link sources via
 * the livelink.sources command.
 */
export interface LiveLinkSourcesResult {
  /** All Live Link sources currently registered with the editor. */
  sources: LiveLinkSource[];
  /** Total number of sources in the result. */
  count: number;
  /** Informational message, present when the Live Link plugin is not enabled. */
  message?: string;
}

// ---------------------------------------------------------------------------
// LiveLinkSubject (used within LiveLinkSubjectsResult)
// ---------------------------------------------------------------------------

/**
 * A single Live Link subject with its role and enabled state.
 * Used as an element in LiveLinkSubjectsResult.subjects.
 * Satisfies requirement LL-02 (livelink.subjects command).
 */
export interface LiveLinkSubject {
  /** Display name of the Live Link subject. */
  subject_name: string;
  /** GUID of the owning Live Link source. */
  source_id: string;
  /**
   * Role category for this subject.
   * Known values: "Animation", "Transform", "Camera", "Light".
   * May be a raw UE class name for custom roles.
   */
  role: string;
  /** Whether this subject is currently enabled (receiving data). */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// LiveLinkSubjectsResult (LL-02: livelink.subjects)
// ---------------------------------------------------------------------------

/**
 * Result of ue_list_livelink_subjects — satisfies requirement LL-02.
 * Returned when the C++ handler lists all Live Link subjects with their roles
 * and enabled states via the livelink.subjects command.
 */
export interface LiveLinkSubjectsResult {
  /** All Live Link subjects registered with the editor. */
  subjects: LiveLinkSubject[];
  /** Total number of subjects in the result. */
  count: number;
  /** Informational message, present when the Live Link plugin is not enabled. */
  message?: string;
}

// ---------------------------------------------------------------------------
// LiveLinkControlResult (LL-03: livelink.control)
// ---------------------------------------------------------------------------

/**
 * Result of ue_control_livelink_subject — satisfies requirement LL-03.
 * Returned when the C++ handler pauses or resumes an individual Live Link subject
 * via the livelink.control command.
 */
export interface LiveLinkControlResult {
  /** Name of the Live Link subject that was controlled. */
  subject_name: string;
  /** The new enabled state after the operation. */
  enabled: boolean;
  /** Human-readable confirmation, e.g. "Subject paused" or "Subject resumed". */
  message: string;
}

// ---------------------------------------------------------------------------
// LiveLinkTransformData (used within LiveLinkPreviewResult frame_data)
// ---------------------------------------------------------------------------

/**
 * Transform frame data for a Live Link subject with the Transform role.
 * Used as the frame_data payload in LiveLinkPreviewResult when role is "Transform".
 * Also used as the transform field within LiveLinkCameraData and LiveLinkBoneTransform.
 * Satisfies requirement LL-04 (livelink.preview command).
 */
export interface LiveLinkTransformData {
  /** World-space location of the transform in centimeters. */
  location: { x: number; y: number; z: number };
  /** World-space rotation of the transform in degrees. */
  rotation: { roll: number; pitch: number; yaw: number };
  /** World-space scale of the transform (unitless). */
  scale: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// LiveLinkCameraData (used within LiveLinkPreviewResult frame_data)
// ---------------------------------------------------------------------------

/**
 * Camera frame data for a Live Link subject with the Camera role.
 * Used as the frame_data payload in LiveLinkPreviewResult when role is "Camera".
 * Satisfies requirement LL-04 (livelink.preview command).
 */
export interface LiveLinkCameraData {
  /** Horizontal field of view in degrees. */
  field_of_view: number;
  /** Aspect ratio (width / height). */
  aspect_ratio: number;
  /** Focal length in millimeters. */
  focal_length: number;
  /** Lens aperture (f-stop). */
  aperture: number;
  /** Focus distance in centimeters. */
  focus_distance: number;
  /** World-space transform of the camera. */
  transform: LiveLinkTransformData;
}

// ---------------------------------------------------------------------------
// LiveLinkBoneTransform (used in LiveLinkAnimationData)
// ---------------------------------------------------------------------------

/**
 * Per-bone transform data for a Live Link animation subject.
 * Used as elements in LiveLinkAnimationData.bone_transforms.
 * Satisfies requirement LL-04 (livelink.preview command).
 */
export interface LiveLinkBoneTransform {
  /** Name of the bone. */
  bone_name: string;
  /** Local-space location of the bone in centimeters. */
  location: { x: number; y: number; z: number };
  /** Local-space rotation of the bone in degrees. */
  rotation: { roll: number; pitch: number; yaw: number };
}

// ---------------------------------------------------------------------------
// LiveLinkAnimationData (used within LiveLinkPreviewResult frame_data)
// ---------------------------------------------------------------------------

/**
 * Animation frame data for a Live Link subject with the Animation role.
 * Used as the frame_data payload in LiveLinkPreviewResult when role is "Animation".
 * Bone transforms are capped at 10 bones by the C++ handler to prevent oversized responses.
 * Satisfies requirement LL-04 (livelink.preview command).
 */
export interface LiveLinkAnimationData {
  /** All bone names in the skeleton, ordered by bone index. */
  bone_names: string[];
  /** Number of bones included in bone_transforms (capped at 10 by the C++ handler). */
  bone_count: number;
  /** Total number of bones in the skeleton (before any cap). */
  total_bones: number;
  /** Per-bone transform data for up to 10 bones. */
  bone_transforms: LiveLinkBoneTransform[];
}

// ---------------------------------------------------------------------------
// LiveLinkPreviewResult (LL-04: livelink.preview)
// ---------------------------------------------------------------------------

/**
 * Result of ue_preview_livelink_data — satisfies requirement LL-04.
 * Returned when the C++ handler inspects the current frame data for a
 * Live Link subject via the livelink.preview command.
 *
 * When available is true, frame_data contains role-specific data:
 *   - Transform role: LiveLinkTransformData
 *   - Camera role:    LiveLinkCameraData
 *   - Animation role: LiveLinkAnimationData
 *   - Other roles:    Record<string, unknown> (raw key/value pairs)
 *
 * When available is false, frame_data is absent and message describes why.
 */
export interface LiveLinkPreviewResult {
  /** Name of the Live Link subject whose data was previewed. */
  subject_name: string;
  /** Role of the subject (Animation, Transform, Camera, Light, or raw class name). */
  role: string;
  /** Whether current frame data was available for this subject. */
  available: boolean;
  /** Informational message, present when available is false. */
  message?: string;
  /**
   * Role-specific frame data, present when available is true.
   * Discriminate by the role field to cast to the correct type.
   */
  frame_data?: LiveLinkTransformData | LiveLinkCameraData | LiveLinkAnimationData | Record<string, unknown>;
}
