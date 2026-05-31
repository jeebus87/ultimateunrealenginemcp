// src/docs/types.ts
// API reference data types for the UE 5.7 documentation index.
// Consumed by DocIndex (doc-index.ts) and the curated data file (data/ue57-api.ts).

/**
 * One API symbol in the UE 5.7 reference index.
 * A "symbol" is a class, function, property, or enum value.
 */
export interface ApiRecord {
  /** Unique identifier — e.g. "UStaticMeshComponent" or "UStaticMeshComponent.SetStaticMesh" */
  id: string;
  /** 'class' | 'function' | 'property' | 'enum' */
  type: 'class' | 'function' | 'property' | 'enum';
  /** Short name — "SetStaticMesh", "UStaticMeshComponent" */
  name: string;
  /** Fully-qualified name — "UStaticMeshComponent.SetStaticMesh" */
  fullName: string;
  /** Owning class name — "UStaticMeshComponent" (same as name for class records) */
  className: string;
  /** Full C++ signature for functions — "void SetStaticMesh(UStaticMesh* NewMesh)" — empty string for non-functions */
  signature: string;
  /** Return type string — "void", "bool", etc — empty string for non-functions */
  returnType: string;
  /** Parameter list as a single string — "UStaticMesh* NewMesh, bool bMarkAsDirty" — empty string for non-functions */
  parameters: string;
  /** Correct #include path — "Components/StaticMeshComponent.h" */
  includePath: string;
  /** UE module name — "Engine", "CoreUObject", "InputCore", etc. */
  module: string;
  /** True if symbol is deprecated in UE 5.7 */
  deprecated: boolean;
  /** UE_DEPRECATED() message or "" */
  deprecatedMessage: string;
  /** Suggested replacement symbol or "" */
  replacementAPI: string;
  /** One-line description of the symbol for search snippet display */
  description: string;
}

export interface SearchResult {
  record: ApiRecord;
  /** MiniSearch relevance score (higher = more relevant) */
  score: number;
  /** Which fields matched the query — e.g. ['name', 'description'] */
  terms: string[];
}
