import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import {
  MC_CLIP_TEXT_ERROR_CODE,
  classifyMcError,
  mcRefundsOnTerminal,
  mcShouldRetry,
} from './mc-error-classes';

/** Classe `quality` (24/09): clipe com texto inventado → nova geração, até 3 execuções. */
describe('classe de erro quality (inspeção do clipe)', () => {
  it('erro terminal com código clip_text_detected classifica como quality', () => {
    expect(classifyMcError(new TerminalProviderError('texto', MC_CLIP_TEXT_ERROR_CODE))).toBe(
      'quality',
    );
  });

  it('regera até 3 execuções e depois para (o ingest aceita o clipe)', () => {
    expect(mcShouldRetry('quality', 1)).toBe(true);
    expect(mcShouldRetry('quality', 2)).toBe(true);
    expect(mcShouldRetry('quality', 3)).toBe(false);
    expect(mcRefundsOnTerminal('quality')).toBe(true);
  });
});
