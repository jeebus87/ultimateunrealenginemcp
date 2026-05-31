// src/tools/blueprint/types.ts
// TypeScript types for Blueprint data returned by the C++ MCPBridge plugin.
// Shapes must match the JSON produced by MCPBlueprintHandlers.cpp (Plan 08-01).

export interface BlueprintPin {
  pinName: string;
  direction: 'input' | 'output';
  type: string;
  defaultValue: string;
}

export interface BlueprintNode {
  nodeGuid: string;
  type: string;      // UEdGraphNode class name, e.g. "K2Node_Event"
  title: string;     // NodeTitle FullTitle
  posX: number;
  posY: number;
  pins: BlueprintPin[];
}

export interface BlueprintConnection {
  fromNodeGuid: string;
  fromPinName: string;
  toNodeGuid: string;
  toPinName: string;
}

export interface BlueprintVariable {
  name: string;
  type: string;  // FEdGraphPinType.PinCategory
}

export interface BlueprintComponent {
  name: string;
  class: string; // ComponentTemplate class name
}

export interface BlueprintInfo {
  assetPath: string;
  parentClass: string;
  variables: BlueprintVariable[];
  components: BlueprintComponent[];
}

export interface BlueprintGraphData {
  assetPath: string;
  graphName: string;
  nodes: BlueprintNode[];
  connections: BlueprintConnection[];
}

export interface BlueprintAsset {
  assetPath: string;
  packagePath: string;
  parentClass: string;
}

export interface BlueprintListResult {
  blueprints: BlueprintAsset[];
  count: number;
}

// ---------------------------------------------------------------------------
// Phase 11: Blueprint-C++ Bridge types
// ---------------------------------------------------------------------------

/** A single C++ member (UPROPERTY or UFUNCTION) that is Blueprint-exposed. */
export interface CppExposedMember {
  /** 'property' for UPROPERTY declarations, 'function' for UFUNCTION declarations. */
  kind: 'property' | 'function';
  /** Member name (e.g., "Health", "Attack"). */
  name: string;
  /** Property type — present when kind === 'property' (e.g., "float", "AActor*"). */
  type?: string;
  /** Return type — present when kind === 'function' (e.g., "void", "FVector"). */
  returnType?: string;
  /** All UPROPERTY/UFUNCTION specifiers (superset of blueprintSpecifiers). */
  specifiers: string[];
  /** Meta key-value pairs from meta=(...) block. */
  meta: Record<string, string>;
  /** 1-based source line of the UPROPERTY/UFUNCTION macro. */
  line: number;
  /** Subset of specifiers that are Blueprint-relevant (BlueprintCallable, BlueprintReadWrite, etc.). */
  blueprintSpecifiers: string[];
}

/** A single Blueprint asset that subclasses a C++ class. */
export interface BlueprintSubclass {
  assetPath: string;
  packagePath: string;
  /** Raw parentClass tag from the asset registry (e.g., "/Script/MyGame.AMyActor"). */
  parentClassTag: string;
}

/** Response shape for blueprint.subclasses plugin command / ue_find_blueprint_subclasses tool. */
export interface BlueprintSubclassResult {
  /** The C++ class name that was queried. */
  className: string;
  subclasses: BlueprintSubclass[];
  count: number;
}

/** A single Blueprint graph node that references a C++ member. */
export interface CppUsageEntry {
  assetPath: string;
  graphName: string;
  /** UEdGraphNode class name, e.g. "K2Node_CallFunction". */
  nodeType: string;
  /** Human-readable node title from GetNodeTitle(FullTitle). */
  nodeTitle: string;
}

/** Response shape for blueprint.cppUsage plugin command / ue_trace_cpp_in_blueprints tool. */
export interface CppUsageResult {
  className: string;
  memberName: string;
  usages: CppUsageEntry[];
  count: number;
}

// ---------------------------------------------------------------------------
// Blueprint Write result types (Phase 10)
// Shapes must match the JSON produced by MCPBlueprintWriteHandlers.cpp (Plan 10-01).
// ---------------------------------------------------------------------------

export interface BlueprintCreateResult {
  assetPath: string;
  parentClass: string;
}

export interface BlueprintAddNodeResult {
  nodeGuid: string;
  type: string;
  posX: number;
  posY: number;
}

export interface BlueprintConnectResult {
  connected: boolean;
  fromNodeGuid: string;
  fromPinName: string;
  toNodeGuid: string;
  toPinName: string;
}

export interface BlueprintAddVariableResult {
  variableName: string;
  variableType: string;
}

export interface BlueprintSetDefaultResult {
  set: boolean;
  targetType: 'variable' | 'pin';
  targetName: string;
  defaultValue: string;
}
