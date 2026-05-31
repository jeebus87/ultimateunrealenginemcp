// src/parsers/uproject-parser.ts
// Zod-validated parsers for .uproject and .uplugin JSON descriptor files.
//
// These files are standard JSON — JSON.parse with Zod schema validation is sufficient.
// Both parsers return a discriminated union (ParseResult) and never throw.
//
// References:
//   https://github.com/starkat99/unreal-schema/blob/main/uproject.schema.json
//   https://github.com/starkat99/unreal-schema/blob/main/uplugin.schema.json

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared result type
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// .uproject schemas
// ---------------------------------------------------------------------------

export const UProjectModuleSchema = z.object({
  Name: z.string(),
  Type: z.string(),
  LoadingPhase: z.string().optional(),
  PlatformAllowList: z.array(z.string()).optional(),
  PlatformDenyList: z.array(z.string()).optional(),
  TargetAllowList: z.array(z.string()).optional(),
  TargetDenyList: z.array(z.string()).optional(),
  TargetConfigurationAllowList: z.array(z.string()).optional(),
  TargetConfigurationDenyList: z.array(z.string()).optional(),
});

export const UProjectPluginEntrySchema = z.object({
  Name: z.string(),
  Enabled: z.boolean(),
  Optional: z.boolean().optional(),
  Description: z.string().optional(),
  MarketplaceURL: z.string().optional(),
  PlatformAllowList: z.array(z.string()).optional(),
  SupportedTargetPlatforms: z.array(z.string()).optional(),
});

export const UProjectSchema = z.object({
  FileVersion: z.number().int().min(1).max(3),
  EngineAssociation: z.string().optional(),
  Category: z.string().optional(),
  Description: z.string().optional(),
  Enterprise: z.boolean().optional(),
  DisableEnginePluginsByDefault: z.boolean().optional(),
  Modules: z.array(UProjectModuleSchema).optional(),
  Plugins: z.array(UProjectPluginEntrySchema).optional(),
  AdditionalPluginDirectories: z.array(z.string()).optional(),
  AdditionalRootDirectories: z.array(z.string()).optional(),
  TargetPlatforms: z.array(z.string()).optional(),
});

export type UProjectDescriptor = z.infer<typeof UProjectSchema>;

// ---------------------------------------------------------------------------
// .uplugin schemas
// ---------------------------------------------------------------------------

export const UPluginModuleSchema = z.object({
  Name: z.string(),
  Type: z.string(),
  LoadingPhase: z.string().optional(),
  PlatformAllowList: z.array(z.string()).optional(),
  PlatformDenyList: z.array(z.string()).optional(),
});

export const UPluginDependencySchema = z.object({
  Name: z.string(),
  Enabled: z.boolean(),
  Optional: z.boolean().optional(),
  PlatformAllowList: z.array(z.string()).optional(),
});

export const UPluginSchema = z.object({
  FileVersion: z.number().int().min(1).max(3),
  Version: z.number().optional(),
  VersionName: z.string().optional(),
  FriendlyName: z.string().optional(),
  Description: z.string().optional(),
  Category: z.string().optional(),
  CreatedBy: z.string().optional(),
  EngineVersion: z.string().optional(),
  SupportedTargetPlatforms: z.array(z.string()).optional(),
  Modules: z.array(UPluginModuleSchema).optional(),
  Plugins: z.array(UPluginDependencySchema).optional(),
  EnabledByDefault: z.boolean().optional(),
  CanContainContent: z.boolean().optional(),
  IsBetaVersion: z.boolean().optional(),
  IsExperimentalVersion: z.boolean().optional(),
});

export type UPluginDescriptor = z.infer<typeof UPluginSchema>;

// ---------------------------------------------------------------------------
// Parse functions
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string from a .uproject file.
 * Returns ParseResult<UProjectDescriptor> — never throws.
 *
 * Threat T-02-03: JSON.parse is wrapped in try/catch; SyntaxError is never propagated.
 */
export function parseUproject(jsonContent: string): ParseResult<UProjectDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Invalid JSON: ${msg}` };
  }

  const result = UProjectSchema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map((i) => i.message).join('; '),
  };
}

/**
 * Parse a raw JSON string from a .uplugin file.
 * Returns ParseResult<UPluginDescriptor> — never throws.
 *
 * Threat T-02-03: JSON.parse is wrapped in try/catch; SyntaxError is never propagated.
 */
export function parseUplugin(jsonContent: string): ParseResult<UPluginDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Invalid JSON: ${msg}` };
  }

  const result = UPluginSchema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map((i) => i.message).join('; '),
  };
}
