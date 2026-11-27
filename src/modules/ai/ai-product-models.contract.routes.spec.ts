// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  bearer,
  buildApp,
  createUploadDir,
  removeUploadDir,
} from './ai-product-models.contract.testutil';
import {
  ACTIONS_ANSWER,
  COMPOSITION_ANSWER,
  CONFIGURATION_ANSWER,
  FORMAT,
  INTENT_ANSWER,
  USER_MESSAGES,
} from './template-text-services.testutil';
import { logged } from './utils/ai-product-chat.testutil';
import { chatResponse, openAiError } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const FLYER_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const NO_USAGE = /usage|costUsd|gpt-6|gpt-4o|"model"/;
const ASSEMBLY_REQUEST = {
  template: { id: 't-1', name: 'Ofertas' },
  document: { name: 'Encarte' },
  products: [
    { id: 'p-0', name: 'Arroz', price: 9.9, unit: 'un', category: 'Mercearia', hasImage: true },
  ],
};

describe('contrato das sete rotas de template, layout, plano e roteiro (provedor simulado)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  const post = (url: string, payload: object) =>
    request(app.getHttpServer()).post(url).set('Authorization', bearer()).send(payload);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('Gerar template com a forma de hoje: assistantMessage, configuration e imagesGenerated, sem model, usage nem costUsd', async () => {
    ctx.fakes.generate.mockResolvedValueOnce(CONFIGURATION_ANSWER);

    const res = await post('/v1/ai/template-generate', {
      format: FORMAT,
      messages: USER_MESSAGES,
    });

    expect(res.status).toBe(200);
    expect(Object.keys((res.body as { data: object }).data).sort()).toEqual([
      'assistantMessage',
      'configuration',
      'imagesGenerated',
    ]);
    expect(res.body).toMatchObject({
      success: true,
      data: { assistantMessage: 'Pronto', imagesGenerated: false },
    });
    expect(JSON.stringify(res.body)).not.toMatch(NO_USAGE);
  });

  it('Layout social com a forma de hoje: reasoning e actions', async () => {
    ctx.fakes.social.mockResolvedValueOnce(
      chatResponse({
        content: JSON.stringify({
          reasoning: 'Texto centralizado.',
          actions: [{ targetId: 'el-1', patch: { x: 300 } }],
        }),
      }),
    );

    const res = await post('/v1/ai/social-section-layout', {
      section: { widthCm: 20, heightCm: 5, widthPreviewPx: 756, heightPreviewPx: 189 },
      elements: [{ id: 'el-1', type: 'text', x: 0, y: 0, width: 100, height: 40, zIndex: 1 }],
      instruction: 'Centralize o texto',
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: {
        reasoning: 'Texto centralizado.',
        actions: [{ targetId: 'el-1', patch: { x: 300 } }],
      },
    });
  });

  it('Erro do provedor no plano de montagem: o plano de reserva de hoje, sem erro HTTP, e o log traz AI operation failed', async () => {
    ctx.fakes.assembly.mockRejectedValue(openAiError(503, 'fora do ar'));

    const res = await post('/v1/ai/flyer-assembly-plan', ASSEMBLY_REQUEST);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { summary: { source: 'fallback' } } });
    expect(JSON.stringify(res.body)).not.toMatch(NO_USAGE);
    expect(logged(ctx.logs.assembly.error, 'AI operation failed ')).toMatchObject({
      feature: 'flyer-assembly.plan',
    });
  });

  it('Erro do provedor no gerar template: a falha de hoje no corpo, sem detalhe do provedor', async () => {
    ctx.fakes.generate.mockRejectedValue(openAiError(500, 'detalhe interno do provedor'));

    const res = await post('/v1/ai/template-generate', {
      format: FORMAT,
      messages: USER_MESSAGES,
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: false,
      error: {
        code: 'TEMPLATE_GENERATION_ERROR',
        message: 'Não foi possível gerar o template. Tente novamente com uma descrição diferente.',
      },
    });
  });

  it('Pedido repetido: cada pedido faz a sua chamada e as duas respostas têm a forma de hoje', async () => {
    ctx.fakes.element.mockResolvedValue(ACTIONS_ANSWER);
    const payload = { format: FORMAT, activeSection: 'header', messages: USER_MESSAGES };

    const first = await post('/v1/ai/template-element', payload);
    const second = await post('/v1/ai/template-element', payload);

    expect(ctx.fakes.element).toHaveBeenCalledTimes(2);
    const expected = { success: true, data: { assistantMessage: 'Feito', actions: [] } };
    expect(first.body).toStrictEqual(expected);
    expect(second.body).toStrictEqual(expected);
  });

  it('Template por imagem com a forma de hoje: imageUrl, assistantMessage e promptUsed', async () => {
    ctx.fakes.image
      .mockResolvedValueOnce(INTENT_ANSWER)
      .mockResolvedValueOnce(chatResponse({ content: 'A blue background' }))
      .mockResolvedValueOnce(chatResponse({ content: 'Template gerado!' }));

    const res = await post('/v1/ai/template-image-generate', {
      format: { type: 'folheto-20x27', printWidthCm: 20, printHeightCm: 27 },
      messages: [{ role: 'user', content: 'Fundo azul' }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: {
        imageUrl: '/uploads/templates/x.png',
        assistantMessage: 'Template gerado!',
        promptUsed: expect.any(String),
      },
    });
  });

  it('Template em camadas com a forma de hoje: sem model, usage nem costUsd', async () => {
    ctx.fakes.layers.mockResolvedValueOnce(INTENT_ANSWER).mockResolvedValueOnce(COMPOSITION_ANSWER);

    const res = await post('/v1/ai/template-layers-generate', {
      format: {
        type: 'folheto-20x27',
        printWidthCm: 20,
        printHeightCm: 27,
        headerHeightCm: 6,
        footerHeightCm: 4,
      },
      messages: [{ role: 'user', content: 'Fundo azul' }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { assistantMessage: 'Camadas prontas' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(NO_USAGE);
  });

  it('Roteiro do mascote com a forma de hoje: script e source, sem model, usage nem costUsd', async () => {
    ctx.dataSource.query.mockResolvedValueOnce([
      {
        id: FLYER_ID,
        name: 'Encarte',
        document: { products: [{ name: 'Arroz 5kg', price: 19.9, unit: 'un' }] },
        clientName: 'Mercado',
      },
    ]);
    ctx.fakes.mascot.mockResolvedValueOnce(
      chatResponse({ content: JSON.stringify({ script: 'Hoje tem arroz em oferta, venha!' }) }),
    );

    const res = await post('/v1/ai/mascot-script', {
      flyerId: FLYER_ID,
      tone: 'animado',
      maxSeconds: 30,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { script: 'Hoje tem arroz em oferta, venha!', source: 'ai' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(NO_USAGE);
  });
});
