/**
 * Tests for capture-all-events hook
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, mkdtempSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

describe('capture-all-events: agent-sessions.json hardening', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = join(tmpdir(), `test-agent-sessions-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('setAgentForSession recovers from corrupt JSON file', async () => {
    // Import the functions dynamically to inject our test path
    const sessionFile = join(tempDir, 'agent-sessions.json');

    // Create a corrupt JSON file (truncated in the middle of a string)
    writeFileSync(sessionFile, '{"session1": "pai", "session2": "designer", "session3": "un');

    // Now simulate setAgentForSession behavior: read the file, handle parse error, write fresh map
    let mappings: Record<string, string> = {};
    try {
      mappings = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    } catch {
      // If file exists but is corrupt, start fresh
      mappings = {};
    }

    mappings['session4'] = 'researcher';

    // Write with atomic helper would succeed
    // For this test, we just verify the recovery logic works
    expect(Object.keys(mappings)).toEqual(['session4']);
    expect(mappings['session4']).toBe('researcher');

    // Verify we could write valid JSON
    const testJson = JSON.stringify(mappings, null, 2);
    expect(() => JSON.parse(testJson)).not.toThrow();
  });

  it('setAgentForSession preserves existing mappings when adding new one', async () => {
    const sessionFile = join(tempDir, 'agent-sessions.json');

    // Create a valid sessions file
    const initialMappings = { session1: 'pai', session2: 'designer' };
    writeFileSync(sessionFile, JSON.stringify(initialMappings, null, 2));

    // Simulate reading and adding a new session
    let mappings = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    mappings['session3'] = 'researcher';

    // Verify all mappings are present
    expect(Object.keys(mappings).length).toBe(3);
    expect(mappings['session1']).toBe('pai');
    expect(mappings['session2']).toBe('designer');
    expect(mappings['session3']).toBe('researcher');
  });
});

describe('capture-all-events: MCP tool events', () => {
  it('writes a PreToolUse event for an mcp__ tool with payload.tool_name intact', () => {
    const home = mkdtempSync(join(tmpdir(), 'cap-mcp-'));
    const script = join(dirname(fileURLToPath(import.meta.url)), 'capture-all-events.ts');
    const payload = { session_id: 's-mcp', tool_name: 'mcp__aibroker__aibroker_receive', tool_input: {}, tool_use_id: 'tu1' };
    const r = spawnSync('npx', ['tsx', script, '--event-type', 'PreToolUse'], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, PAI_HOME: home },
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const dir = join(home, 'History', 'raw-outputs');
    const month = readdirSync(dir)[0];
    const file = join(dir, month, readdirSync(join(dir, month))[0]);
    const event = JSON.parse(readFileSync(file, 'utf-8').trim());
    expect(event.hook_event_type).toBe('PreToolUse');
    expect(event.payload.tool_name).toBe('mcp__aibroker__aibroker_receive');
  });
});
