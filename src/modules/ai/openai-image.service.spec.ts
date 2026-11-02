import { supportsConfigurableInputFidelity } from './openai-image.service';

describe('supportsConfigurableInputFidelity', () => {
  it.each(['gpt-image-1.5', 'gpt-image-1-mini'])('envia input_fidelity para %s', (model) => {
    expect(supportsConfigurableInputFidelity(model)).toBe(true);
  });

  it.each([
    'gpt-image-2',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-flare-2026-09-08',
    'chatgpt-image-latest',
  ])('omite input_fidelity para %s', (model) => {
    expect(supportsConfigurableInputFidelity(model)).toBe(false);
  });
});
