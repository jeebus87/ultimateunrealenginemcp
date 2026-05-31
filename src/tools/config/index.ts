// src/tools/config/index.ts
// Registers UE config file tools on the MCP server.
// All handlers validated with validatePath() and wrapped with withKnownIssues().
// No console.log — all logging uses stderr via console.error (see logger.ts).
// Backup (.bak) is created before any write operation.

import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withKnownIssues } from '../known-issues/middleware.js';
import { parseIni, setIniValue } from '../../parsers/ini-parser.js';
import { parseUproject, parseUplugin } from '../../parsers/uproject-parser.js';
import { validatePath } from '../../utils/path-guard.js';
import { PROJECT_ROOT } from '../../config.js';

/**
 * Register UE config file tools on the MCP server.
 *
 * Tools registered:
 *   ue_read_config    — Read a section/key from a UE .ini config file
 *   ue_write_config   — Write a key to a UE .ini config file (with .bak backup)
 *   ue_read_uproject  — Parse a .uproject file
 *   ue_list_plugins   — List plugins enabled in a .uproject file
 *
 * @param server  The McpServer instance to register tools on.
 */
export function registerConfigTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // ue_read_config
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_config',
    {
      title: 'Read UE Config',
      description:
        'Read a value or section from a UE .ini configuration file (DefaultEngine.ini, DefaultGame.ini, etc.).',
      inputSchema: z.object({
        config_file: z.string().describe('Absolute path to the .ini config file'),
        section: z.string().optional().describe('The [Section] to read (optional — omit to list all sections)'),
        key: z.string().optional().describe('The key to read within the section (optional — omit to list all keys in section)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_config', async (args) => {
      // 1. Validate path — throws on traversal; withKnownIssues catches → isError
      const resolvedPath = validatePath(args.config_file, PROJECT_ROOT);

      // 2. Read file — ENOENT returns isError (not a throw caught by middleware)
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf8');
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return {
            isError: true,
            content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
          };
        }
        throw err; // unexpected — let withKnownIssues catch it
      }

      // 3. Parse
      const parsed = parseIni(content);
      const fileName = path.basename(resolvedPath);

      // 4. No section: list all section names
      if (!args.section) {
        const sections = Object.keys(parsed);
        const text = sections.length > 0
          ? `Sections in ${fileName}:\n${sections.join('\n')}`
          : `No sections found in ${fileName}`;
        return { content: [{ type: 'text', text }] };
      }

      // 5. Section but no key: return all keys and values in section
      if (!args.key) {
        const section = parsed[args.section];
        if (!section) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Section '[${args.section}]' not found in ${fileName}` }],
          };
        }
        const lines = Object.entries(section).map(
          ([k, vals]) => `${k}=${vals.join(', ')}`
        );
        const text = lines.length > 0
          ? `[${args.section}] in ${fileName}:\n${lines.join('\n')}`
          : `[${args.section}] exists but has no keys in ${fileName}`;
        return { content: [{ type: 'text', text }] };
      }

      // 6. Section and key: return value(s)
      const section = parsed[args.section];
      if (!section) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Section '[${args.section}]' not found in ${fileName}` }],
        };
      }
      const values = section[args.key];
      if (!values || values.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Key '${args.key}' not found in section '[${args.section}]' in ${fileName}` }],
        };
      }
      const text = values.length === 1
        ? values[0]!
        : values.join('\n');
      return { content: [{ type: 'text', text }] };
    })
  );

  // --------------------------------------------------------------------------
  // ue_write_config
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_write_config',
    {
      title: 'Write UE Config',
      description:
        'Write a key=value pair to a UE .ini configuration file. Creates the section and key if they do not exist. ' +
        'Do not write to Saved/Config/ — those files are managed by the editor and will be overwritten at next launch.',
      inputSchema: z.object({
        config_file: z.string().describe('Absolute path to the .ini config file'),
        section: z.string().describe('The [Section] to write to'),
        key: z.string().describe('The key to set'),
        value: z.string().describe('The value to write'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_write_config', async (args) => {
      // 1. Validate path — throws on traversal
      const resolvedPath = validatePath(args.config_file, PROJECT_ROOT);

      // 2. Read existing content — ENOENT → empty string (new file)
      let currentContent = '';
      try {
        currentContent = await fs.readFile(resolvedPath, 'utf8');
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
        // ENOENT: new file — proceed with empty content
      }

      // 3. Backup before modifying — skip if new file (ENOENT on copy)
      try {
        await fs.copyFile(resolvedPath, resolvedPath + '.bak');
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
        // ENOENT: new file, nothing to back up — continue
      }

      // 4. Ensure parent directory exists for new files
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

      // 5. Compute new content and write
      const newContent = setIniValue(currentContent, args.section, args.key, args.value);
      await fs.writeFile(resolvedPath, newContent, 'utf8');

      return {
        content: [{ type: 'text', text: `Written: [${args.section}] ${args.key}=${args.value}` }],
      };
    })
  );

  // --------------------------------------------------------------------------
  // ue_read_uproject
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_read_uproject',
    {
      title: 'Read UE Project File',
      description:
        'Parse a .uproject JSON file and return its contents (engine version, plugins, modules, etc.).',
      inputSchema: z.object({
        uproject_path: z.string().describe('Absolute path to the .uproject file'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_read_uproject', async (args) => {
      // 1. Validate path
      const resolvedPath = validatePath(args.uproject_path, PROJECT_ROOT);

      // 2. Read file
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf8');
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return {
            isError: true,
            content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
          };
        }
        throw err;
      }

      // 3. Parse with Zod-validated parser
      const result = parseUproject(content);
      if (!result.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
        };
      }

      // 4. Format response
      const data = result.data;
      const engineAssoc = data.EngineAssociation ?? 'not specified';
      const modules = data.Modules ?? [];
      const plugins = data.Plugins ?? [];

      const moduleList = modules.length > 0
        ? modules.map((m) => `${m.Name} [${m.Type}]`).join(', ')
        : 'none';
      const pluginList = plugins.length > 0
        ? plugins.map((p) => `${p.Name} [${p.Enabled ? 'enabled' : 'disabled'}]`).join(', ')
        : 'none';

      const text = [
        `Engine Association: ${engineAssoc}`,
        `Modules (${modules.length}): ${moduleList}`,
        `Plugins (${plugins.length}): ${pluginList}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    })
  );

  // --------------------------------------------------------------------------
  // ue_list_plugins
  // --------------------------------------------------------------------------
  server.registerTool(
    'ue_list_plugins',
    {
      title: 'List UE Plugins',
      description:
        'List all plugins enabled in a .uproject file, including engine plugins and project-local plugins.',
      inputSchema: z.object({
        uproject_path: z.string().describe('Absolute path to the .uproject file'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    withKnownIssues('ue_list_plugins', async (args) => {
      // 1. Validate path
      const resolvedPath = validatePath(args.uproject_path, PROJECT_ROOT);

      // 2. Read file
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf8');
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return {
            isError: true,
            content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
          };
        }
        throw err;
      }

      // 3. Parse .uproject
      const result = parseUproject(content);
      if (!result.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
        };
      }

      // 4. For each plugin, try to resolve its .uplugin file
      const plugins = result.data.Plugins ?? [];
      const uprojectDir = path.dirname(resolvedPath);

      const lines: string[] = [];
      for (const plugin of plugins) {
        const status = plugin.Enabled ? 'enabled' : 'disabled';
        const upluginPath = path.join(uprojectDir, 'Plugins', plugin.Name, `${plugin.Name}.uplugin`);

        let depInfo: string;
        try {
          const upluginContent = await fs.readFile(upluginPath, 'utf8');
          const upluginResult = parseUplugin(upluginContent);
          if (upluginResult.success) {
            const deps = upluginResult.data.Plugins ?? [];
            depInfo = deps.length > 0
              ? `dependencies: [${deps.map((d) => d.Name).join(', ')}]`
              : 'dependencies: none';
          } else {
            depInfo = `dependencies: unknown (parse error: ${upluginResult.error})`;
          }
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            depInfo = 'Engine plugin — .uplugin not accessible without engine root';
          } else {
            throw err;
          }
        }

        lines.push(`[${status}] ${plugin.Name} — ${depInfo}`);
      }

      const text = lines.length > 0
        ? lines.join('\n')
        : 'No plugins found in .uproject file';

      return { content: [{ type: 'text', text }] };
    })
  );
}
