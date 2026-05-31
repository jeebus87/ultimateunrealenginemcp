// src/tools/validation/types.ts
// TypeScript result interfaces for the four validation MCP tools (Phase 16).
// These interfaces mirror the JSON shapes returned by the C++ handlers in Plan 01.

// ---------------------------------------------------------------------------
// ValidationAssetResult (VAL-01: validate.asset)
// ---------------------------------------------------------------------------

/**
 * Result of ue_validate_asset — satisfies requirement VAL-01.
 * Returned when the C++ handler runs UE data validation on a single asset.
 */
export interface ValidationAssetResult {
  /** UE long package path of the validated asset, e.g. /Game/Blueprints/BP_MyActor */
  assetPath: string;
  /** True when numErrors is zero and the asset passed all validation rules. */
  valid: boolean;
  /** Number of validation errors found. Zero when valid is true. */
  numErrors: number;
  /** Number of validation warnings found (non-fatal). */
  numWarnings: number;
}

// ---------------------------------------------------------------------------
// ValidationFolderResult (VAL-02: validate.folder)
// ---------------------------------------------------------------------------

/**
 * Result of ue_validate_folder — satisfies requirement VAL-02.
 * Returned when the C++ handler runs UE data validation on all assets under a folder.
 */
export interface ValidationFolderResult {
  /** UE package path prefix that was scanned, e.g. /Game/Blueprints */
  folderPath: string;
  /** Total number of assets found under the folder path. */
  numAssets: number;
  /** Number of assets that passed validation (zero errors). */
  numValid: number;
  /** Number of assets that failed validation (one or more errors). */
  numInvalid: number;
  /** Total number of validation warnings across all assets in the folder. */
  numWarnings: number;
}

// ---------------------------------------------------------------------------
// ValidationProjectResult (VAL-03: validate.project)
// ---------------------------------------------------------------------------

/**
 * Result of ue_validate_project — satisfies requirement VAL-03.
 * Returned when the C++ handler runs UE data validation across all /Game/ assets.
 */
export interface ValidationProjectResult {
  /** Total number of assets requested for validation. */
  numRequested: number;
  /** Number of assets that passed validation (zero errors). */
  numValid: number;
  /** Number of assets that failed validation (one or more errors). */
  numInvalid: number;
  /** Total number of validation warnings across the project. */
  numWarnings: number;
  /** Number of assets that could not be validated (e.g., unloadable assets). */
  numUnableToValidate: number;
}

// ---------------------------------------------------------------------------
// BlueprintCompileResult (VAL-04: validate.blueprint)
// ---------------------------------------------------------------------------

/**
 * Result of ue_check_blueprint — satisfies requirement VAL-04.
 * Returned when the C++ handler compile-checks a Blueprint asset.
 */
export interface BlueprintCompileResult {
  /** UE long package path of the Blueprint asset, e.g. /Game/Blueprints/BP_MyActor */
  assetPath: string;
  /** True when the Blueprint compiled successfully with no errors. */
  compiled: boolean;
  /** Compilation status: "up_to_date" | "dirty" | "error" | "unknown" */
  status: 'up_to_date' | 'dirty' | 'error' | 'unknown';
  /** Compiler error message. Empty string when compiled is true. */
  errorMessage: string;
}
