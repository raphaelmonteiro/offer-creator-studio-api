import { buildMock as build, callContext, itemInput } from './flyer-pro-enrich.testutil';

const cerveja = itemInput('CERVEJA PILSEN LATA 350ML', { id: 'cerveja', ean: '7896000000019' });
const refrigerante = itemInput('REFRIGERANTE COLA 2L', { id: 'refri', ean: '7894900011524' });
const abacate = itemInput('ABACATE KG', { id: 'abacate' });
const actions = (verdicts: Array<{ itemId: string; action: string }>) =>
  Object.fromEntries(verdicts.map((v) => [v.itemId, v.action]));

describe('MockFlyerProEnrich: #ia-ean-pendente (D-3 (a))', () => {
  it('na fase de fotos e na primeira passada, os itens com EAN ficam pendentes; sem EAN, o simulado de sempre', async () => {
    const { port } = build();

    for (const pass of [0, 1]) {
      const verdicts = await port.matchImages(
        [cerveja, refrigerante, abacate],
        callContext('Teste #ia-ean-pendente', { pass }),
      );
      expect(actions(verdicts)).toMatchObject({ cerveja: 'pending', refri: 'pending' });
      expect(actions(verdicts).abacate).not.toBe('pending');
    }
  });

  it('na segunda passada o EAN terminado em dígito par recebe a foto do simulado, e o de dígito ímpar segue pendente até o fim', async () => {
    const { port } = build();

    for (const pass of [2, 3]) {
      const verdicts = await port.matchImages(
        [cerveja, refrigerante],
        callContext('Teste #ia-ean-pendente', { pass }),
      );
      expect(actions(verdicts)).toEqual({ cerveja: 'pending', refri: 'apply' });
      expect(verdicts[1]).toMatchObject({
        photo: { width: 600, height: 1200 },
        eanStatus: 'dotcompany',
      });
    }
  });

  it('sem diferença de maiúsculas no nome do encarte', async () => {
    const { port } = build();
    const verdicts = await port.matchImages([cerveja], callContext('TESTE #IA-EAN-PENDENTE'));
    expect(verdicts[0].action).toBe('pending');
  });

  it('sem o marcador: nenhum item fica pendente', async () => {
    const { port } = build();
    const verdicts = await port.matchImages(
      [cerveja, refrigerante, abacate],
      callContext('Ofertas'),
    );
    expect(verdicts.map((v) => v.action)).not.toContain('pending');
  });
});

describe('MockFlyerProEnrich: #ia-sem-nome e #ia-sem-credito (D-3 (a))', () => {
  it('#ia-sem-nome (em maiúsculas): o item sem EAN continua como estava e o lote conta o fato', async () => {
    const { port } = build();
    const context = callContext('Teste #IA-SEM-NOME');

    const [verdict] = await port.matchImages([abacate], context);

    expect(verdict).toEqual({ itemId: 'abacate', action: 'unanswered' });
    expect(context.notes.nameSearchUnavailable).toBe(true);
  });

  it('#ia-sem-nome: nunca "não encontrada"; o item com EAN que o simulado acha segue pelo resultado normal', async () => {
    const { port } = build();
    const many = Array.from({ length: 30 }, (_, index) =>
      itemInput(`PRODUTO ${index}`, { id: `p${index}`, ean: `789600000${index}` }),
    );

    const verdicts = await port.matchImages(many, callContext('Teste #ia-sem-nome'));

    expect(verdicts.map((v) => v.action)).not.toContain('not_found');
    expect(verdicts.map((v) => v.action)).toEqual(
      expect.arrayContaining(['apply', 'review', 'unanswered']),
    );
  });

  it('sem o marcador, o lote não conta a busca por nome indisponível', async () => {
    const { port } = build();
    const context = callContext('Ofertas');
    await port.matchImages([abacate], context);
    expect(context.notes.nameSearchUnavailable).toBe(false);
  });

  it('#ia-sem-credito: os itens com EAN levam budget_blocked e seguem pelo resultado normal; sem EAN, nada muda', async () => {
    const { port } = build();
    const plain = await port.matchImages([cerveja, refrigerante, abacate], callContext('Ofertas'));

    const blocked = await port.matchImages(
      [cerveja, refrigerante, abacate],
      callContext('Teste #ia-sem-credito'),
    );

    expect(blocked.map((v) => v.action)).toEqual(plain.map((v) => v.action));
    expect(blocked[0]).toMatchObject({ eanStatus: 'budget_blocked' });
    expect(blocked[1]).toMatchObject({ eanStatus: 'budget_blocked' });
    expect(blocked[2]).not.toHaveProperty('eanStatus', 'budget_blocked');
  });

  it('os dois marcadores juntos valem os dois', async () => {
    const { port } = build();
    const context = callContext('Teste #ia-sem-nome #ia-sem-credito');

    const verdicts = await port.matchImages([cerveja, abacate], context);

    expect(context.notes.nameSearchUnavailable).toBe(true);
    expect(verdicts[1]).toEqual({ itemId: 'abacate', action: 'unanswered' });
    expect(verdicts[0]).toMatchObject({ eanStatus: 'budget_blocked' });
  });

  it('o marcador de falha continua vencendo: #ia-falha com #ia-ean-pendente falha', async () => {
    const { port } = build();
    await expect(
      port.matchImages([cerveja], callContext('Teste #ia-ean-pendente #ia-falha')),
    ).rejects.toThrow();
  });
});
