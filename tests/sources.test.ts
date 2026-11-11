// M29: where a value comes from after an edit in the settings panel, and which values count as guesses.
import { describe, expect, it } from 'vitest';
import { editedSources, guessedParams, isGuess } from '../src/app/sources.ts';
import type { DesignNode } from '../src/schema/design.ts';

describe('editedSources', () => {
  const before = { concurrency: { evidence: 'estimate' as const, role: 'assumption' as const, from: 'aws_ecs_task_definition.api.cpu' }, instances: { evidence: 'iac' as const, role: 'setting' as const } };
  it('a typed value is the user\'s, "use default" is the default; the role stays, the old from goes', () => {
    const out = editedSources(before, { concurrency: 16, instances: undefined });
    expect(out.concurrency).toEqual({ evidence: 'answer', role: 'assumption' });
    expect(out.instances).toEqual({ evidence: 'loadsketch-default', role: 'setting' });
  });
  it('does not change the input (undo keeps the old source) and leaves other params alone', () => {
    const out = editedSources(before, { concurrency: 16 });
    expect(before.concurrency.evidence).toBe('estimate');
    expect(out.instances).toBe(before.instances);
  });
  it('a param with no source yet gets the importer\'s role: a reset latencyMs is still a guess', () => {
    const out = editedSources({}, { latencyMs: undefined, timeoutMs: undefined });
    expect(out.latencyMs).toEqual({ evidence: 'loadsketch-default', role: 'assumption' });
    expect(isGuess(out.latencyMs)).toBe(true);
    expect(out.timeoutMs).toEqual({ evidence: 'loadsketch-default', role: 'setting' });
  });
  it('a param with no source yet gets one; label and apis are not params', () => {
    expect(editedSources(undefined, { timeoutMs: 500, label: 'x', apis: ['a'] })).toEqual({ timeoutMs: { evidence: 'answer', role: 'setting' } });
  });
});

describe('guesses', () => {
  it('an assumption from our estimate or the kind default is a guess; an IaC value or the user\'s is not', () => {
    expect(isGuess({ evidence: 'estimate', role: 'assumption' })).toBe(true);
    expect(isGuess({ evidence: 'loadsketch-default', role: 'assumption' })).toBe(true);
    expect(isGuess({ evidence: 'answer', role: 'assumption' })).toBe(false);
    expect(isGuess({ evidence: 'loadsketch-default', role: 'setting' })).toBe(false);
    const n: DesignNode = { id: 'a', kind: 'service', pos: [0, 0], source: { from: [], params: { serviceMs: { evidence: 'estimate', role: 'assumption' }, instances: { evidence: 'iac', role: 'setting' } } } };
    expect(guessedParams(n)).toEqual(['serviceMs']);
  });
});
