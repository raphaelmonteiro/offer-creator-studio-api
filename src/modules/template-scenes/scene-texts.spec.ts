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

describe('afterImageReply: texto fixo acompanha o veredito (R6)', () => {
  const base = { missing: [], textInImage: false, seam: false, seamDescription: '', changed: '' };

  it('sim com mudou barrado: "O pedido aparece atendido"', () => {
    expect(afterImageReply({ ...base, satisfied: 'sim' })).toBe(
      'Conferi a imagem nova: O pedido aparece atendido.',
    );
  });

  it('parcial com mudou barrado: atendido em parte, sem a frase de atendido', () => {
    const reply = afterImageReply({ ...base, satisfied: 'parcial' });
    expect(reply).toBe(
      'Conferi a imagem nova e o pedido foi atendido em parte. Diga o que ajustar ou peça para voltar.',
    );
    expect(reply).not.toContain('aparece atendido');
  });

  it('nao com mudou barrado: não aparece atendido, e nunca "O pedido aparece atendido"', () => {
    const reply = afterImageReply({ ...base, satisfied: 'nao' });
    expect(reply).toBe(
      'Apliquei a imagem nova, mas na conferência o pedido não aparece atendido. Diga o que ajustar ou use "Voltar para a anterior".',
    );
    expect(reply).not.toContain('O pedido aparece atendido');
  });
});
