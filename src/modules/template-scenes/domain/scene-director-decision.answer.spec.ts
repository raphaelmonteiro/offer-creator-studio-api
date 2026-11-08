import { directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { decideTurn, DecisionInput, unusableAnswer } from './scene-director-decision';

const decide = (plan: PlanOverrides, extra: Partial<DecisionInput> = {}) =>
  decideTurn({
    plan: directorPlan({ what_to_change: 'tirar o coelho', will_change_image: true, ...plan }),
    marked: false,
    hasImage: true,
    openRequests: [],
    ...extra,
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

describe('decideTurn: anúncio sem ação em outra forma verbal (R33)', () => {
  const answer = (reply: string) =>
    decide({ turn_kind: 'pedido_item', will_change_image: false, reply, what_to_change: '' });
  const FIXED = expect.stringContaining('Não entendi o que mudar');

  it.each([
    'O coelho será removido.',
    'Os ovos serão trocados.',
    'Removerei o coelho.',
    'Farei a troca agora.',
    'Trocarei a cesta e acrescentarei flores.',
    'Apagarei o texto.',
    'Estou removendo o coelho.',
    'Estamos trocando a cesta.',
  ])('anúncio "%s" não vai ao cliente: texto fixo', (reply) => {
    expect(answer(reply)).toEqual({ kind: 'reply', reply: FIXED, aboutImage: false });
  });

  it.each([
    'Estou vendo vários ovos. Qual deles você quer tirar?',
    'Não será possível tirar o que não vejo.',
    'Não removerei o que não existe. Onde ele está?',
    'Não estou vendo uma cerca nesta imagem.',
    'Será que você quer o ovo da cesta ou o do gramado?',
  ])('resposta "%s" não é anúncio e vai ao cliente', (reply) => {
    expect(answer(reply)).toEqual({ kind: 'reply', reply, aboutImage: expect.any(Boolean) });
  });

  // R45: o sufixo -rei não distingue futuro de passado; leitura da imagem com "estou" é resposta
  it.each([
    'Encontrei dois coelhos. Qual deles?',
    'Só encontrei um ovo.',
    'Procurei e não vejo cerca.',
    'Mostrei o que achei: um coelho e uma cesta.',
    'Comparei as duas imagens e não achei a cerca.',
    'Estou enxergando dois ovos. Qual deles?',
    'Estou identificando um coelho e uma cesta; qual você quer tirar?',
    'Estou percebendo só um ovo na cesta.',
  ])('resposta no passado ou leitura "%s" vai ao cliente, sem refazer', (reply) => {
    expect(unusableAnswer(reply)).toBe(false);
    expect(answer(reply)).toEqual({ kind: 'reply', reply, aboutImage: expect.any(Boolean) });
  });
});
