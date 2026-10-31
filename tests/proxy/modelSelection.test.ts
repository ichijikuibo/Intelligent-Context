import { describe, expect, it } from 'vitest';
import { normalizeRequestedModelSelection } from '../../src/proxy/modelSelection';

describe('normalizeRequestedModelSelection', () => {
  it('strips the provider UUID prefix from provider-scoped model IDs', () => {
    expect(
      normalizeRequestedModelSelection(
        '123e4567-e89b-42d3-a456-426614174000:gpt-4.1-mini'
      )
    ).toEqual({
      model: 'gpt-4.1-mini',
      providerIdHint: '123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('treats a bare provider UUID as a provider hint with no explicit model', () => {
    expect(
      normalizeRequestedModelSelection('123e4567-e89b-42d3-a456-426614174000')
    ).toEqual({
      model: '',
      providerIdHint: '123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('strips an uppercase short provider prefix from provider-scoped model IDs', () => {
    expect(normalizeRequestedModelSelection('OC-gpt-4.1-mini')).toEqual({
      model: 'gpt-4.1-mini',
      providerIdHint: 'OC',
    });
  });

  it('treats a bare uppercase short provider prefix as a provider hint', () => {
    expect(normalizeRequestedModelSelection('ANTH')).toEqual({
      model: '',
      providerIdHint: 'ANTH',
    });
  });

  it('leaves ordinary model IDs unchanged', () => {
    expect(normalizeRequestedModelSelection('anthropic.claude-3-5-sonnet-v2:0')).toEqual({
      model: 'anthropic.claude-3-5-sonnet-v2:0',
    });
  });
});