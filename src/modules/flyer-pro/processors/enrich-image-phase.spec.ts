// A busca de fotos puxa o importador de fotos da DotCompany → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { openAiError } from '../../ai/utils/openai-chat.testutil';
import { callContext, itemInput } from '../providers/flyer-pro-enrich.testutil';
import { EnrichImagePhase } from './enrich-image-phase';
import { buildImageWorld, EAN, eanRow } from './enrich-image-phase.testutil';

const cerveja = itemInput('CERVEJA PILSEN LATA 350ML', { id: 'cerveja', ean: EAN });
const abacate = itemInput('ABACATE KG', { id: 'abacate' });
const salsinha = itemInput('SALSINHA', { id: 'salsinha' });

describe('EnrichImagePhase: chamada da busca de fotos no job', () => {
  it('o pedido leva o cliente do encarte, o nome, a categoria, a unidade e o EAN, no modo estrito e pedindo o uso', async () => {
    const findImages = jest
      .fn()
      .mockResolvedValue({ matches: [], reviewCandidates: [], pending: [], eanStatus: [] });
    const phase = new EnrichImagePhase(
      { findImages },
      { isEnabled: () => true },
      { measure: jest.fn() },
    );
    const context = callContext('Ofertas', { clientId: 'client-77' });

    await phase.run(
      [
        { ...cerveja, category: 'Bebidas', unit: 'cada' },
        { ...abacate, unit: 'kg' },
      ],
      context,
    );

    const [products, clientId, options] = findImages.mock.calls[0];
    expect(products).toEqual([
      {
        id: 'cerveja',
        name: 'CERVEJA PILSEN LATA 350ML',
        category: 'Bebidas',
        unit: 'cada',
        ean: EAN,
      },
      { id: 'abacate', name: 'ABACATE KG', category: null, unit: 'kg', ean: null },
    ]);
    expect(clientId).toBe('client-77');
    expect(options).toEqual({ strict: true, usage: context.usage, signal: context.signal });
  });

  it('busca pelo nome da planilha: acha a foto já escolhida para o nome da planilha', async () => {
    const world = buildImageWorld({
      byAlias: [{ name: 'FILE DE TILAPIA CONJELADO', photoId: 'foto-tilapia' }],
    });
    const file = itemInput('FILÉ DE TILÁPIA CONGELADO', {
      id: 'file',
      sourceName: 'FILE DE TILAPIA CONJELADO',
    });

    const [verdict] = await world.phase.run([file], callContext());

    expect(verdict).toMatchObject({
      action: 'apply',
      photo: {
        galleryImageId: 'foto-tilapia',
        reasons: expect.arrayContaining(['nome escolhido antes']),
      },
    });
  });

  it('item incluído à mão e nome da planilha em branco: a busca recebe o nome do item, nunca vazio', async () => {
    const world = buildImageWorld({
      byAlias: [
        { name: 'COXA E SOBRECOXA DE FRANGO', photoId: 'foto-coxa' },
        { name: 'ABACATE', photoId: 'foto-abacate' },
      ],
    });
    const coxa = itemInput('COXA E SOBRECOXA DE FRANGO', { id: 'coxa' });
    const branco = itemInput('ABACATE', { id: 'abacate', sourceName: '  ' });

    const verdicts = await world.phase.run([coxa, branco], callContext());

    expect(verdicts.map((v) => [v.itemId, v.action])).toEqual([
      ['coxa', 'apply'],
      ['abacate', 'apply'],
    ]);
  });

  it('EAN com dígito verificador errado: eanStatus invalid e o item segue pela busca por nome', async () => {
    const world = buildImageWorld({
      nameMatches: [
        { name: 'CERVEJA PILSEN LATA 350ML', photoId: 'foto-cerveja', strength: 'strong' },
      ],
    });
    const errado = { ...cerveja, ean: '7896000000017' };

    const [verdict] = await world.phase.run([errado], callContext());

    expect(verdict).toMatchObject({ action: 'apply', eanStatus: 'invalid' });
  });
});

describe('EnrichImagePhase: foto aplicada, candidatas e não encontrada', () => {
  it('foto pelo EAN da Galeria: apply com a medida, o estado gallery e o motivo "EAN igual"', async () => {
    const world = buildImageWorld({ byEan: [eanRow('foto-ean')] });
    world.sizes.measure.mockResolvedValue({ width: 800, height: 640 });

    const [verdict] = await world.phase.run([cerveja], callContext());

    expect(verdict).toMatchObject({
      action: 'apply',
      eanStatus: 'gallery',
      photo: {
        galleryImageId: 'foto-ean',
        width: 800,
        height: 640,
        score: 1,
        reasons: expect.arrayContaining(['EAN igual']),
      },
    });
  });

  it('a medida é lida da foto aplicada, com o sinal do lote', async () => {
    const world = buildImageWorld({ byEan: [eanRow('foto-ean')] });
    const context = callContext();

    await world.phase.run([cerveja], context);

    expect(world.sizes.measure).toHaveBeenCalledWith(
      'http://cdn.teste/uploads/gallery/foto-ean.png',
      context.signal,
    );
  });

  it('sem medida (arquivo apagado ou que não abre): review com a foto como candidata, nunca apply', async () => {
    const world = buildImageWorld({ byEan: [eanRow('foto-ean')] });
    world.sizes.measure.mockResolvedValue(null as never);

    const [verdict] = await world.phase.run([cerveja], callContext());

    expect(verdict).toMatchObject({
      action: 'review',
      candidates: [{ galleryImageId: 'foto-ean', thumbnailUrl: null }],
    });
  });

  it('outras fotos do mesmo EAN: só a melhor vem aplicada, as outras não viram candidatas nem alternativa gravada', async () => {
    const world = buildImageWorld({ byEan: [eanRow('foto-a'), eanRow('foto-b')] });

    const [verdict] = await world.phase.run([cerveja], callContext());

    expect(verdict.action).toBe('apply');
    expect(JSON.stringify(verdict)).not.toMatch(/foto-b|alternatives/);
  });

  it('nada encontrado, com a busca por nome disponível: not_found', async () => {
    const world = buildImageWorld();
    const [verdict] = await world.phase.run([salsinha], callContext());
    expect(verdict).toMatchObject({ action: 'not_found', eanStatus: null });
  });

  it('candidatas pelo nome de nota média: review com a candidata e a miniatura', async () => {
    const world = buildImageWorld({
      nameMatches: [{ name: 'ABACATE KG', photoId: 'foto-abacate', strength: 'weak' }],
    });
    const [verdict] = await world.phase.run([abacate], callContext());
    expect(verdict).toMatchObject({
      action: 'review',
      candidates: [
        { galleryImageId: 'foto-abacate', thumbnailUrl: expect.stringContaining('thumbnails') },
      ],
    });
  });

  it('EAN em consulta e foto pelo nome (matches vem antes de pending): apply', async () => {
    const findImages = jest.fn().mockResolvedValue({
      matches: [
        {
          productId: 'cerveja',
          imageId: 'g1',
          imageUrl: 'http://x/g1.png',
          score: 0.81,
          reasons: ['marca'],
          isClientPreferred: false,
        },
      ],
      reviewCandidates: [],
      pending: ['cerveja'],
      eanStatus: [{ productId: 'cerveja', status: 'pending' }],
    });
    const phase = new EnrichImagePhase(
      { findImages },
      { isEnabled: () => true },
      { measure: async () => ({ width: 10, height: 20 }) },
    );

    const [verdict] = await phase.run([cerveja], callContext());

    expect(verdict).toMatchObject({ action: 'apply', photo: { score: 0.81 } });
  });

  it('EAN em consulta e duas candidatas pelo nome: pending com as duas candidatas guardadas', async () => {
    const findImages = jest.fn().mockResolvedValue({
      matches: [],
      reviewCandidates: [
        {
          productId: 'cerveja',
          candidates: [
            {
              imageId: 'a',
              url: 'http://x/a.png',
              thumbnailUrl: null,
              score: 0.6,
              reasons: [],
              isClientPreferred: false,
            },
            {
              imageId: 'b',
              url: 'http://x/b.png',
              thumbnailUrl: null,
              score: 0.6,
              reasons: [],
              isClientPreferred: false,
            },
          ],
        },
      ],
      pending: ['cerveja'],
      eanStatus: [{ productId: 'cerveja', status: 'pending' }],
    });
    const phase = new EnrichImagePhase(
      { findImages },
      { isEnabled: () => true },
      { measure: jest.fn() },
    );

    const [verdict] = await phase.run([cerveja], callContext());

    expect(verdict).toMatchObject({ action: 'pending' });
    expect((verdict as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('a foto do job não ensina a Galeria: nenhuma escrita no banco, só leituras', async () => {
    const world = buildImageWorld({ byEan: [eanRow('foto-ean')] });
    await world.phase.run([cerveja], callContext());
    expect(world.writes()).toEqual([]);
  });
});

describe('EnrichImagePhase: busca por nome indisponível', () => {
  it('embedding desligado: a CERVEJA sai pelo EAN, a SALSINHA continua como estava e o lote conta o fato', async () => {
    const world = buildImageWorld({
      env: { AI_GALLERY_EMBEDDING_ENABLED: 'false' },
      byEan: [eanRow('foto-ean')],
    });
    const context = callContext();

    const verdicts = await world.phase.run([cerveja, salsinha], context);

    expect(verdicts.map((v) => v.action)).toEqual(['apply', 'unanswered']);
    expect(context.notes.nameSearchUnavailable).toBe(true);
  });

  it('busca disponível: o lote não conta nada', async () => {
    const world = buildImageWorld();
    const context = callContext();
    await world.phase.run([salsinha], context);
    expect(context.notes.nameSearchUnavailable).toBe(false);
  });

  it('sem OPENAI_API_KEY: a fase roda pelo EAN da Galeria e não chama a OpenAI', async () => {
    const world = buildImageWorld({ env: { OPENAI_API_KEY: '' }, byEan: [eanRow('foto-ean')] });
    const context = callContext();

    const [verdict] = await world.phase.run([cerveja], context);

    expect(verdict).toMatchObject({ action: 'apply', eanStatus: 'gallery' });
    expect(context.notes.nameSearchUnavailable).toBe(true);
    expect(world.chatCreate).not.toHaveBeenCalled();
    expect(world.embeddingsCreate).not.toHaveBeenCalled();
  });

  it('sem a busca por nome e com o nome já escolhido: a CERVEJA sai pelo nome escolhido', async () => {
    const world = buildImageWorld({
      env: { AI_GALLERY_EMBEDDING_ENABLED: 'false' },
      byAlias: [{ name: 'CERVEJA PILSEN LATA 350ML', photoId: 'foto-alias' }],
    });
    const [verdict] = await world.phase.run([{ ...cerveja, ean: '7896000000019' }], callContext());
    expect(verdict).toMatchObject({ action: 'apply', photo: { galleryImageId: 'foto-alias' } });
  });
});

describe('EnrichImagePhase: EAN sem crédito', () => {
  it('busca por EAN desligada: os itens com EAN fora da Galeria ficam budget_blocked e seguem pelo nome', async () => {
    const world = buildImageWorld({
      nameMatches: [
        { name: 'CERVEJA PILSEN LATA 350ML', photoId: 'foto-cerveja', strength: 'strong' },
      ],
    });
    const outros = ['7894900011524', '7891000100103'].map((ean, index) =>
      itemInput(`REFRIGERANTE ${index}`, { id: `r${index}`, ean }),
    );

    const verdicts = await world.phase.run([cerveja, ...outros], callContext());

    expect(verdicts).toMatchObject([
      { itemId: 'cerveja', action: 'apply', eanStatus: 'budget_blocked' },
      { itemId: 'r0', action: 'review', eanStatus: 'budget_blocked' },
      { itemId: 'r1', action: 'review', eanStatus: 'budget_blocked' },
    ]);
  });

  it('item sem EAN: eanStatus nulo', async () => {
    const world = buildImageWorld();
    const [verdict] = await world.phase.run([abacate], callContext());
    expect(verdict).toMatchObject({ action: 'not_found', eanStatus: null });
  });
});

describe('EnrichImagePhase: falha da busca de fotos', () => {
  it('leitura de nomes com 503: lança TransientProviderError, sem nenhum veredito', async () => {
    const world = buildImageWorld();
    world.chatCreate.mockRejectedValue(openAiError(503));
    await expect(world.phase.run([abacate], callContext())).rejects.toBeInstanceOf(
      TransientProviderError,
    );
  });

  it('chave inválida no embedding (401): lança TerminalProviderError', async () => {
    const world = buildImageWorld();
    world.embeddingsCreate.mockRejectedValue(openAiError(401));
    await expect(world.phase.run([abacate], callContext())).rejects.toBeInstanceOf(
      TerminalProviderError,
    );
  });

  it('o uso da leitura do nome fica no coletor, com o modelo da feature', async () => {
    const world = buildImageWorld();
    const context = callContext();
    await world.phase.run([abacate], context);
    expect(context.usage.snapshot()).toMatchObject({ model: 'gpt-6-luna', calls: 1 });
  });
});
