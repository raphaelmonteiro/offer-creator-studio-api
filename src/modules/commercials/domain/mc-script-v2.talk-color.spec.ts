import { fixtureTalkTileScript } from './__fixtures__/mc-script-v2.fixtures';
import {
  compositionFieldsChanged,
  isCompositionOnlyChange,
  talkColorChanged,
} from './mc-script-v2';

/**
 * A cor da janela/painel (`talkBackgroundColor`) é o fundo do tile achatado em
 * cada clipe de fala (hash do `talk`): trocá-la REGRAVA — nunca é "só
 * composição" (mesma regra que `assertCompositionFields` já aplicava ao PATCH
 * /composition; tarefa 5.4 da change video-peca-configuravel alinhou o
 * `updateScript`).
 */
describe('mc-script-v2 — cor da janela não é composição', () => {
  const base = fixtureTalkTileScript({ backgroundColor: '#ABCDEF' });

  it('talkColorChanged: compara sem distinção de caixa; ausente = null', () => {
    expect(talkColorChanged(base, { ...base, talkBackgroundColor: '#abcdef' })).toBe(false);
    expect(talkColorChanged(base, { ...base, talkBackgroundColor: '#000000' })).toBe(true);
    expect(talkColorChanged(fixtureTalkTileScript(), { ...base, talkBackgroundColor: null })).toBe(
      false,
    );
    expect(talkColorChanged(fixtureTalkTileScript(), base)).toBe(true);
  });

  it('só a cor mudou → não é mudança de composição (regrava); janela mudou → é', () => {
    expect(compositionFieldsChanged(base, { ...base, talkBackgroundColor: '#000000' })).toBe(false);
    expect(isCompositionOnlyChange(base, { ...base, talkBackgroundColor: '#000000' })).toBe(false);
    const moved = { ...base, window: { x: 0.5, y: 0.4, w: 0.4, h: 0.2143 } };
    expect(compositionFieldsChanged(base, moved)).toBe(true);
    expect(isCompositionOnlyChange(base, moved)).toBe(true);
    // janela E cor → regrava (a cor vence)
    expect(isCompositionOnlyChange(base, { ...moved, talkBackgroundColor: '#000000' })).toBe(false);
  });
});
