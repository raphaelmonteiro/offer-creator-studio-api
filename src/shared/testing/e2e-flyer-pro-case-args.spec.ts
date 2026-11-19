import { DEFAULT_CASE_ITEMS, parseCaseArgs } from './e2e-flyer-pro-case-args';

const base = ['create', '--case', 'Estrutura', '--schema-version', '1', '--engine-version', '3'];
const withItems = (items: unknown) => [...base, '--items', JSON.stringify(items)];

describe('parseCaseArgs (comando de teste dos encartes do e2e)', () => {
  it('create com o mínimo: etapa products e os três itens padrão', () => {
    expect(parseCaseArgs(base)).toEqual({
      action: 'create',
      input: {
        caseName: 'Estrutura',
        schemaVersion: 1,
        engineVersion: 3,
        step: 'products',
        items: DEFAULT_CASE_ITEMS,
      },
    });
    expect(DEFAULT_CASE_ITEMS.map((item) => item.unit)).toEqual(['kg', 'cada', 'pct']);
    expect(DEFAULT_CASE_ITEMS[0]).toEqual({ name: 'ABACATE', unit: 'kg', cents: 699 });
  });

  it('create com etapa e itens pedidos', () => {
    const items = [{ name: 'LEITE', unit: 'bdj', cents: 0 }];
    expect(parseCaseArgs([...withItems(items), '--step', 'structure'])).toMatchObject({
      input: { step: 'structure', items },
    });
    expect(parseCaseArgs(withItems([]))).toMatchObject({ input: { items: [] } });
  });

  it('purge não recebe argumentos', () => {
    expect(parseCaseArgs(['purge'])).toEqual({ action: 'purge' });
    expect(() => parseCaseArgs(['purge', '--case', 'x'])).toThrow(/purge não recebe/);
  });

  it.each([
    [[], /Ação desconhecida \(nenhuma\)/],
    [['apagar'], /Ação desconhecida \(apagar\)/],
  ])('ação inválida %j', (argv, message) => {
    expect(() => parseCaseArgs(argv)).toThrow(message);
  });

  it('versão ausente: a mensagem cita o campo, sem padrão', () => {
    const noEngine = ['create', '--case', 'x', '--schema-version', '1'];
    const noSchema = ['create', '--case', 'x', '--engine-version', '1'];
    expect(() => parseCaseArgs(noEngine)).toThrow(/engineVersion ausente/);
    expect(() => parseCaseArgs(noSchema)).toThrow(/schemaVersion ausente/);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '2147483648', '01'])('versão inválida %j', (value) => {
    const argv = ['create', '--case', 'x', '--schema-version', '1', '--engine-version', value];
    expect(() => parseCaseArgs(argv)).toThrow(/engineVersion inválido/);
  });

  it('caso ausente, em branco ou grande demais para o nome do encarte', () => {
    const versions = ['--schema-version', '1', '--engine-version', '1'];
    expect(() => parseCaseArgs(['create', ...versions])).toThrow(/case ausente/);
    expect(() => parseCaseArgs(['create', '--case', '  ', ...versions])).toThrow(/case ausente/);
    expect(() => parseCaseArgs(['create', '--case', 'x'.repeat(100), ...versions])).toThrow(
      /case grande demais/,
    );
    expect(parseCaseArgs(['create', '--case', 'x'.repeat(91), ...versions])).toMatchObject({
      input: { caseName: 'x'.repeat(91) },
    });
  });

  it('etapa fora das oito', () => {
    expect(() => parseCaseArgs([...base, '--step', 'cards'])).toThrow(/step inválido \(cards\)/);
  });

  it.each([
    ['não é JSON', 'abacate', /items deve ser um JSON/],
    ['não é lista', '{}', /items deve ser uma lista/],
    ['item null', '[null]', /items\[0\] deve ser um objeto/],
    ['item lista', '[[]]', /items\[0\] deve ser um objeto/],
    ['sem nome', '[{"unit":"kg","cents":1}]', /items\[0\]\.name/],
    ['nome longo', JSON.stringify([{ name: 'x'.repeat(121), unit: 'kg', cents: 1 }]), /\.name/],
    ['unidade fora', '[{"name":"A","unit":"un","cents":1}]', /items\[0\]\.unit inválida/],
    ['centavos null', '[{"name":"A","unit":"kg","cents":null}]', /items\[0\]\.cents/],
    ['centavos negativos', '[{"name":"A","unit":"kg","cents":-1}]', /items\[0\]\.cents/],
    ['centavos fracionados', '[{"name":"A","unit":"kg","cents":6.99}]', /items\[0\]\.cents/],
    ['segundo item ruim', '[{"name":"A","unit":"kg","cents":1},null]', /items\[1\] deve ser/],
  ])('itens: %s', (_label, raw, message) => {
    expect(() => parseCaseArgs([...base, '--items', raw])).toThrow(message);
  });

  it('flag desconhecida, sem valor ou repetida não passa em silêncio', () => {
    expect(() => parseCaseArgs([...base, '--etapa', 'card'])).toThrow(/Argumento desconhecido/);
    expect(() => parseCaseArgs([...base, '--step'])).toThrow(/--step precisa de um valor/);
    expect(() => parseCaseArgs([...base, '--case', 'outro'])).toThrow(/--case veio duas vezes/);
  });
});
