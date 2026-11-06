import { directorPlan } from '../testing/scene-director-fixtures';
import { DirectorPlan } from './scene-director-schema';
import { decideTurn, DecisionInput, windowApplies } from './scene-director-decision';

const decide = (plan: Partial<DirectorPlan>, extra: Partial<DecisionInput> = {}) =>
  decideTurn({
    plan: directorPlan({ what_to_change: 'tirar o coelho', will_change_image: true, ...plan }),
    marked: false,
    hasImage: true,
    openRequests: [],
    ...extra,
  });

describe('decideTurn: o efeito vem do tipo e das regras do código', () => {
  it.each(['pedido_item', 'pedido_ajuste_geral', 'pedido_composicao', 'imagem_nova'] as const)(
    '%s com will_change_image verdadeiro chama imagem',
    (kind) => {
      expect(decide({ turn_kind: kind })).toMatchObject({ kind: 'image' });
    },
  );

  it.each(['pergunta', 'agradecimento', 'outro'] as const)(
    '%s responde sem imagem, mesmo se o modelo disser que muda',
    (kind) => {
      expect(decide({ turn_kind: kind, will_change_image: true })).toMatchObject({ kind: 'reply' });
    },
  );

  it('reclamação só chama imagem com ação clara (will_change_image)', () => {
    expect(decide({ turn_kind: 'reclamacao', will_change_image: true })).toMatchObject({
      kind: 'image',
      window: true,
    });
    expect(decide({ turn_kind: 'reclamacao', will_change_image: false })).toMatchObject({
      kind: 'reply',
    });
  });

  it('só a pergunta sobre a imagem é apresentada como leitura', () => {
    expect(decide({ turn_kind: 'pergunta' })).toMatchObject({ aboutImage: true });
    expect(decide({ turn_kind: 'pergunta' }, { hasImage: false })).toMatchObject({
      aboutImage: false,
    });
    expect(decide({ turn_kind: 'agradecimento' })).toMatchObject({ aboutImage: false });
  });

  it('recusa vira recusa, com o tipo de conteúdo pintado', () => {
    expect(decide({ turn_kind: 'recusa_pintado', refusal: 'painted_price' })).toEqual({
      kind: 'refuse',
      refusal: 'painted_price',
    });
    expect(decide({ turn_kind: 'recusa_pintado' })).toEqual({
      kind: 'refuse',
      refusal: 'painted_text',
    });
  });

  it('camada e desfazer: o código executa; sem imagem na cena, respondem que não há imagem', () => {
    const ops = [{ op: 'move' as const, layer: null, text: null, position: null, replace: false }];
    expect(decide({ turn_kind: 'camada', layer_ops: ops })).toMatchObject({ kind: 'layers', ops });
    expect(decide({ turn_kind: 'camada', layer_ops: [] })).toMatchObject({ kind: 'reply' });
    expect(decide({ turn_kind: 'desfazer', undo_target: 3 })).toEqual({ kind: 'undo', target: 3 });
    expect(decide({ turn_kind: 'desfazer' })).toEqual({ kind: 'undo', target: 'previous' });
    expect(decide({ turn_kind: 'camada', layer_ops: ops }, { hasImage: false })).toMatchObject({
      kind: 'reply',
      reply: expect.stringContaining('Ainda não há imagem'),
    });
    expect(decide({ turn_kind: 'desfazer' }, { hasImage: false })).toMatchObject({ kind: 'reply' });
  });

  describe('imagem: operação, janela e marcação', () => {
    it('a primeira imagem e a imagem nova são generate, sem aviso de edição; o resto é redraw', () => {
      expect(decide({ turn_kind: 'pedido_item' }, { hasImage: false })).toMatchObject({
        operation: 'generate',
        isEdit: false,
        window: true,
      });
      expect(decide({ turn_kind: 'imagem_nova' })).toMatchObject({
        operation: 'generate',
        isEdit: false,
      });
      expect(decide({ turn_kind: 'pedido_item' })).toMatchObject({
        operation: 'redraw',
        isEdit: true,
      });
    });

    it('janela: tem em pedido sem marcação, reclamação e imagem nova; não tem em pedido com marcação', () => {
      expect(windowApplies('pedido_item', false)).toBe(true);
      expect(windowApplies('pedido_ajuste_geral', false)).toBe(true);
      expect(windowApplies('pedido_composicao', false)).toBe(true);
      expect(windowApplies('pedido_item', true)).toBe(false);
      expect(windowApplies('pedido_composicao', true)).toBe(false);
      expect(windowApplies('reclamacao', true)).toBe(true);
      expect(windowApplies('reclamacao', false)).toBe(true);
      expect(windowApplies('imagem_nova', true)).toBe(true);
      expect(windowApplies('marcacao_sem_pedido', true)).toBe(false);
    });

    it('imagem nova com marcação descarta a marcação', () => {
      expect(decide({ turn_kind: 'imagem_nova' }, { marked: true })).toMatchObject({
        discardMarking: true,
      });
      expect(decide({ turn_kind: 'imagem_nova' }, { marked: false })).toMatchObject({
        discardMarking: false,
      });
      expect(decide({ turn_kind: 'pedido_item' }, { marked: true })).toMatchObject({
        discardMarking: false,
        window: false,
      });
    });
  });

  describe('"marquei"', () => {
    const OPEN = ['coloca ovos no rodapé.'];

    it('sem marcação ou sem pedido em aberto é pergunta', () => {
      expect(
        decide(
          { turn_kind: 'marcacao_sem_pedido', will_change_image: true },
          { marked: false, openRequests: OPEN },
        ),
      ).toMatchObject({ kind: 'reply' });
      expect(
        decide({ turn_kind: 'marcacao_sem_pedido', will_change_image: true }, { marked: true }),
      ).toMatchObject({ kind: 'reply' });
    });

    it('com marcação e pedido em aberto executa o pedido, sem janela, com a instrução do próprio plano', () => {
      const result = decide(
        {
          turn_kind: 'marcacao_sem_pedido',
          will_change_image: true,
          what_to_change: 'colocar ovos',
          reply: 'Vou colocar os ovos.',
        },
        { marked: true, openRequests: OPEN },
      );
      expect(result).toMatchObject({
        kind: 'image',
        window: false,
        announcement: 'Vou colocar os ovos.',
      });
      expect(result).not.toHaveProperty('planPatch');
    });

    it('plano sem instrução (o Diretor só perguntou): o código monta a instrução e o anúncio dos pedidos em aberto', () => {
      const result = decide(
        {
          turn_kind: 'marcacao_sem_pedido',
          will_change_image: false,
          what_to_change: '',
          reply: 'O que você quer fazer aí?',
        },
        { marked: true, openRequests: ['coloca ovos no rodapé.', 'um rio no meio'] },
      );
      expect(result).toMatchObject({
        kind: 'image',
        window: false,
        announcement:
          'Vou fazer na área marcada o que você pediu antes: coloca ovos no rodapé; um rio no meio.',
        planPatch: {
          will_change_image: true,
          what_to_change: 'coloca ovos no rodapé; um rio no meio',
        },
      });
    });

    it('a instrução montada respeita os limites do schema e do anúncio', () => {
      const long = ['x'.repeat(500)];
      const result = decide(
        { turn_kind: 'marcacao_sem_pedido', will_change_image: false },
        { marked: true, openRequests: long },
      );
      if (result.kind !== 'image') throw new Error('esperava imagem');
      expect(result.planPatch?.what_to_change.length).toBeLessThanOrEqual(400);
      expect(result.announcement.length).toBeLessThanOrEqual(260);
    });
  });

  it('o reply do Diretor que promete preservação é trocado pelo texto fixo no anúncio', () => {
    expect(
      decide({ turn_kind: 'pedido_item', reply: 'Pronto, removi o coelho e nada mais mudou' }),
    ).toMatchObject({ announcement: 'Vou fazer a mudança que você pediu.' });
  });
});

describe('decideTurn: plano sem instrução (G2, R5)', () => {
  it.each(['pedido_item', 'pedido_ajuste_geral', 'pedido_composicao', 'imagem_nova'] as const)(
    '%s com os dois campos vazios pergunta o que mudar, sem imagem',
    (kind) => {
      expect(decide({ turn_kind: kind, what_to_change: '', what_to_put: '' })).toMatchObject({
        kind: 'reply',
        aboutImage: false,
        reply: expect.stringContaining('Não entendi o que mudar'),
      });
    },
  );

  it('reclamação com will_change_image e sem instrução também pergunta', () => {
    expect(
      decide({ turn_kind: 'reclamacao', will_change_image: true, what_to_change: '' }),
    ).toMatchObject({ kind: 'reply' });
  });

  it('o "marquei" com pedido em aberto monta a instrução e segue para a imagem', () => {
    expect(
      decide(
        { turn_kind: 'marcacao_sem_pedido', what_to_change: '' },
        { marked: true, openRequests: ['um rio'] },
      ),
    ).toMatchObject({ kind: 'image' });
  });

  it('só o what_to_put preenchido basta', () => {
    expect(
      decide({ turn_kind: 'imagem_nova', what_to_change: '', what_to_put: 'um campo' }),
    ).toMatchObject({ kind: 'image' });
  });
});

describe('decideTurn: o Diretor responde em vez de pedir imagem (validação 8, task 1.41)', () => {
  const KINDS = [
    'pedido_item',
    'pedido_ajuste_geral',
    'pedido_composicao',
    'imagem_nova',
    'reclamacao',
  ] as const;
  const ANSWER = 'Não vejo uma cerca na imagem. Onde ela está?';

  it.each(KINDS)(
    'Diretor não vê o objeto (%s): a resposta vai como leitura, sem imagem',
    (kind) => {
      expect(
        decide({ turn_kind: kind, will_change_image: false, reply: ANSWER, what_to_change: '' }),
      ).toEqual({ kind: 'reply', reply: ANSWER, aboutImage: true });
    },
  );

  it('numa cena sem imagem, a resposta vai sem o prefixo de leitura', () => {
    expect(
      decide(
        { turn_kind: 'imagem_nova', will_change_image: false, reply: 'Qual tema você quer?' },
        { hasImage: false },
      ),
    ).toEqual({ kind: 'reply', reply: 'Qual tema você quer?', aboutImage: false });
  });

  it.each(KINDS)(
    'Plano diz que não muda, mas traz instrução (%s): will_change_image falso é respeitado, sem imagem',
    (kind) => {
      expect(
        decide({
          turn_kind: kind,
          will_change_image: false,
          reply: 'Não vejo o preço. Onde ele está?',
          what_to_change: 'remover o preço',
          what_to_put: 'campo limpo',
        }),
      ).toMatchObject({ kind: 'reply', aboutImage: true });
    },
  );

  it.each([
    ['vazia', ''],
    ['anúncio com "vou"', 'Vou tirar a cerca.'],
    ['anúncio com "irei"', 'Irei remover o título.'],
  ])('Anúncio sem ação (%s): sem resposta que sirva, o texto fixo, sem prefixo', (_name, reply) => {
    expect(decide({ turn_kind: 'pedido_item', will_change_image: false, reply })).toEqual({
      kind: 'reply',
      reply: expect.stringContaining('Não entendi o que mudar'),
      aboutImage: false,
    });
  });

  it('"não vou conseguir" não é anúncio: a resposta vale', () => {
    const reply = 'Não vou conseguir tirar o que não vejo. Pode marcar a área?';
    expect(decide({ turn_kind: 'pedido_item', will_change_image: false, reply })).toEqual({
      kind: 'reply',
      reply,
      aboutImage: true,
    });
  });

  it.each(['Pronto, removi a cerca.', 'Tudo o resto ficou igual.', 'O resto continua intacto.'])(
    'Resposta barrada sem instrução: "%s" cai no texto fixo, sem prefixo',
    (reply) => {
      expect(
        decide({ turn_kind: 'pedido_item', will_change_image: false, reply, what_to_change: '' }),
      ).toEqual({
        kind: 'reply',
        reply: expect.stringContaining('Não entendi o que mudar'),
        aboutImage: false,
      });
    },
  );

  it('o "marquei" é a exceção: executa o pedido em aberto mesmo com will_change_image falso', () => {
    expect(
      decide(
        { turn_kind: 'marcacao_sem_pedido', will_change_image: false, what_to_change: '' },
        { marked: true, openRequests: ['tirar a cerca'] },
      ),
    ).toMatchObject({ kind: 'image' });
  });
});

describe('decideTurn: o prefixo de leitura só vai quando a primeira frase afirma (task 1.42)', () => {
  const answer = (reply: string, kind: 'pedido_item' | 'pergunta' = 'pedido_item') =>
    decide({ turn_kind: kind, will_change_image: false, reply, what_to_change: '' });

  it('Resposta que só pergunta: sai sem o prefixo', () => {
    expect(answer('Qual canto você quer deixar livre?')).toEqual({
      kind: 'reply',
      reply: 'Qual canto você quer deixar livre?',
      aboutImage: false,
    });
  });

  it('Afirmação seguida de pergunta: a primeira frase afirma, então o prefixo vai', () => {
    expect(answer('Não vejo uma cerca nesta imagem. Onde coloco a árvore?')).toEqual({
      kind: 'reply',
      reply: 'Não vejo uma cerca nesta imagem. Onde coloco a árvore?',
      aboutImage: true,
    });
  });

  it('pergunta sobre a imagem que só pergunta também sai sem o prefixo, e a que afirma leva', () => {
    expect(answer('Quer saber de qual deles?', 'pergunta')).toMatchObject({ aboutImage: false });
    expect(answer('Há 3 coelhos.', 'pergunta')).toMatchObject({ aboutImage: true });
  });

  it('Texto fixo sem prefixo: pergunta sobre a imagem com o reply barrado cai no texto fixo, sem prefixo', () => {
    expect(answer('Pronto, o resto ficou igual.', 'pergunta')).toEqual({
      kind: 'reply',
      reply: expect.stringContaining('Não consegui formular uma resposta confiável'),
      aboutImage: false,
    });
  });

  it('pergunta com o reply vazio também cai no texto fixo, sem prefixo', () => {
    expect(answer('', 'pergunta')).toMatchObject({ aboutImage: false });
  });
});
