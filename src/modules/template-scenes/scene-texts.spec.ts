import { SCENE_FAILURE_CODES } from './domain/scene.types';
import { afterImageReply, failureReply } from './scene-texts';

describe('scene-texts', () => {
  it.each(SCENE_FAILURE_CODES)('há mensagem em pt-BR para %s', (code) => {
    const reply = failureReply(code);
    expect(reply.length).toBeGreaterThan(10);
    expect(reply).not.toContain(code);
  });

  it('a falta de saldo pede para avisar o administrador', () => {
    expect(failureReply('PROVIDER_QUOTA')).toContain('sem saldo');
    expect(failureReply('PROVIDER_QUOTA')).toContain('administrador');
  });

  it('a política de conteúdo pede outra descrição', () => {
    expect(failureReply('PROVIDER_CONTENT_POLICY')).toContain('Descreva a cena de outro jeito');
  });
});

describe('afterImageReply: emenda (D-44)', () => {
  const facts = {
    satisfied: 'sim' as const,
    changed: 'O sol mudou.',
    missing: [],
    textInImage: false,
  };

  it('com emenda e descrição: o aviso leva a descrição', () => {
    expect(
      afterImageReply({ ...facts, seam: true, seamDescription: 'faixa de grama flutuando.' }),
    ).toBe(
      'Conferi a imagem nova: O sol mudou. Na conferência, vi o que parece uma emenda ou um objeto flutuando: faixa de grama flutuando. Diga o que ajustar ou peça para voltar.',
    );
  });

  it('com emenda sem descrição: o aviso sai sem ela', () => {
    expect(afterImageReply({ ...facts, seam: true, seamDescription: '' })).toBe(
      'Conferi a imagem nova: O sol mudou. Na conferência, vi o que parece uma emenda ou um objeto flutuando. Diga o que ajustar ou peça para voltar.',
    );
  });

  it('sem emenda: nada é dito, nunca "sem emenda" (G8)', () => {
    const reply = afterImageReply({ ...facts, seam: false, seamDescription: '' });
    expect(reply).toBe('Conferi a imagem nova: O sol mudou.');
  });
});
