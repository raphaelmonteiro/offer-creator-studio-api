import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { buildOfferPieceStillProps } from '../domain/mc-piece-still-props';
import { McCarouselRendererService, RemotionCarouselRenderer } from './mc-carousel-renderer';
import {
  McStillRendererService,
  MockStillRenderer,
  RemotionStillRenderer,
} from './mc-still-renderer';

async function pixelAt(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await sharp(file)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

/** Tarefa 6.2 — renderizadores do quadro parado: mock em sharp (real) e Remotion (com runtime falso). */
describe('MockStillRenderer — quadro parado em sharp', () => {
  let dir: string;
  const env = { MC_COMPOSITION_VERSION: '0.3.0' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-still-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('9:16 → PNG 1080×1920 com o fundo sólido e o painel do personagem na cor do bloco', async () => {
    const { props } = buildOfferPieceStillProps({
      document: fixturePieceDocument(),
      width: 1080,
      height: 1920,
      fonts: [],
      assetBaseUrl: 'http://127.0.0.1:3001',
    });
    const output = path.join(dir, 'still.png');
    const result = await new MockStillRenderer(env).renderStill({
      props,
      localFiles: {},
      outputPath: output,
    });
    expect(result).toEqual({ outputPath: output, renderer: 'mock', compositionVersion: '0.3.0' });
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1080, 1920, 'png']);
    // canto superior direito: fundo #F3F4F6
    expect(await pixelAt(output, 1070, 10)).toEqual([0xf3, 0xf4, 0xf6]);
    // centro do painel do personagem (rect 0.58,0.6 / 0.37×0.28): #FFE082
    expect(await pixelAt(output, Math.round(0.765 * 1080), Math.round(0.74 * 1920))).toEqual([
      0xff, 0xe0, 0x82,
    ]);
  });

  it('4:5 com fundo em imagem local: usa a foto (cover) escurecida; sem o arquivo, quadro escuro — nunca falha', async () => {
    const photo = path.join(dir, 'bg.png');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#00FF00' } })
      .png()
      .toFile(photo);
    const { props } = buildOfferPieceStillProps({
      document: fixturePieceDocument({
        aspectRatio: '4:5',
        background: { mode: 'image', imageUrl: '/uploads/commercials/bg.png', darken: 0.5 },
      }),
      width: 1080,
      height: 1350,
      fonts: [],
      assetBaseUrl: 'http://127.0.0.1:3001',
    });
    const withFile = path.join(dir, 'with.png');
    await new MockStillRenderer(env).renderStill({
      props,
      localFiles: { 'http://127.0.0.1:3001/uploads/commercials/bg.png': photo },
      outputPath: withFile,
    });
    const meta = await sharp(withFile).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    const [r, g, b] = await pixelAt(withFile, 1070, 10);
    expect(g).toBeGreaterThan(80);
    expect(g).toBeLessThan(200); // verde escurecido pela metade
    expect(r).toBeLessThan(40);
    expect(b).toBeLessThan(40);

    const without = path.join(dir, 'without.png');
    await new MockStillRenderer(env).renderStill({ props, localFiles: {}, outputPath: without });
    expect(await pixelAt(without, 1070, 10)).toEqual([0x37, 0x41, 0x51]);
  });
});

describe('RemotionStillRenderer — renderStill com o runtime do render do F2', () => {
  const props = buildOfferPieceStillProps({
    document: fixturePieceDocument(),
    width: 1080,
    height: 1920,
    fonts: [],
    assetBaseUrl: 'http://127.0.0.1:3001',
  }).props;

  function fakeCarousel(core: Record<string, unknown> = {}) {
    const renderer = {
      selectComposition: jest.fn().mockResolvedValue({ id: 'OfferPieceStill', width: 1080 }),
      renderStill: jest.fn().mockResolvedValue(undefined),
    };
    const carousel = {
      compositionVersion: jest.fn().mockResolvedValue('0.4.0'),
      runtime: jest.fn().mockResolvedValue({
        modules: { renderer, core: { COMPOSITION_VERSION: '0.4.0', ...core } },
        serveUrl: 'http://bundle',
        browser: { close: jest.fn() },
      }),
      discardBrowser: jest.fn().mockResolvedValue(undefined),
    };
    return { carousel, renderer };
  }

  it('seleciona a composição OfferPieceStill no bundle já aberto e grava o PNG no caminho pedido', async () => {
    const { carousel, renderer } = fakeCarousel();
    const still = new RemotionStillRenderer(
      carousel as unknown as RemotionCarouselRenderer,
      { MC_RENDER_BROWSER: '/usr/bin/chromium' } as NodeJS.ProcessEnv,
    );
    const result = await still.renderStill({
      props,
      localFiles: {},
      outputPath: '/tmp/x/still.png',
    });
    expect(result).toEqual({
      outputPath: '/tmp/x/still.png',
      renderer: 'remotion',
      compositionVersion: '0.4.0',
    });
    expect(renderer.selectComposition).toHaveBeenCalledWith(
      expect.objectContaining({
        serveUrl: 'http://bundle',
        id: 'OfferPieceStill',
        inputProps: props,
        browserExecutable: '/usr/bin/chromium',
      }),
    );
    expect(renderer.renderStill).toHaveBeenCalledWith(
      expect.objectContaining({
        output: '/tmp/x/still.png',
        imageFormat: 'png',
        frame: 0,
        inputProps: props,
      }),
    );
    expect(carousel.discardBrowser).not.toHaveBeenCalled();
    expect(await still.compositionVersion()).toBe('0.4.0');
  });

  it('pacote expõe o id da composição e o parser: usa o id dele; props recusadas → terminal PIECE_STILL_PROPS_INVALID', async () => {
    const { carousel, renderer } = fakeCarousel({
      OFFER_PIECE_STILL_COMPOSITION_ID: 'PieceStillV2',
      parseOfferPieceStillProps: jest.fn().mockReturnValue({ success: true, data: props }),
    });
    const still = new RemotionStillRenderer(carousel as unknown as RemotionCarouselRenderer, {});
    await still.renderStill({ props, localFiles: {}, outputPath: '/tmp/a.png' });
    expect(renderer.selectComposition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'PieceStillV2' }),
    );

    const rejecting = fakeCarousel({
      parseOfferPieceStillProps: jest
        .fn()
        .mockReturnValue({ success: false, issues: [{ path: ['blocks', 0], message: 'x' }] }),
    });
    await expect(
      new RemotionStillRenderer(
        rejecting.carousel as unknown as RemotionCarouselRenderer,
        {},
      ).renderStill({ props, localFiles: {}, outputPath: '/tmp/b.png' }),
    ).rejects.toMatchObject({ code: 'PIECE_STILL_PROPS_INVALID' });
    expect(rejecting.renderer.renderStill).not.toHaveBeenCalled();
  });

  it('composição ausente no pacote → RENDER_UNAVAILABLE (terminal) e o navegador é descartado; outro erro sobe como está', async () => {
    const { carousel, renderer } = fakeCarousel();
    renderer.selectComposition.mockRejectedValueOnce(
      new Error('No composition with the ID "OfferPieceStill" found. Available: OfferCarousel'),
    );
    const still = new RemotionStillRenderer(carousel as unknown as RemotionCarouselRenderer, {});
    await expect(
      still.renderStill({ props, localFiles: {}, outputPath: '/tmp/c.png' }),
    ).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' });
    expect(carousel.discardBrowser).toHaveBeenCalledTimes(1);

    renderer.selectComposition.mockResolvedValueOnce({ id: 'OfferPieceStill' });
    renderer.renderStill.mockRejectedValueOnce(new Error('Target closed'));
    await expect(
      still.renderStill({ props, localFiles: {}, outputPath: '/tmp/d.png' }),
    ).rejects.toThrow('Target closed');
    expect(carousel.discardBrowser).toHaveBeenCalledTimes(2);
  });
});

describe('McStillRendererService — seleção pelo env', () => {
  it('mock com o pipeline mock (ou MC_CAROUSEL_RENDERER=mock); Remotion partilha a instância do render do F2', () => {
    const remotion = { kind: 'remotion' } as unknown as RemotionCarouselRenderer;
    const carousel = {
      remotionRenderer: jest.fn().mockReturnValue(remotion),
    } as unknown as McCarouselRendererService;
    const service = new McStillRendererService(carousel);
    expect(service.current({ MC_PIPELINE_PROVIDER: 'mock' } as NodeJS.ProcessEnv).kind).toBe(
      'mock',
    );
    expect(
      service.current({
        MC_PIPELINE_PROVIDER: 'real',
        MC_CAROUSEL_RENDERER: 'mock',
      } as NodeJS.ProcessEnv).kind,
    ).toBe('mock');
    const real = service.current({ MC_PIPELINE_PROVIDER: 'real' } as NodeJS.ProcessEnv);
    expect(real.kind).toBe('remotion');
    expect(service.current({ MC_PIPELINE_PROVIDER: 'real' } as NodeJS.ProcessEnv)).toBe(real);
    expect(carousel.remotionRenderer).toHaveBeenCalledTimes(1);
  });
});
