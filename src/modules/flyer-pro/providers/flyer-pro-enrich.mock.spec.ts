import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { FLYER_PRO_CATEGORIES } from '../domain/flyer-pro-categories';
import { CATEGORY_WORDS, SPELLING_FIXES } from './flyer-pro-enrich.mock.words';
import { categoryOfName, correctedName, SLOW_MARKER_MS, stableHash } from './flyer-pro-enrich.mock';
import { buildMock, callContext, galleryPhotos, itemInput } from './flyer-pro-enrich.testutil';

const photos = galleryPhotos;
const build = buildMock;

const item = itemInput;
const context = callContext;
/** O primeiro nome de teste cujo hash cai no resultado pedido (0 aplicada, 1 revisar, 2 não encontrada). */
function nameWithOutcome(outcome: number): string {
  for (let index = 0; ; index += 1) {
    const name = `PRODUTO TESTE ${index}`;
    if (stableHash(name) % 3 === outcome) return name;
  }
}

describe('MockFlyerProEnrich: categorias', () => {
  it('a tabela cobre as 11 categorias da lista fechada, cada uma com ao menos uma palavra', () => {
    expect(Object.keys(CATEGORY_WORDS).sort()).toEqual([...FLYER_PRO_CATEGORIES].sort());
    for (const words of Object.values(CATEGORY_WORDS)) expect(words.length).toBeGreaterThan(0);
  });

  it.each([
    ['CERVEJA PILSEN LATA 350ML', 'Bebidas'],
    ['ABACATE KG', 'Hortifruti'],
    ['SABÃO EM PÓ 1KG', 'Limpeza'],
    ['COXA E SOBRECOXA DE FRANGO', 'Carnes'],
    ['pão francês', 'Padaria'],
  ])('%s vai para %s, pela primeira palavra da tabela', (name, category) => {
    expect(categoryOfName(name)?.category).toBe(category);
  });

  it('item sem categoria com palavra da tabela: aplicar, com motivo [simulado]', async () => {
    const { port } = build();

    const [verdict] = await port.categorize([item('CERVEJA PILSEN LATA 350ML')], context());

    expect(verdict).toMatchObject({ action: 'apply', category: 'Bebidas', confidence: 0.9 });
    expect((verdict as { why: string }).why).toMatch(/^\[simulado\]/);
  });

  it('item sem palavra da tabela: sem sugestão', async () => {
    const { port } = build();

    expect(await port.categorize([item('PRODUTO MISTERIOSO')], context())).toEqual([
      { itemId: 'id-PRODUTO MISTERIOSO', action: 'none' },
    ]);
  });

  it('categoria da planilha diferente da tabela: sugestão; a mesma (sem acento nem caixa): sem sugestão', async () => {
    const { port } = build();
    const imported = (category: string) =>
      item('SABÃO EM PÓ 1KG', { category, categorySource: 'import' });

    const [different] = await port.categorize([imported('Mercearia')], context());
    const [same] = await port.categorize([imported('limpeza')], context());

    expect(different).toMatchObject({ action: 'suggest', category: 'Limpeza' });
    expect(same.action).toBe('none');
  });

  it('o mesmo conteúdo dá o mesmo resultado, em encartes diferentes', async () => {
    const { port } = build();
    const cerveja = item('CERVEJA PILSEN LATA 350ML', { id: 'a' });

    const one = await port.categorize([cerveja], context('Encarte 1'));
    const other = await port.categorize([{ ...cerveja, id: 'a' }], context('Encarte 2'));

    expect(other).toEqual(one);
  });

  it('é uma fase disponível', () => {
    const { port } = build();
    for (const phase of ['categorize', 'spellcheck', 'image_match'] as const) {
      expect(port.isAvailable(phase)).toBe(true);
    }
  });

  it('cada fase declara o modelo "mock" no coletor de uso e uma chamada sem uso: custo desconhecido, nunca zero', async () => {
    const { port } = build();
    const calls = {
      categorize: () => port.categorize([item('ABACATE')], ctx.categorize),
      spellcheck: () => port.spellcheck([item('ABACATE')], ctx.spellcheck),
      image_match: () => port.matchImages([item('ABACATE')], ctx.image_match),
    };
    const ctx = {
      categorize: context(),
      spellcheck: context(),
      image_match: context(),
    };

    for (const [phase, call] of Object.entries(calls)) {
      await call();
      expect(ctx[phase as keyof typeof ctx].usage.snapshot()).toMatchObject({
        model: 'mock',
        calls: 1,
        costUsd: null,
      });
    }
  });
});

describe('MockFlyerProEnrich: ortografia', () => {
  it('grafia conhecida: a sugestão é o nome corrigido', async () => {
    const { port } = build();

    expect(await port.spellcheck([item('FILE DE TILAPIA CONJELADO')], context())).toEqual([
      {
        itemId: 'id-FILE DE TILAPIA CONJELADO',
        action: 'suggest',
        value: 'FILÉ DE TILÁPIA CONGELADO',
      },
    ]);
  });

  it('nome sem grafia da tabela: sem correção', async () => {
    const { port } = build();

    const [verdict] = await port.spellcheck([item('ABACATE KG')], context());

    expect(verdict.action).toBe('clean');
    expect(correctedName('ABACATE KG')).toBeNull();
  });

  it('toda grafia da tabela é corrigida, em qualquer posição e sem diferença de acento', () => {
    for (const [wrong, right] of Object.entries(SPELLING_FIXES)) {
      expect(correctedName(`PRODUTO ${wrong} 1KG`)).toBe(`PRODUTO ${right} 1KG`);
    }
  });
});

describe('MockFlyerProEnrich: fotos', () => {
  it('usa só as 30 primeiras imagens da Galeria', async () => {
    const { port, first } = build();

    await port.matchImages([item(nameWithOutcome(0))], context());

    expect(first).toHaveBeenCalledWith(30);
  });

  it('foto aplicada com a medida do arquivo: a garrafa de 600×1200', async () => {
    const { port, measure } = build();

    const [verdict] = await port.matchImages([item(nameWithOutcome(0))], context());

    expect(verdict).toMatchObject({
      action: 'apply',
      photo: { width: 600, height: 1200, galleryImageId: expect.stringMatching(/^foto-/) },
    });
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('para revisar: até 3 candidatas distintas, a melhor primeiro, com motivo [simulado]', async () => {
    const { port } = build();

    const [verdict] = await port.matchImages([item(nameWithOutcome(1))], context());

    expect(verdict.action).toBe('review');
    const { candidates } = verdict as {
      candidates: Array<{ galleryImageId: string; score: number; reasons: string[] }>;
    };
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((c) => c.galleryImageId)).size).toBe(3);
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
    expect(candidates[0].reasons[0]).toMatch(/^\[simulado\]/);
  });

  it('não encontrada: sem foto', async () => {
    const { port } = build();

    expect((await port.matchImages([item(nameWithOutcome(2))], context()))[0].action).toBe(
      'not_found',
    );
  });

  it('a chave é o nome da planilha, quando há', async () => {
    const { port } = build();
    const sourced = item('QUALQUER NOME', { sourceName: nameWithOutcome(2) });

    expect((await port.matchImages([sourced], context()))[0].action).toBe('not_found');
  });

  it('arquivo que não abre: revisar com a foto como única candidata, nunca aplicada', async () => {
    const { port } = build({ measure: jest.fn(async () => null) });

    const [verdict] = await port.matchImages([item(nameWithOutcome(0))], context());

    expect(verdict.action).toBe('review');
    expect((verdict as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  it('Galeria vazia: os 10 itens ficam não encontrados', async () => {
    const { port, measure } = build({ photos: [] });
    const items = Array.from({ length: 10 }, (_, index) => item(`ITEM ${index}`));

    const verdicts = await port.matchImages(items, context());

    expect(verdicts.map((v) => v.action)).toEqual(Array(10).fill('not_found'));
    expect(measure).not.toHaveBeenCalled();
  });

  it('Galeria com menos de 3 fotos: as candidatas não repetem foto', async () => {
    const { port } = build({ photos: photos.slice(0, 2) });

    const [verdict] = await port.matchImages([item(nameWithOutcome(1))], context());

    expect((verdict as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('os três resultados saem de um lote de itens variados', async () => {
    const { port } = build();
    const items = Array.from({ length: 30 }, (_, index) => item(`PRODUTO ${index}`));

    const actions = new Set((await port.matchImages(items, context())).map((v) => v.action));

    expect(actions).toEqual(new Set(['apply', 'review', 'not_found']));
  });
});

describe('MockFlyerProEnrich: marcadores no nome do encarte (A-16)', () => {
  it('#ia-falha: a fase de fotos falha como transitória; as outras fases respondem', async () => {
    const { port } = build();
    const ctx = context('Teste #ia-falha');

    await expect(port.matchImages([item('A')], ctx)).rejects.toBeInstanceOf(TransientProviderError);
    await expect(port.categorize([item('CERVEJA')], ctx)).resolves.toHaveLength(1);
    await expect(port.spellcheck([item('ABACATE')], ctx)).resolves.toHaveLength(1);
  });

  it('#ia-falha-terminal vence #ia-falha', async () => {
    const { port } = build();

    await expect(
      port.matchImages([item('A')], context('Teste #ia-falha #ia-falha-terminal')),
    ).rejects.toBeInstanceOf(TerminalProviderError);
    await expect(
      port.matchImages([item('A')], context('Teste #ia-falha-terminal')),
    ).rejects.toBeInstanceOf(TerminalProviderError);
  });

  it('#ia-lenta: cada lote espera 20 s, sem diferença de maiúsculas, em toda fase', async () => {
    const { port, sleep } = build();
    const ctx = context('Teste #IA-LENTA');

    await port.categorize([item('CERVEJA')], ctx);
    await port.spellcheck([item('ABACATE')], ctx);
    await port.matchImages([item(nameWithOutcome(2))], ctx);

    expect(sleep.mock.calls).toEqual([[SLOW_MARKER_MS], [SLOW_MARKER_MS], [SLOW_MARKER_MS]]);
    expect(SLOW_MARKER_MS).toBe(20_000);
  });

  it('#ia-lenta soma a espera à falha: espera e depois falha', async () => {
    const { port, sleep } = build();

    await expect(
      port.matchImages([item('A')], context('Teste #ia-lenta #ia-falha')),
    ).rejects.toBeInstanceOf(TransientProviderError);
    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it('sem marcador, responde normalmente e sem esperar', async () => {
    const { port, sleep } = build();

    await port.matchImages([item(nameWithOutcome(2))], context('Ofertas Piccin semana 47'));

    expect(sleep).not.toHaveBeenCalled();
  });
});
