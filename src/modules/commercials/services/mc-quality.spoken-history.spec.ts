import { McScript } from '../domain/mc-types';
import { spokenTextHistory } from './mc-quality.service';

/** Spec video-talking-art "Edição do texto": a versão anterior do texto falado fica registrada. */
describe('spokenTextHistory — histórico do texto falado no evento script_updated', () => {
  const base = (over: Partial<McScript> = {}): McScript =>
    ({
      schemaVersion: 2,
      version: 1,
      format: 'talking_art',
      narration: 'Olá! Arroz Tio João por vinte e quatro e noventa. Venha conferir!',
      scenes: [
        { sceneId: 's1', idx: 0, sceneType: 'talk_tile', dialogue: 'Olá!' },
        {
          sceneId: 's2',
          idx: 1,
          sceneType: 'talk_tile',
          dialogue: 'Arroz por vinte e quatro e noventa.',
        },
      ],
      ...over,
    }) as unknown as McScript;

  it('narração e uma fala editadas → guarda a narração anterior e só a fala que mudou', () => {
    const previous = base();
    const next = base({
      narration: 'Bom dia! Arroz por vinte e três e noventa.',
      scenes: [
        { sceneId: 's1', idx: 0, sceneType: 'talk_tile', dialogue: 'Olá!' },
        {
          sceneId: 's2',
          idx: 1,
          sceneType: 'talk_tile',
          dialogue: 'Arroz por vinte e três e noventa.',
        },
      ] as McScript['scenes'],
    });
    expect(spokenTextHistory(previous, next)).toEqual({
      previousNarration: previous.narration,
      previousDialogues: [{ sceneId: 's2', dialogue: 'Arroz por vinte e quatro e noventa.' }],
    });
  });

  it('nada falado mudou (só janela/cor) → nenhum histórico', () => {
    const previous = base();
    const next = base({ talkBackgroundColor: '#ABCDEF' } as Partial<McScript>);
    expect(spokenTextHistory(previous, next)).toEqual({});
  });

  it('fala removida conta como alterada; roteiro anterior ausente → vazio', () => {
    const previous = base();
    const next = base({ scenes: [previous.scenes[0]] as McScript['scenes'] });
    expect(spokenTextHistory(previous, next).previousDialogues).toEqual([
      { sceneId: 's2', dialogue: 'Arroz por vinte e quatro e noventa.' },
    ]);
    expect(spokenTextHistory(null, next)).toEqual({});
  });
});
