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
    missing: '',
    missingAny: false,
    extraText: '',
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
  const base = {
    missing: '',
    missingAny: false,
    extraText: '',
    seam: false,
    seamDescription: '',
    changed: '',
  };

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

describe('afterImageReply: texto pintado e o que falta (D-51)', () => {
  const base = {
    satisfied: 'sim' as const,
    changed: 'A placa apareceu no rodapé.',
    missing: '',
    missingAny: false,
    extraText: '',
    seam: false,
    seamDescription: '',
  };
  const line = (asked: string, read: string) => ({ asked, read, ok: asked === read });

  it('Texto certo: "Conferi o texto letra por letra", uma vez, com as linhas separadas', () => {
    const lines = [line('Oferta de Páscoa', 'Oferta de Páscoa'), line('R$ 9,90', 'R$ 9,90')];
    expect(afterImageReply({ ...base, text: { lines, tried: 1, limited: false } })).toBe(
      'Conferi a imagem nova: A placa apareceu no rodapé. Conferi o texto letra por letra: “Oferta de Páscoa” / “R$ 9,90”.',
    );
  });

  it('Texto errado duas vezes: o que pediu, o que leu, e a oferta da camada', () => {
    const lines = [line('De R$ 19,90 por R$ 9,90', 'De R$ 19,90 por R$ 9.90')];
    expect(
      afterImageReply({ ...base, satisfied: 'parcial', text: { lines, tried: 2, limited: false } }),
    ).toContain(
      'O texto na imagem saiu diferente do pedido. Pedi “De R$ 19,90 por R$ 9,90” e li “De R$ 19,90 por R$ 9.90”. Tentei duas vezes. Posso tentar de novo, ou colocar a frase como camada de texto exata.',
    );
  });

  it('Texto não encontrado: lido vazio vira "Não encontrei na imagem o texto"', () => {
    const lines = [line('Promoção de Páscoa', '')];
    expect(afterImageReply({ ...base, text: { lines, tried: 2, limited: false } })).toContain(
      'Não encontrei na imagem o texto “Promoção de Páscoa”. Tentei duas vezes.',
    );
  });

  it('Limite impede a refação: diz que tentou uma vez e que atingiu o limite', () => {
    const lines = [line('Promoção de Páscoa', 'Promocao de Pascoa')];
    expect(afterImageReply({ ...base, text: { lines, tried: 1, limited: true } })).toContain(
      'Tentei uma vez e não refiz porque atingi o limite de chamadas deste pedido.',
    );
  });

  it('Juiz indisponível com texto pedido: não conseguiu conferir o texto', () => {
    expect(afterImageReply(null, { textAsked: true })).toBe(
      'Apliquei a imagem nova, mas não consegui conferir o resultado. Veja se ficou como pediu. Não consegui conferir o texto; veja se ficou como pediu.',
    );
    expect(afterImageReply(null)).not.toContain('o texto');
  });

  it('O que falta não é pedaço da mensagem: "Ainda falta: {faltou}." ou o texto fixo', () => {
    expect(
      afterImageReply({ ...base, missing: 'a frase “Promoção de Páscoa” na placa.' }),
    ).toContain('Ainda falta: a frase “Promoção de Páscoa” na placa.');
    expect(afterImageReply({ ...base, missingAny: true })).toContain(
      'Ainda falta parte do que você pediu.',
    );
    expect(afterImageReply(base)).not.toContain('Ainda');
    expect(afterImageReply({ ...base, missing: 'x' })).not.toContain('Ainda não vi na imagem');
  });

  it('Uma mudança por rodada: item aberto da mesma mensagem vira pergunta', () => {
    expect(afterImageReply({ ...base, pendingItem: 'placa com “Oferta”' })).toContain(
      'Ainda falta: placa com “Oferta”. Quer que eu faça agora?',
    );
  });

  it('Texto que ninguém pediu: relata e oferece tirar', () => {
    expect(afterImageReply({ ...base, extraText: 'PROMO' })).toContain(
      'Vi na imagem um texto que você não pediu: “PROMO”. Diga se quer que eu tire.',
    );
  });
});
