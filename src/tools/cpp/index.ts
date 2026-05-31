// src/tools/cpp/index.ts
// Registers real C++ parsing and analysis tools on the MCP server.
// Implements CPP-01 through CPP-04 using cpp-parser.ts and cpp-class-index.ts.
// Implements GEN-01 through GEN-08 using class-generator.ts and file-modifier.ts.
//
// All handlers:
//   - Wrapped with withKnownIssues() for known-issue pre-check and exception catching
//   - File path args validated via validatePath() before any fs operation (T-04-06, T-05-09, T-05-10)
//   - Use console.error only (never console.log — stdout safety)

import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues } from '../known-issues/middleware.js';
import { parseCppFile } from '../../parsers/cpp-parser.js';
import { buildIndex } from '../../parsers/cpp-class-index.js';
import { validatePath } from '../../utils/path-guard.js';
import { PROJECT_ROOT } from '../../config.js';
import { generateClass } from '../../generators/class-generator.js';
import { addProperty, addFunction, addInclude } from '../../generators/file-modifier.js';
import { validateUhtRules } from '../../generators/uht-validator.js';

// ---------------------------------------------------------------------------
// Exported handler functions (for direct unit testing)
// ---------------------------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * ue_read_cpp_class handler — reads and parses a UE C++ header file.
 * CPP-01: Extracts UCLASS, UPROPERTY, UFUNCTION declarations with specifiers and meta.
 */
export async function handleReadCppClass(args: { file_path: string }): Promise<ToolResult> {
  const safePath = validatePath(args.file_path, PROJECT_ROOT);
  const content = await fs.readFile(safePath, 'utf8');
  const result = parseCppFile(content);
  if (!result.success) {
    return { isError: true, content: [{ type: 'text', text: `Parse error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

/**
 * ue_get_class_hierarchy handler — returns the inheritance chain for a UE class.
 * CPP-02: Walks parentClass links in the project class index.
 */
export async function handleGetClassHierarchy(args: { class_name: string }): Promise<ToolResult> {
  const indexResult = await buildIndex(PROJECT_ROOT);
  if (!indexResult.success) {
    return { isError: true, content: [{ type: 'text', text: `Index error: ${indexResult.error}` }] };
  }
  const chain = indexResult.index.getClassHierarchy(args.class_name);
  return { content: [{ type: 'text', text: JSON.stringify({ className: args.class_name, chain }, null, 2) }] };
}

/**
 * ue_trace_includes handler — returns the direct #include list from a header file.
 * CPP-03: Reads the file directly and returns its parsed include list.
 */
export async function handleTraceIncludes(args: { file_path: string }): Promise<ToolResult> {
  const safePath = validatePath(args.file_path, PROJECT_ROOT);
  const content = await fs.readFile(safePath, 'utf8');
  const parseResult = parseCppFile(content);
  if (!parseResult.success) {
    return { isError: true, content: [{ type: 'text', text: `Parse error: ${parseResult.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ filePath: safePath, includes: parseResult.data.includes }, null, 2) }] };
}

/**
 * ue_find_class_file handler — locates header and source files for a UE class.
 * CPP-04: Searches the project class index for the given class name.
 */
export async function handleFindClassFile(args: { class_name: string }): Promise<ToolResult> {
  const indexResult = await buildIndex(PROJECT_ROOT);
  if (!indexResult.success) {
    return { isError: true, content: [{ type: 'text', text: `Index error: ${indexResult.error}` }] };
  }
  const found = indexResult.index.findClassFile(args.class_name);
  if (!found) {
    return { content: [{ type: 'text', text: `Class "${args.class_name}" not found in Source/ directory` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(found, null, 2) }] };
}

/**
 * ue_generate_class handler — generates a new UE C++ class file pair (.h + .cpp).
 * GEN-01 through GEN-04, GEN-08: Creates class files for Actor, Component, GameMode,
 * Interface, etc. with correct UHT macros. Validates with UHT rules before writing.
 * T-05-09: Validates output_dir and final file paths against PROJECT_ROOT.
 */
export async function handleGenerateClass(args: {
  class_type: string;
  class_name: string;
  module_name: string;
  output_dir: string;
  parent_class?: string;
}): Promise<ToolResult> {
  const safeDir = validatePath(args.output_dir, PROJECT_ROOT);

  // Validate class_type is a known ClassType
  const VALID_TYPES = ['Actor', 'ActorComponent', 'SceneComponent', 'GameMode', 'GameState', 'PlayerState', 'PlayerController', 'Interface'] as const;
  if (!VALID_TYPES.includes(args.class_type as typeof VALID_TYPES[number])) {
    return { isError: true, content: [{ type: 'text', text: `Unknown class_type: "${args.class_type}". Valid: ${VALID_TYPES.join(', ')}` }] };
  }

  const generated = generateClass({
    classType: args.class_type as typeof VALID_TYPES[number],
    className: args.class_name,
    moduleName: args.module_name,
    parentClass: args.parent_class,
  });

  // UHT pre-validation (GEN-08): validate header before writing to disk
  const validation = validateUhtRules(generated.header);
  if (!validation.valid) {
    return { isError: true, content: [{ type: 'text', text: `UHT validation failed:\n${validation.errors.join('\n')}` }] };
  }

  const headerPath = path.join(safeDir, generated.headerFileName);
  const cppPath = path.join(safeDir, generated.cppFileName);

  // Re-validate final paths are within project root (T-05-09)
  validatePath(headerPath, PROJECT_ROOT);
  validatePath(cppPath, PROJECT_ROOT);

  await fs.writeFile(headerPath, generated.header, 'utf8');
  await fs.writeFile(cppPath, generated.cpp, 'utf8');

  const HOT_RELOAD_WARNING = '\n\nNote: Restart the Unreal Editor (or recompile) before creating Blueprint subclasses of the new class. Hot Reload does not register new C++ classes.';

  return {
    content: [{
      type: 'text',
      text: `Generated ${args.class_type} class "${generated.headerFileName.replace('.h', '')}"\nHeader: ${headerPath}\nCpp: ${cppPath}${HOT_RELOAD_WARNING}`,
    }],
  };
}

/**
 * ue_add_property handler — adds a UPROPERTY declaration to an existing .h file.
 * GEN-05: Reads file, calls addProperty (which calls validateUhtRules internally), writes result.
 * T-05-10: Validates file_path against PROJECT_ROOT before reading/writing.
 */
export async function handleAddProperty(args: {
  file_path: string;
  class_name: string;
  specifiers: string[];
  type: string;
  name: string;
  default_value?: string;
}): Promise<ToolResult> {
  const safePath = validatePath(args.file_path, PROJECT_ROOT);
  const content = await fs.readFile(safePath, 'utf8');
  const result = addProperty(content, args.class_name, {
    specifiers: args.specifiers,
    type: args.type,
    name: args.name,
    defaultValue: args.default_value,
  });
  if (!result.success) {
    return { isError: true, content: [{ type: 'text', text: result.error }] };
  }
  await fs.writeFile(safePath, result.content, 'utf8');
  return { content: [{ type: 'text', text: `Added UPROPERTY ${args.name} to class ${args.class_name} in ${safePath}` }] };
}

/**
 * ue_add_function handler — adds a UFUNCTION declaration to an existing .h file.
 * GEN-06: Reads file, calls addFunction (which calls validateUhtRules internally), writes result.
 * T-05-10: Validates file_path against PROJECT_ROOT before reading/writing.
 */
export async function handleAddFunction(args: {
  file_path: string;
  class_name: string;
  specifiers: string[];
  return_type: string;
  name: string;
  params?: string;
  is_const?: boolean;
}): Promise<ToolResult> {
  const safePath = validatePath(args.file_path, PROJECT_ROOT);
  const content = await fs.readFile(safePath, 'utf8');
  const result = addFunction(content, args.class_name, {
    specifiers: args.specifiers,
    returnType: args.return_type,
    name: args.name,
    params: args.params,
    isConst: args.is_const,
  });
  if (!result.success) {
    return { isError: true, content: [{ type: 'text', text: result.error }] };
  }
  await fs.writeFile(safePath, result.content, 'utf8');
  return { content: [{ type: 'text', text: `Added UFUNCTION ${args.name} to class ${args.class_name} in ${safePath}` }] };
}

/**
 * ue_add_include handler — adds an #include directive to an existing .h or .cpp file.
 * GEN-07: Reads file, calls addInclude (idempotent, which calls validateUhtRules), writes result.
 * T-05-10: Validates file_path against PROJECT_ROOT before reading/writing.
 */
export async function handleAddInclude(args: {
  file_path: string;
  include_path: string;
}): Promise<ToolResult> {
  const safePath = validatePath(args.file_path, PROJECT_ROOT);
  const content = await fs.readFile(safePath, 'utf8');
  const result = addInclude(content, args.include_path);
  if (!result.success) {
    return { isError: true, content: [{ type: 'text', text: result.error }] };
  }
  await fs.writeFile(safePath, result.content, 'utf8');
  return { content: [{ type: 'text', text: `Added include "${args.include_path}" to ${safePath}` }] };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register C++ analysis and generation tools on the MCP server.
 *
 * Tools registered (real implementations — CPP-01 through CPP-04, GEN-01 through GEN-08):
 *   ue_read_cpp_class      — Read and parse a UE C++ header file
 *   ue_get_class_hierarchy — Get inheritance hierarchy for a UE class
 *   ue_trace_includes      — Trace include chain for a header file
 *   ue_find_class_file     — Locate the header and source files for a UE class name
 *   ue_generate_class      — Generate a new UE C++ class file pair (.h + .cpp)
 *   ue_add_property        — Add a UPROPERTY declaration to an existing .h file
 *   ue_add_function        — Add a UFUNCTION declaration to an existing .h file
 *   ue_add_include         — Add an #include directive to an existing .h or .cpp file
 *
 * @param server  The McpServer instance to register tools on.
 */
export function registerCppTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // ue_read_cpp_class
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_cpp_class',
    {
      title: 'Read UE C++ Class',
      description:
        'Read and parse a UE C++ header file, extracting UCLASS, UPROPERTY, and UFUNCTION declarations.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h file'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_cpp_class', handleReadCppClass)
  );

  // --------------------------------------------------------------------------
  // ue_get_class_hierarchy
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_get_class_hierarchy',
    {
      title: 'Get UE Class Hierarchy',
      description:
        'Get the full inheritance hierarchy for a Unreal Engine C++ class.',
      inputSchema: z.object({
        class_name: z.string().describe('The UE class name (e.g., AActor, UObject)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_get_class_hierarchy', handleGetClassHierarchy)
  );

  // --------------------------------------------------------------------------
  // ue_trace_includes
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_trace_includes',
    {
      title: 'Trace UE Include Chain',
      description:
        'Trace the #include chain for a UE C++ header file to identify circular or missing includes.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h file to trace'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_trace_includes', handleTraceIncludes)
  );

  // --------------------------------------------------------------------------
  // ue_find_class_file
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_find_class_file',
    {
      title: 'Find UE Class File',
      description:
        'Locate the header file (.h) that declares a given UE C++ class name.',
      inputSchema: z.object({
        class_name: z.string().describe('The UE class name to find (e.g., APlayerController)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_find_class_file', handleFindClassFile)
  );

  // --------------------------------------------------------------------------
  // ue_generate_class
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_generate_class',
    {
      title: 'Generate UE C++ Class',
      description:
        'Generate a new UE C++ class (Actor, Component, GameMode, Interface, etc.) with correct UHT macros and boilerplate. Writes .h and .cpp files to the specified directory.',
      inputSchema: z.object({
        class_type: z.enum(['Actor', 'ActorComponent', 'SceneComponent', 'GameMode', 'GameState', 'PlayerState', 'PlayerController', 'Interface'])
          .describe('The type of UE class to generate'),
        class_name: z.string().describe('Class name without prefix (e.g., "MyActor" → "AMyActor")'),
        module_name: z.string().describe('The module name (e.g., "MyGame") — used for the API macro'),
        output_dir: z.string().describe('Absolute directory path where .h and .cpp will be written'),
        parent_class: z.string().optional().describe('Optional parent class override (defaults by class_type)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_generate_class', handleGenerateClass)
  );

  // --------------------------------------------------------------------------
  // ue_add_property
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_property',
    {
      title: 'Add UPROPERTY to UE Class',
      description:
        'Add a UPROPERTY declaration to an existing UE C++ header file. The property is inserted after the last existing UPROPERTY in the target class.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h file'),
        class_name: z.string().describe('The class to add the property to'),
        specifiers: z.array(z.string()).describe('UPROPERTY specifiers (e.g., ["EditAnywhere", "BlueprintReadWrite"])'),
        type: z.string().describe('Property type (e.g., "float", "AActor*", "TArray<FHitResult>")'),
        name: z.string().describe('Property name (e.g., "Health")'),
        default_value: z.string().optional().describe('Optional default value (e.g., "100.0f")'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_add_property', handleAddProperty)
  );

  // --------------------------------------------------------------------------
  // ue_add_function
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_function',
    {
      title: 'Add UFUNCTION to UE Class',
      description:
        'Add a UFUNCTION declaration to an existing UE C++ header file. The function signature is inserted after the last existing UFUNCTION in the target class.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h file'),
        class_name: z.string().describe('The class to add the function to'),
        specifiers: z.array(z.string()).describe('UFUNCTION specifiers (e.g., ["BlueprintCallable", "Category=\\"Combat\\""])'),
        return_type: z.string().describe('Return type (e.g., "void", "float", "FVector")'),
        name: z.string().describe('Function name (e.g., "Attack")'),
        params: z.string().optional().describe('Parameter list as raw string (e.g., "float Damage, AActor* Target")'),
        is_const: z.boolean().optional().describe('Whether the function is const'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_add_function', handleAddFunction)
  );

  // --------------------------------------------------------------------------
  // ue_add_include
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_add_include',
    {
      title: 'Add #include to UE C++ File',
      description:
        'Add an #include directive to an existing UE C++ header file. Inserts before the .generated.h include (UHT requirement). Idempotent — safe to call even if the include already exists.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the .h or .cpp file'),
        include_path: z.string().describe('Include path with quotes or angle brackets (e.g., \'"Engine/Actor.h"\' or \'<algorithm>\')'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withKnownIssues('ue_add_include', handleAddInclude)
  );
}
