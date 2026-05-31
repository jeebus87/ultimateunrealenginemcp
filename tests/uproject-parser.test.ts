// Tests for uproject/uplugin JSON parsers
// Implementation: src/parsers/uproject-parser.ts
//
// Strategy: Pure unit tests — no file I/O. All inputs are JSON strings.
// Tests cover schema validation, parse success, and parse failure (structured error returns).

import { parseUproject, parseUplugin, UProjectSchema, UPluginSchema } from '../src/parsers/uproject-parser.js';

// ---------------------------------------------------------------------------
// parseUproject — success cases
// ---------------------------------------------------------------------------

describe('parseUproject — success cases', () => {
  it('parses a minimal valid .uproject with only FileVersion', () => {
    const result = parseUproject(JSON.stringify({ FileVersion: 3 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FileVersion).toBe(3);
    }
  });

  it('parses a full .uproject with Modules and Plugins arrays', () => {
    const input = {
      FileVersion: 3,
      EngineAssociation: '5.7',
      Modules: [
        { Name: 'MyGameModule', Type: 'Runtime', LoadingPhase: 'Default' },
      ],
      Plugins: [
        { Name: 'GameplayAbilities', Enabled: true },
        { Name: 'Paper2D', Enabled: false },
      ],
    };
    const result = parseUproject(JSON.stringify(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Modules).toHaveLength(1);
      expect(result.data.Plugins).toHaveLength(2);
      expect(result.data.Modules![0]!.Name).toBe('MyGameModule');
      expect(result.data.Plugins![0]!.Name).toBe('GameplayAbilities');
      expect(result.data.Plugins![0]!.Enabled).toBe(true);
    }
  });

  it('preserves EngineAssociation as a version string ("5.7")', () => {
    const result = parseUproject(JSON.stringify({ FileVersion: 3, EngineAssociation: '5.7' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EngineAssociation).toBe('5.7');
    }
  });

  it('preserves EngineAssociation as a UUID string (custom engine build)', () => {
    const uuid = '{000438DA-08D8-E173-2322-DD9C4256781A}';
    const result = parseUproject(JSON.stringify({ FileVersion: 3, EngineAssociation: uuid }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EngineAssociation).toBe(uuid);
    }
  });

  it('Plugins array entries have Name (string) and Enabled (boolean)', () => {
    const input = {
      FileVersion: 3,
      Plugins: [
        { Name: 'EnhancedInput', Enabled: true, Optional: false },
        { Name: 'OldPlugin', Enabled: false },
      ],
    };
    const result = parseUproject(JSON.stringify(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.Plugins![0]!.Name).toBe('string');
      expect(typeof result.data.Plugins![0]!.Enabled).toBe('boolean');
    }
  });

  it('Modules array entries have Name (string) and Type (string); LoadingPhase is optional', () => {
    const input = {
      FileVersion: 3,
      Modules: [
        { Name: 'CoreModule', Type: 'Runtime' },
        { Name: 'EditorModule', Type: 'Editor', LoadingPhase: 'PostEngineInit' },
      ],
    };
    const result = parseUproject(JSON.stringify(input));
    expect(result.success).toBe(true);
    if (result.success) {
      const [core, editor] = result.data.Modules!;
      expect(core!.Name).toBe('CoreModule');
      expect(core!.Type).toBe('Runtime');
      expect(core!.LoadingPhase).toBeUndefined();
      expect(editor!.LoadingPhase).toBe('PostEngineInit');
    }
  });
});

// ---------------------------------------------------------------------------
// parseUproject — failure cases
// ---------------------------------------------------------------------------

describe('parseUproject — failure cases', () => {
  it('returns failure for invalid JSON string', () => {
    const result = parseUproject('not-json{{{');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.toLowerCase()).toMatch(/json/);
    }
  });

  it('returns failure for valid JSON but missing required FileVersion field', () => {
    const result = parseUproject(JSON.stringify({ EngineAssociation: '5.7' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('returns failure when FileVersion is a string instead of integer', () => {
    const result = parseUproject(JSON.stringify({ FileVersion: '3' }));
    expect(result.success).toBe(false);
  });

  it('returns failure when a Plugins array entry is missing the required Name field', () => {
    const input = {
      FileVersion: 3,
      Plugins: [
        { Enabled: true }, // missing Name
      ],
    };
    const result = parseUproject(JSON.stringify(input));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseUplugin — success cases
// ---------------------------------------------------------------------------

describe('parseUplugin — success cases', () => {
  it('parses a minimal valid .uplugin with only FileVersion', () => {
    const result = parseUplugin(JSON.stringify({ FileVersion: 3 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FileVersion).toBe(3);
    }
  });

  it('parses .uplugin with Plugins (dependency) array containing Name and Enabled', () => {
    const input = {
      FileVersion: 3,
      FriendlyName: 'My Plugin',
      Plugins: [
        { Name: 'DependencyA', Enabled: true },
        { Name: 'DependencyB', Enabled: false },
      ],
    };
    const result = parseUplugin(JSON.stringify(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Plugins).toHaveLength(2);
      expect(result.data.Plugins![0]!.Name).toBe('DependencyA');
      expect(result.data.Plugins![0]!.Enabled).toBe(true);
    }
  });

  it('preserves optional FriendlyName, Description, and VersionName when present', () => {
    const input = {
      FileVersion: 3,
      FriendlyName: 'Awesome Plugin',
      Description: 'Does awesome things',
      VersionName: '2.0.0',
    };
    const result = parseUplugin(JSON.stringify(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.FriendlyName).toBe('Awesome Plugin');
      expect(result.data.Description).toBe('Does awesome things');
      expect(result.data.VersionName).toBe('2.0.0');
    }
  });
});

// ---------------------------------------------------------------------------
// parseUplugin — failure cases
// ---------------------------------------------------------------------------

describe('parseUplugin — failure cases', () => {
  it('returns failure for invalid JSON', () => {
    const result = parseUplugin('{bad json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.toLowerCase()).toMatch(/json/);
    }
  });

  it('returns failure when FileVersion is missing', () => {
    const result = parseUplugin(JSON.stringify({ FriendlyName: 'Plugin Without Version' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// UProjectSchema direct validation
// ---------------------------------------------------------------------------

describe('UProjectSchema direct validation', () => {
  it('accepts { FileVersion: 3 } as valid', () => {
    expect(UProjectSchema.safeParse({ FileVersion: 3 }).success).toBe(true);
  });

  it('rejects {} because FileVersion is required', () => {
    expect(UProjectSchema.safeParse({}).success).toBe(false);
  });

  it('accepts { FileVersion: 3, Modules: [] } — empty Modules array is valid', () => {
    expect(UProjectSchema.safeParse({ FileVersion: 3, Modules: [] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UPluginSchema direct validation
// ---------------------------------------------------------------------------

describe('UPluginSchema direct validation', () => {
  it('accepts { FileVersion: 3 } as a valid minimal .uplugin', () => {
    expect(UPluginSchema.safeParse({ FileVersion: 3 }).success).toBe(true);
  });

  it('rejects {} because FileVersion is required', () => {
    expect(UPluginSchema.safeParse({}).success).toBe(false);
  });
});
