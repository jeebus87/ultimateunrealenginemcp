// src/tools/blueprint/index.ts
// Registers Blueprint tools on the MCP server.
// Read tools (ue_read_blueprint, ue_read_blueprint_graph, ue_list_blueprints) send
// commands to the UE Editor plugin via PluginBridgeClient.sendCommand().
// Write tools (ue_create_blueprint, ue_add_blueprint_node) remain as Phase 10 stubs.
// All tools require the UE Editor MCPBridge plugin and return a structured
// plugin_not_connected error (not a crash) when the plugin is not running.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import { withKnownIssues } from '../known-issues/middleware.js';
import { PluginBridgeClient, PluginNotConnectedError } from '../../plugin-bridge/client.js';
import { parseCppFile } from '../../parsers/cpp-parser.js';
import { validatePath } from '../../utils/path-guard.js';
import { PROJECT_ROOT } from '../../config.js';
import type {
  BlueprintInfo, BlueprintGraphData, BlueprintListResult,
  CppExposedMember, BlueprintSubclassResult, CppUsageResult,
  BlueprintCreateResult, BlueprintAddNodeResult, BlueprintConnectResult,
  BlueprintAddVariableResult, BlueprintSetDefaultResult,
} from './types.js';

// Module-level bridge instance — Phase 7 will introduce a shared singleton.
// Two instances (blueprint + editor) is acceptable for Phase 1 stub behaviour.
const bridge = new PluginBridgeClient();

// ---------------------------------------------------------------------------
// Exported handler functions (for direct unit testing)
// ---------------------------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * ue_read_blueprint handler — reads Blueprint structure via plugin bridge.
 * BPR-01: returns parentClass, variables, and components.
 */
export async function handleReadBlueprint(args: { asset_path: string }): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({
      type: 'blueprint.read',
      correlationId: '',  // overwritten by sendCommand
      payload: { asset_path: args.asset_path },
    });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error ?? 'unknown_error' }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.data as BlueprintInfo, null, 2) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }] };
    }
    throw err;
  }
}

/**
 * ue_read_blueprint_graph handler — reads Blueprint graph nodes and connections.
 * BPR-02 (event graph), BPR-03 (function graphs).
 */
export async function handleReadBlueprintGraph(
  args: { asset_path: string; graph_name?: string }
): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({
      type: 'blueprint.graph',
      correlationId: '',  // overwritten by sendCommand
      payload: {
        asset_path: args.asset_path,
        graph_name: args.graph_name ?? 'EventGraph',
      },
    });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error ?? 'unknown_error' }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.data as BlueprintGraphData, null, 2) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }] };
    }
    throw err;
  }
}

/**
 * ue_list_blueprints handler — lists Blueprint assets from the asset registry.
 * BPR-04: returns all Blueprints with optional path_prefix filter.
 */
export async function handleListBlueprints(
  args: { path_prefix?: string }
): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({
      type: 'blueprint.list',
      correlationId: '',  // overwritten by sendCommand
      payload: args.path_prefix ? { path_prefix: args.path_prefix } : {},
    });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error ?? 'unknown_error' }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.data as BlueprintListResult, null, 2) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendOrDisconnect — shared helper for write handlers (Phase 10)
// Pattern copied from src/tools/editor/index.ts.
// ---------------------------------------------------------------------------

async function sendOrDisconnect(
  b: PluginBridgeClient,
  cmd: { type: string; payload?: unknown }
): Promise<ToolResult> {
  try {
    const response = await b.sendCommand({ ...cmd, correlationId: '' });
    if (!response.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.data ?? {}) }],
    };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }],
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Blueprint Write handlers (Phase 10)
// ---------------------------------------------------------------------------

/**
 * ue_create_blueprint handler — creates a new Blueprint asset via plugin bridge.
 * BPW-01: returns assetPath and parentClass on success.
 */
export async function handleCreateBlueprint(
  args: { parent_class: string; asset_path: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, {
    type: 'blueprint.create',
    payload: { parent_class: args.parent_class, asset_path: args.asset_path },
  });
}

/**
 * ue_add_blueprint_node handler — adds a node to a Blueprint graph via plugin bridge.
 * BPW-02: returns nodeGuid, type, posX, posY on success.
 */
export async function handleAddBlueprintNode(
  args: {
    asset_path: string;
    graph_name: string;
    node_type: string;
    pos_x?: number;
    pos_y?: number;
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, {
    type: 'blueprint.addNode',
    payload: {
      asset_path: args.asset_path,
      graph_name: args.graph_name,
      node_type: args.node_type,
      pos_x: args.pos_x ?? 0,
      pos_y: args.pos_y ?? 0,
    },
  });
}

/**
 * ue_connect_blueprint_pins handler — connects two pins via plugin bridge.
 * BPW-03: returns connected:true with the four identifiers on success.
 */
export async function handleConnectBlueprintPins(
  args: {
    asset_path: string;
    graph_name?: string;
    from_node_guid: string;
    from_pin_name: string;
    to_node_guid: string;
    to_pin_name: string;
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, {
    type: 'blueprint.connectPins',
    payload: {
      asset_path: args.asset_path,
      graph_name: args.graph_name ?? 'EventGraph',
      from_node_guid: args.from_node_guid,
      from_pin_name: args.from_pin_name,
      to_node_guid: args.to_node_guid,
      to_pin_name: args.to_pin_name,
    },
  });
}

/**
 * ue_add_blueprint_variable handler — adds a typed variable via plugin bridge.
 * BPW-04: returns variableName and variableType on success.
 */
export async function handleAddBlueprintVariable(
  args: { asset_path: string; variable_name: string; variable_type: string },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, {
    type: 'blueprint.addVariable',
    payload: {
      asset_path: args.asset_path,
      variable_name: args.variable_name,
      variable_type: args.variable_type,
    },
  });
}

/**
 * ue_set_blueprint_default handler — sets a default value on a variable or pin.
 * BPW-05: returns set:true on success.
 */
export async function handleSetBlueprintDefault(
  args: {
    asset_path: string;
    target_type: 'variable' | 'pin';
    target_name?: string;
    graph_name?: string;
    node_guid?: string;
    pin_name?: string;
    default_value: string;
  },
  b: PluginBridgeClient = bridge
): Promise<ToolResult> {
  return sendOrDisconnect(b, {
    type: 'blueprint.setDefault',
    payload: {
      asset_path: args.asset_path,
      target_type: args.target_type,
      target_name: args.target_name,
      graph_name: args.graph_name ?? 'EventGraph',
      node_guid: args.node_guid,
      pin_name: args.pin_name,
      default_value: args.default_value,
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 11: Blueprint-C++ Bridge constants and handlers
// ---------------------------------------------------------------------------

const BLUEPRINT_SPECIFIERS = new Set([
  'BlueprintCallable',
  'BlueprintReadWrite',
  'BlueprintReadOnly',
  'BlueprintPure',
  'BlueprintImplementableEvent',
  'BlueprintNativeEvent',
  'BlueprintAssignable',
  'BlueprintAuthorityOnly',
]);

/**
 * ue_cpp_exposed_members handler — parses a C++ header file locally and returns
 * all UFUNCTION/UPROPERTY members that have Blueprint-relevant specifiers.
 * BPC-01: pure TypeScript parser operation, no plugin required.
 */
export async function handleCppExposedMembers(args: { file_path: string }): Promise<ToolResult> {
  let safePath: string;
  try {
    safePath = validatePath(args.file_path, PROJECT_ROOT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `Path error: ${msg}` }] };
  }
  let content: string;
  try {
    content = await fs.readFile(safePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `File read error: ${msg}` }] };
  }
  const result = parseCppFile(content);
  if (!result.success) {
    return { isError: true, content: [{ type: 'text', text: `Parse error: ${result.error}` }] };
  }
  const members: CppExposedMember[] = [];
  for (const cls of result.data.classes) {
    for (const prop of cls.properties) {
      const bpSpecs = prop.specifiers.filter(s => BLUEPRINT_SPECIFIERS.has(s.split('=')[0]!.trim()));
      if (bpSpecs.length > 0) {
        members.push({ kind: 'property', name: prop.name, type: prop.type, specifiers: prop.specifiers, meta: prop.meta, line: prop.line, blueprintSpecifiers: bpSpecs });
      }
    }
    for (const fn of cls.functions) {
      const bpSpecs = fn.specifiers.filter(s => BLUEPRINT_SPECIFIERS.has(s.split('=')[0]!.trim()));
      if (bpSpecs.length > 0) {
        members.push({ kind: 'function', name: fn.name, returnType: fn.returnType, specifiers: fn.specifiers, meta: fn.meta, line: fn.line, blueprintSpecifiers: bpSpecs });
      }
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(members, null, 2) }] };
}

/**
 * ue_find_blueprint_subclasses handler — finds all Blueprint assets subclassing
 * a given C++ class via the UE Editor plugin bridge.
 * BPC-02: requires plugin; returns plugin_not_connected when editor is not running.
 */
export async function handleFindBlueprintSubclasses(args: { class_name: string }): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({
      type: 'blueprint.subclasses',
      correlationId: '',
      payload: { class_name: args.class_name },
    });
    if (!response.success) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: response.error ?? 'unknown_error' }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(response.data as BlueprintSubclassResult, null, 2) }] };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }] };
    }
    throw err;
  }
}

/**
 * ue_trace_cpp_in_blueprints handler — finds all Blueprint graph nodes that
 * call or access a specific C++ member via the UE Editor plugin bridge.
 * BPC-03: requires plugin; returns plugin_not_connected when editor is not running.
 */
export async function handleTraceCppInBlueprints(args: { class_name: string; member_name: string }): Promise<ToolResult> {
  try {
    const response = await bridge.sendCommand({
      type: 'blueprint.cppUsage',
      correlationId: '',
      payload: { class_name: args.class_name, member_name: args.member_name },
    });
    if (!response.success) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: response.error ?? 'unknown_error' }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(response.data as CppUsageResult, null, 2) }] };
  } catch (err) {
    if (err instanceof PluginNotConnectedError) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.bridgeError) }] };
    }
    throw err;
  }
}

/**
 * Register Blueprint tools on the MCP server.
 *
 * All tools in this domain require the MCPBridge editor plugin.
 * When the plugin is not connected, each handler returns:
 *   { isError: true, content: [{ type: 'text', text: <plugin_not_connected JSON> }] }
 *
 * Tools registered:
 *   ue_read_blueprint       — Read Blueprint parentClass, variables, and components
 *   ue_read_blueprint_graph — Read Blueprint event/function graph nodes and connections
 *   ue_list_blueprints      — List Blueprint assets in the project
 *   ue_create_blueprint     — Create a new Blueprint asset (Phase 10 stub)
 *   ue_add_blueprint_node   — Add a node to a Blueprint graph (Phase 10 stub)
 *
 * @param server          The McpServer instance to register tools on.
 * @param injectedBridge  Optional bridge instance for unit testing (Plan 10-03).
 */
export function registerBlueprintTools(server: McpServer, injectedBridge?: PluginBridgeClient): void {
  const b = injectedBridge ?? bridge;
  // --------------------------------------------------------------------------
  // ue_read_blueprint
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_blueprint',
    {
      title: 'Read Blueprint',
      description:
        '[requires_plugin] Read a Blueprint asset\'s parentClass, variables, and components via the UE Editor plugin.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint (e.g., /Game/Blueprints/BP_MyActor)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_blueprint', handleReadBlueprint)
  );

  // --------------------------------------------------------------------------
  // ue_list_blueprints
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_blueprints',
    {
      title: 'List Blueprints',
      description:
        '[requires_plugin] List Blueprint assets in the project, optionally filtered by path prefix.',
      inputSchema: z.object({
        path_prefix: z
          .string()
          .optional()
          .describe('Optional asset path prefix to filter results (e.g., /Game/Blueprints/)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_blueprints', handleListBlueprints)
  );

  // --------------------------------------------------------------------------
  // ue_read_blueprint_graph
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_blueprint_graph',
    {
      title: 'Read Blueprint Graph',
      description:
        '[requires_plugin] Read the nodes and connections in a Blueprint event graph or custom function graph.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint (e.g., /Game/Blueprints/BP_MyActor)'),
        graph_name: z
          .string()
          .optional()
          .describe('Graph name to read (e.g., "EventGraph" or a custom function name). Defaults to "EventGraph".'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_blueprint_graph', handleReadBlueprintGraph)
  );

  // --------------------------------------------------------------------------
  // ue_create_blueprint  — BPW-01
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_create_blueprint',
    {
      title: 'Create Blueprint',
      description:
        '[requires_plugin] Create a new Blueprint asset in the UE project via the UE Editor plugin.',
      inputSchema: z.object({
        parent_class: z.string().describe('The parent C++ or Blueprint class (e.g., AActor)'),
        asset_path: z.string().describe('Asset path for the new Blueprint (e.g., /Game/Blueprints/BP_NewActor)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_create_blueprint', (args) =>
      handleCreateBlueprint(args as { parent_class: string; asset_path: string }, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_add_blueprint_node  — BPW-02
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_blueprint_node',
    {
      title: 'Add Blueprint Node',
      description:
        '[requires_plugin] Add a node to a Blueprint graph via the UE Editor plugin.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint (e.g., /Game/Blueprints/BP_MyActor)'),
        graph_name: z.string().describe('The graph to add the node to (e.g., EventGraph)'),
        node_type: z.string().describe('The node type to add (e.g., K2Node_CallFunction)'),
        pos_x: z.number().optional().describe('X position in the graph (default: 0)'),
        pos_y: z.number().optional().describe('Y position in the graph (default: 0)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_add_blueprint_node', (args) =>
      handleAddBlueprintNode(args as {
        asset_path: string;
        graph_name: string;
        node_type: string;
        pos_x?: number;
        pos_y?: number;
      }, b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_connect_blueprint_pins  — BPW-03
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_connect_blueprint_pins',
    {
      title: 'Connect Blueprint Pins',
      description:
        '[requires_plugin] Connect two pins in a Blueprint graph by node GUID and pin name.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint (e.g., /Game/Blueprints/BP_MyActor)'),
        graph_name: z.string().optional().describe('Graph name (default: "EventGraph")'),
        from_node_guid: z.string().describe('GUID of the source node'),
        from_pin_name: z.string().describe('Name of the output pin on the source node'),
        to_node_guid: z.string().describe('GUID of the destination node'),
        to_pin_name: z.string().describe('Name of the input pin on the destination node'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_connect_blueprint_pins', (args) =>
      handleConnectBlueprintPins(args as Parameters<typeof handleConnectBlueprintPins>[0], b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_add_blueprint_variable  — BPW-04
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_blueprint_variable',
    {
      title: 'Add Blueprint Variable',
      description:
        '[requires_plugin] Add a new typed variable to a Blueprint via the UE Editor plugin.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint'),
        variable_name: z.string().describe('Name for the new variable (e.g., Health)'),
        variable_type: z.string().describe(
          'Type category for the variable. Supported: bool, int, int64, float, double, string, name, text, object, class, struct, vector, rotator, transform'
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_add_blueprint_variable', (args) =>
      handleAddBlueprintVariable(args as Parameters<typeof handleAddBlueprintVariable>[0], b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_set_blueprint_default  — BPW-05
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_set_blueprint_default',
    {
      title: 'Set Blueprint Default Value',
      description:
        '[requires_plugin] Set the default value on a Blueprint variable or node pin.',
      inputSchema: z.object({
        asset_path: z.string().describe('Asset path to the Blueprint'),
        target_type: z.enum(['variable', 'pin']).describe('"variable" to set a variable default, "pin" to set a node pin default'),
        target_name: z.string().optional().describe('Variable name (when target_type is "variable")'),
        graph_name: z.string().optional().describe('Graph name (when target_type is "pin", default: "EventGraph")'),
        node_guid: z.string().optional().describe('Node GUID (when target_type is "pin")'),
        pin_name: z.string().optional().describe('Pin name (when target_type is "pin")'),
        default_value: z.string().describe('The default value to set (as a string)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_set_blueprint_default', (args) =>
      handleSetBlueprintDefault(args as Parameters<typeof handleSetBlueprintDefault>[0], b)
    )
  );

  // --------------------------------------------------------------------------
  // ue_cpp_exposed_members  — Phase 11, BPC-01 (pure parser, no plugin needed)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_cpp_exposed_members',
    {
      title: 'Get Blueprint-Exposed C++ Members',
      description:
        'Parse a UE C++ header file and return all UFUNCTION/UPROPERTY members flagged as BlueprintCallable, BlueprintReadWrite, BlueprintReadOnly, BlueprintPure, BlueprintImplementableEvent, or BlueprintNativeEvent.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h file to parse'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withKnownIssues('ue_cpp_exposed_members', handleCppExposedMembers)
  );

  // --------------------------------------------------------------------------
  // ue_find_blueprint_subclasses  — Phase 11, BPC-02 (requires plugin)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_find_blueprint_subclasses',
    {
      title: 'Find Blueprint Subclasses of C++ Class',
      description:
        '[requires_plugin] Find all Blueprint assets in the project that subclass a given C++ class name.',
      inputSchema: z.object({
        class_name: z.string().describe('C++ class name to search for (e.g., "AMyActor")'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withKnownIssues('ue_find_blueprint_subclasses', handleFindBlueprintSubclasses)
  );

  // --------------------------------------------------------------------------
  // ue_trace_cpp_in_blueprints  — Phase 11, BPC-03 (requires plugin)
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_trace_cpp_in_blueprints',
    {
      title: 'Trace C++ Member Usage in Blueprints',
      description:
        '[requires_plugin] Find all Blueprint graphs that call or access a specific C++ UFUNCTION or UPROPERTY by class name and member name.',
      inputSchema: z.object({
        class_name: z.string().describe('C++ class name that owns the member (e.g., "AMyActor")'),
        member_name: z.string().describe('Member name to search for (e.g., "Attack", "Health")'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withKnownIssues('ue_trace_cpp_in_blueprints', handleTraceCppInBlueprints)
  );
}
