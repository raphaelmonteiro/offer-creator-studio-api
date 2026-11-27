import {
  ABACATE_ID,
  EMPTY_RAW_SUGGESTION,
  exampleRequest,
  PICANHA_ID,
} from '../domain/structure-suggestion.testutil';
import { rawSection } from '../domain/structure-suggestion-sanitize.testutil';
import type { StructureSuggestionDto } from '../dto/structure-suggestion.dto';
import { StructureAiFailure } from '../providers/flyer-pro-structure-ai.port';
import {
  bodyOf,
  DOCUMENT_ID,
  documentRow,
  fakePort,
  makeSuggestionService,
  slowAwareMock,
} from './flyer-pro-structure-suggestion.service.testutil';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('FlyerProStructureSuggestionService: o pedido de exemplo com o provedor simulado', () => {
  it('200 com a proposta saneada, o eco do digest e o basedOn do exemplo', async () => {
    const { service } = makeSuggestionService();

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view).toMatchObject({
      stateDigest: '5b1f0c9a27d3e846',
      source: 'mock',
      model: 'mock',
      promptVersion: 1,
      noChange: false,
      discarded: [],
      basedOn: { items: 8, sections: 3, clientFlyers: 0 },
    });
    expect(view.suggestionId).toMatch(UUID);
    expect(view.sections.map((section) => [section.id, section.page])).toEqual([
      ['cat:Carnes', 1],
      ['cat:Hortifruti', null],
      ['cat:Bebidas', 2],
    ]);
    expect(view.heroes.map((hero) => [hero.itemId, hero.size])).toEqual([
      [PICANHA_ID, '2x1'],
      [ABACATE_ID, '2x1'],
    ]);
    expect(view.summary.startsWith('[simulado]')).toBe(true);
  });

  it('a resposta não traz tokens nem custo, e o provedor recebeu o prazo e o mesmo suggestionId', async () => {
    const { port, suggest } = fakePort({
      suggestion: EMPTY_RAW_SUGGESTION,
      model: 'gpt-6-luna',
      usage: { input_tokens: 3700, output_tokens: 2800 },
    });
    const { service } = makeSuggestionService({ port });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(JSON.stringify(view)).not.toMatch(/usage|tokens|costUsd|estimatedCostUsd/);
    expect(view).toMatchObject({ source: 'ai', model: 'gpt-6-luna' });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 25_000 });
  });

  it('o pedido ao provedor leva o nome do banco, os apelidos e 0 produto sem lugar sem o campo unplaced', async () => {
    const { port, suggest } = fakePort({
      suggestion: EMPTY_RAW_SUGGESTION,
      model: 'm',
      usage: null,
    });
    const { service } = makeSuggestionService({ port });

    await service.suggest(DOCUMENT_ID, bodyOf());

    const aiRequest = suggest.mock.calls[0][0];
    expect(aiRequest).toMatchObject({
      documentName: 'Ofertas da semana 47',
      format: '27x40',
      pageCount: 2,
      unplaced: 0,
      maxHeroes: 12,
    });
    expect(aiRequest.sections.map((section) => section.alias)).toEqual(['s1', 's2', 's3']);
    expect(aiRequest.items).toHaveLength(8);
    expect(JSON.stringify(aiRequest)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('repetir o pedido gera outro suggestionId e, no simulado, as mesmas seções e destaques', async () => {
    const { service } = makeSuggestionService();

    const first = await service.suggest(DOCUMENT_ID, bodyOf());
    const second = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(second.suggestionId).not.toBe(first.suggestionId);
    expect([second.sections, second.heroes, second.summary]).toEqual([
      first.sections,
      first.heroes,
      first.summary,
    ]);
  });

  it('o saneamento roda sobre a resposta do provedor (seção e produto inventados saem)', async () => {
    const { port } = fakePort({
      suggestion: {
        summary: 'x'.repeat(400),
        campaign: { kind: 'none', label: '' },
        sections: [
          rawSection('s7'),
          rawSection('s2', 1, 'abre'),
          rawSection('s1'),
          rawSection('s3'),
        ],
        heroes: [{ item: 'p42', size: '2x1', reason: '' }],
        unsuggest: [],
      },
      model: 'gpt-6-luna',
      usage: null,
    });
    const { service } = makeSuggestionService({ port });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.discarded).toEqual([
      { kind: 'section', code: 'UNKNOWN_SECTION' },
      { kind: 'hero', code: 'UNKNOWN_ITEM' },
    ]);
    expect(view.summary).toHaveLength(300);
    expect(view.sections[0]).toEqual({
      id: 'cat:Carnes',
      page: 1,
      reason: 'abre',
      itemIds: null,
      itemsReason: '',
    });
  });
});

describe('FlyerProStructureSuggestionService: não grava nada', () => {
  it('nenhum método de escrita é chamado e só há SELECT, no 200 e nos erros do provedor', async () => {
    const failing = fakePort(new StructureAiFailure('INVALID_OUTPUT', 'saída inválida'));
    const ok = makeSuggestionService();
    const bad = makeSuggestionService({ port: failing.port });

    await ok.service.suggest(DOCUMENT_ID, bodyOf());
    await expect(bad.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({ status: 503 });

    for (const { writes, mocks } of [ok, bad]) {
      expect(writes()).toEqual([]);
      for (const [sql] of mocks.query.mock.calls) expect(String(sql)).toMatch(/^SELECT/);
    }
  });
});

describe('FlyerProStructureSuggestionService: ordem das conferências', () => {
  it('corpo {} é 400 BAD_REQUEST com os obrigatórios, sem ler o banco nem chamar o provedor', async () => {
    const { port, suggest } = fakePort(new Error('não devia ser chamado'));
    const { service, dataSource } = makeSuggestionService({ port });

    await expect(service.suggest(DOCUMENT_ID, {} as StructureSuggestionDto)).rejects.toMatchObject({
      status: 400,
      response: { code: 'BAD_REQUEST' },
    });

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('retrato incoerente é 422 STATE_INVALID antes de função desligada e antes do 404', async () => {
    const { service, mocks } = makeSuggestionService({
      config: { enabled: false },
      document: null,
    });
    const oneSection = bodyOf({ sections: exampleRequest().sections.slice(0, 1) });

    await expect(service.suggest(DOCUMENT_ID, oneSection)).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'FLYER_PRO_STRUCTURE_STATE_INVALID',
        issues: [{ field: 'sections', code: 'TOO_FEW_SECTIONS' }],
      },
    });
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it('função desligada é 422 DISABLED (FLAG) antes do 404, sem ler o banco nem chamar o provedor', async () => {
    const { port, suggest } = fakePort(new Error('não devia ser chamado'));
    const { service, mocks } = makeSuggestionService({
      config: { enabled: false },
      document: null,
      port,
    });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
      response: { code: 'FLYER_PRO_STRUCTURE_AI_DISABLED', details: { reason: 'FLAG' } },
    });

    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('provedor indisponível por configuração é 422 DISABLED com o motivo, antes do 429 e sem tomar a vaga', async () => {
    const { port, suggest } = fakePort(new Error('não devia ser chamado'), {
      unavailableReason: () => 'NO_API_KEY',
    });
    const { service, limiter } = makeSuggestionService({ port });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
      response: { code: 'FLYER_PRO_STRUCTURE_AI_DISABLED', details: { reason: 'NO_API_KEY' } },
    });

    expect(suggest).not.toHaveBeenCalled();
    expect(limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');
  });

  it('a função desligada vence o provedor indisponível', async () => {
    const { port } = fakePort(new Error('x'), { unavailableReason: () => 'MODEL_PRICE_UNKNOWN' });
    const { service } = makeSuggestionService({ config: { enabled: false }, port });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      response: { details: { reason: 'FLAG' } },
    });
  });

  it('encarte inexistente ou excluído é 404 FLYER_PRO_NOT_FOUND, sem chamar o provedor', async () => {
    const { port, suggest } = fakePort(new Error('não devia ser chamado'));
    const { service } = makeSuggestionService({ document: null, port });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND' },
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('o encarte é lido pelo id da rota, só com as colunas que a sugestão usa', async () => {
    const { service, mocks } = makeSuggestionService();

    await service.suggest(DOCUMENT_ID, bodyOf());

    expect(mocks.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: DOCUMENT_ID },
      select: { id: true, name: true, format: true, clientId: true },
    });
  });
});

describe('FlyerProStructureSuggestionService: falha do provedor, sem plano de reserva', () => {
  it.each([
    [
      'StructureAiFailure INVALID_OUTPUT',
      new StructureAiFailure('INVALID_OUTPUT', 'x'),
      'INVALID_OUTPUT',
    ],
    [
      'StructureAiFailure PROVIDER_ERROR',
      new StructureAiFailure('PROVIDER_ERROR', 'x'),
      'PROVIDER_ERROR',
    ],
    ['StructureAiFailure TIMEOUT do provedor', new StructureAiFailure('TIMEOUT', 'x'), 'TIMEOUT'],
    ['erro qualquer', new Error('boom'), 'PROVIDER_ERROR'],
  ])('%s vira 503 com o motivo e o suggestionId', async (_name, error, reason) => {
    const { port } = fakePort(error);
    const { service } = makeSuggestionService({ port });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'FLYER_PRO_STRUCTURE_AI_FAILED',
        details: { reason, suggestionId: expect.stringMatching(UUID) },
      },
    });
  });

  it('#ia-falha no nome do encarte, com o simulado, é 503 PROVIDER_ERROR', async () => {
    const { service } = makeSuggestionService({
      document: documentRow({ name: 'Teste #ia-falha' }),
    });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 503,
      response: { details: { reason: 'PROVIDER_ERROR' } },
    });
  });

  describe('prazo', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('TIMEOUT_MS=1000 com #ia-lenta é 503 TIMEOUT depois de 1 s, mesmo no simulado', async () => {
      const { service } = makeSuggestionService({
        config: { timeoutMs: 1000 },
        document: documentRow({ name: 'Teste #ia-lenta' }),
        port: slowAwareMock(),
      });

      const pending = service.suggest(DOCUMENT_ID, bodyOf());
      const outcome = expect(pending).rejects.toMatchObject({
        status: 503,
        response: { details: { reason: 'TIMEOUT', suggestionId: expect.stringMatching(UUID) } },
      });
      await jest.advanceTimersByTimeAsync(1000);
      await outcome;
    });

    it('com o prazo padrão, #ia-lenta responde 200 depois de cerca de 3 s', async () => {
      const { service } = makeSuggestionService({
        document: documentRow({ name: 'Teste #ia-lenta' }),
        port: slowAwareMock(),
      });

      const pending = service.suggest(DOCUMENT_ID, bodyOf());
      await jest.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toMatchObject({ source: 'mock', noChange: false });
    });
  });
});
