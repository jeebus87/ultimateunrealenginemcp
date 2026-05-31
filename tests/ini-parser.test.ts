// Unit tests for the UE-aware INI parser.
// Covers: all five UE operators (=, +, -, ., !), comment handling,
// section merging, indexed array syntax, struct/compound values,
// setIniValue, and writeIniRemoveKey.
//
// Import uses .js extension — NodeNext ESM module resolution.

import { parseIni, setIniValue, writeIniRemoveKey } from '../src/parsers/ini-parser.js';

// ---------------------------------------------------------------------------
// parseIni — section detection
// ---------------------------------------------------------------------------

describe('parseIni — section detection', () => {
  it('parses a single [Section] and returns section name as key in result', () => {
    const content = '[MySection]\nKey=Value';
    const result = parseIni(content);
    expect(Object.keys(result)).toContain('MySection');
  });

  it('multiple [Section] headers with same name merge all key-value pairs', () => {
    const content = '[MySection]\nKey1=A\n[MySection]\nKey2=B';
    const result = parseIni(content);
    expect(result['MySection']?.['Key1']).toEqual(['A']);
    expect(result['MySection']?.['Key2']).toEqual(['B']);
  });

  it('section names are preserved exactly (case-sensitive)', () => {
    const content = '[/Script/Engine.CollisionProfile]\nKey=Val\n[/script/engine.collisionprofile]\nOther=Val2';
    const result = parseIni(content);
    expect(Object.keys(result)).toContain('/Script/Engine.CollisionProfile');
    expect(Object.keys(result)).toContain('/script/engine.collisionprofile');
    expect(Object.keys(result)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseIni — plain = operator
// ---------------------------------------------------------------------------

describe('parseIni — plain = operator', () => {
  it('plain Key=Value stored as single-element array', () => {
    const content = '[Sec]\nKey=Hello';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['Hello']);
  });

  it('last occurrence wins: two lines produce ["second"]', () => {
    const content = '[Sec]\nKey=first\nKey=second';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['second']);
  });

  it('value after = is preserved verbatim including spaces and semicolons mid-value', () => {
    const content = '[Sec]\nKey=value;with;semicolons and spaces';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['value;with;semicolons and spaces']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — + operator
// ---------------------------------------------------------------------------

describe('parseIni — + operator', () => {
  it('+Key=Value appends value if not already in array', () => {
    const content = '[Sec]\n+Key=Apple\n+Key=Banana';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['Apple', 'Banana']);
  });

  it('+Key=Value does NOT add duplicate: two "+Key=same" lines → ["same"]', () => {
    const content = '[Sec]\n+Key=same\n+Key=same';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['same']);
  });

  it('+Key=Value after plain Key=existing appends: ["existing", "new"]', () => {
    const content = '[Sec]\nKey=existing\n+Key=new';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['existing', 'new']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — . operator
// ---------------------------------------------------------------------------

describe('parseIni — . operator', () => {
  it('.Key=Value always appends, duplicates allowed', () => {
    const content = '[Sec]\n.Key=alpha';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['alpha']);
  });

  it('two ".Key=same" lines → ["same", "same"]', () => {
    const content = '[Sec]\n.Key=same\n.Key=same';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['same', 'same']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — - operator
// ---------------------------------------------------------------------------

describe('parseIni — - operator', () => {
  it('-Key=Value removes exact match from existing array', () => {
    const content = '[Sec]\n+Key=apple\n+Key=banana\n-Key=apple';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['banana']);
  });

  it('-Key=Value on non-existent key is a no-op (no crash)', () => {
    const content = '[Sec]\n-Key=ghost';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual([]);
  });

  it('multiple +Key=a, +Key=b, -Key=a → ["b"]', () => {
    const content = '[Sec]\n+Key=a\n+Key=b\n-Key=a';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — ! operator
// ---------------------------------------------------------------------------

describe('parseIni — ! operator', () => {
  it('!Key=anything clears all values for Key (value after = is ignored)', () => {
    const content = '[Sec]\n+Key=one\n+Key=two\n!Key=ClearArray';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual([]);
  });

  it('!Key followed by +Key=new → ["new"] (clear then append works)', () => {
    const content = '[Sec]\n+Key=old\n!Key=whatever\n+Key=new';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['new']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — comment handling
// ---------------------------------------------------------------------------

describe('parseIni — comment handling', () => {
  it('lines where ; is first non-whitespace character are skipped entirely', () => {
    const content = '[Sec]\n; this is a comment\nKey=Value';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['Value']);
    // Ensure the comment line did not produce a key
    const keys = Object.keys(result['Sec'] ?? {});
    expect(keys).toEqual(['Key']);
  });

  it('mid-line semicolons are NOT stripped: value includes the semicolons', () => {
    const content = '[Sec]\nKey=value;with;semicolons';
    const result = parseIni(content);
    expect(result['Sec']?.['Key']).toEqual(['value;with;semicolons']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — indexed array syntax
// ---------------------------------------------------------------------------

describe('parseIni — indexed array syntax', () => {
  it('MyArray[0]=first stored under literal key "MyArray[0]"', () => {
    const content = '[Sec]\nMyArray[0]=first\nMyArray[1]=second';
    const result = parseIni(content);
    expect(result['Sec']?.['MyArray[0]']).toEqual(['first']);
    expect(result['Sec']?.['MyArray[1]']).toEqual(['second']);
  });
});

// ---------------------------------------------------------------------------
// parseIni — struct / compound values
// ---------------------------------------------------------------------------

describe('parseIni — struct / compound values', () => {
  it('"+Bindings=(Name=\\"Q\\",Command=\\"Foo\\")" stores operator=+, key=Bindings, full parens as value', () => {
    const content = '[Sec]\n+Bindings=(Name="Q",Command="Foo")';
    const result = parseIni(content);
    expect(result['Sec']?.['Bindings']).toEqual(['(Name="Q",Command="Foo")']);
  });
});

// ---------------------------------------------------------------------------
// setIniValue
// ---------------------------------------------------------------------------

describe('setIniValue', () => {
  it('adds key to existing section at end of section block', () => {
    const content = '[MySection]\nExistingKey=ExistingValue';
    const result = setIniValue(content, 'MySection', 'NewKey', 'NewValue');
    expect(result).toContain('[MySection]');
    expect(result).toContain('NewKey=NewValue');
  });

  it('creates new [Section] + key at end of file if section missing', () => {
    const content = '[OtherSection]\nKey=Val';
    const result = setIniValue(content, 'NewSection', 'NewKey', 'NewValue');
    expect(result).toContain('[NewSection]');
    expect(result).toContain('NewKey=NewValue');
  });

  it('replaces existing line "Key=old" with "Key=new" (any operator prefix is replaced with plain =)', () => {
    const content = '[Sec]\n+Key=old';
    const result = setIniValue(content, 'Sec', 'Key', 'new');
    expect(result).toContain('Key=new');
    expect(result).not.toContain('+Key=old');
  });

  it('returns string with \\n line endings', () => {
    const content = '[Sec]\nKey=Val';
    const result = setIniValue(content, 'Sec', 'Key', 'Updated');
    expect(result).toContain('\n');
    // Ensure no Windows-style \r\n
    expect(result).not.toContain('\r\n');
  });
});

// ---------------------------------------------------------------------------
// writeIniRemoveKey
// ---------------------------------------------------------------------------

describe('writeIniRemoveKey', () => {
  it('removes all lines whose bare key matches target key', () => {
    const content = '[Sec]\n+Key=a\n+Key=b\nOther=val';
    const result = writeIniRemoveKey(content, 'Sec', 'Key');
    expect(result).not.toContain('Key=a');
    expect(result).not.toContain('Key=b');
    expect(result).toContain('Other=val');
  });

  it('no-op if section does not exist (returns content unchanged)', () => {
    const content = '[Other]\nKey=val';
    const result = writeIniRemoveKey(content, 'Missing', 'Key');
    expect(result).toBe(content);
  });

  it('no-op if key does not exist in section', () => {
    const content = '[Sec]\nOther=val';
    const result = writeIniRemoveKey(content, 'Sec', 'Key');
    expect(result).toBe(content);
  });

  it('removes lines with any prefix: plain =, +, -, .', () => {
    const content = '[Sec]\nKey=plain\n+Key=plus\n-Key=minus\n.Key=dot';
    const result = writeIniRemoveKey(content, 'Sec', 'Key');
    expect(result).not.toContain('Key=plain');
    expect(result).not.toContain('+Key=plus');
    expect(result).not.toContain('-Key=minus');
    expect(result).not.toContain('.Key=dot');
  });
});
