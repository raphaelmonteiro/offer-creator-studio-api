import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { Raster } from '../../../shared/image/raster';
import { Img, loadRgb } from '../../../shared/image/rgb';
import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { RegionSpec } from '../domain/scene-shapes';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import { fakeModelOutput, syntheticScenePng } from '../testing/synthetic-scene';
import { SceneImageService } from './scene-image.service';
import * as recomposeModule from './scene-recompose';
import { RecomposeMismatchError } from './scene-recompose';

const zones = computeSceneZones(findSceneFormat('folheto-27x54')!);
const W = 1280;
const H = 1280;
const RECT: RegionSpec = { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } };

const service = (env: Record<string, string> = {}) => new SceneImageService(new ConfigService(env));

/** A saída passa por reamostragem (Lanczos), então a cor sólida chega com erro de 1 a 2 níveis. */
function expectColor(actual: number[], expected: number[]): void {
  actual.forEach((value, c) => expect(Math.abs(value - expected[c])).toBeLessThanOrEqual(3));
}

function equalRgb(a: Img, b: Img, skip: Raster): number {
  let different = 0;
  for (let i = 0; i < skip.data.length; i += 1) {
    if (skip.data[i]) continue;
    for (let c = 0; c < 3; c += 1) if (a.data[i * 3 + c] !== b.data[i * 3 + c]) different += 1;
  }
  return different;
}

describe('SceneImageService', () => {
  // imagens de até 1920x3840 em memória: com a suíte inteira em paralelo passam dos 5 s padrão
  jest.setTimeout(30_000);
  let master: Buffer;
  beforeAll(async () => {
    master = await syntheticScenePng(W, H);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lê as configurações com os valores do spike como padrão', () => {
    expect(service().settings()).toEqual({
      featherPx: 48,
      marginRatio: 0.04,
      insetPx: 40,
      noopThreshold: 0.02,
    });
    expect(
      service({
        TEMPLATE_SCENE_FEATHER_PX: '24',
        TEMPLATE_SCENE_MARGIN_RATIO: '0.08',
        TEMPLATE_SCENE_INSET_PX: '10',
        TEMPLATE_SCENE_NOOP_THRESHOLD: '0.05',
      }).settings(),
    ).toEqual({ featherPx: 24, marginRatio: 0.08, insetPx: 10, noopThreshold: 0.05 });
    expect(service({ TEMPLATE_SCENE_FEATHER_PX: 'x' }).settings().featherPx).toBe(48);
  });

  it('prepara o recorte do tamanho do plano e a máscara do mesmo tamanho', async () => {
    const prepared = await service().prepareEdit({ master, region: RECT, zones });
    const crop = await sharp(prepared.imagePng).metadata();
    const mask = await sharp(prepared.maskPng).metadata();
    expect([crop.width, crop.height]).toEqual([prepared.plan.sendW, prepared.plan.sendH]);
    expect([mask.width, mask.height]).toEqual([crop.width, crop.height]);
    expect(prepared.plan.sendW * prepared.plan.sendH).toBeGreaterThanOrEqual(655_360);
  });

  it('recusa forma vazia', async () => {
    await expect(
      service().prepareEdit({
        master,
        region: { kind: 'rect', rect: { x: 0.5, y: 0.5, w: 0, h: 0 } },
        zones,
      }),
    ).rejects.toThrow(/Forma vazia/);
  });

  it('o exterior da região de recomposição fica idêntico e o interior muda', async () => {
    const svc = service();
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const { sendW, sendH } = prepared.plan;
    const raw = await fakeModelOutput(
      prepared.imagePng,
      { x: 0, y: 0, w: sendW, h: sendH, color: [250, 120, 0] },
      30,
    );

    const result = await svc.completeEdit(prepared, raw);

    const original = await loadRgb(master);
    const final = await loadRgb(result.finalPng);
    expect([final.width, final.height]).toEqual([W, H]);
    expect(equalRgb(original, final, prepared.authorized)).toBe(0);
    const center = ((H / 2) * W + W / 2) * 3;
    expectColor(Array.from(final.data.slice(center, center + 3)), [250, 120, 0]);
    expect(result.noChange).toBe(false);
    expect(result.metrics.insideMaskDiffRatio).toBeGreaterThan(0.9);
    expect(result.metrics.maskAreaRatio).toBeCloseTo(0.04, 3);
    expect(result.metrics.marginDiffRatio).not.toBeNull();
    expect(result.metrics.seamSsim).not.toBeNull();
    expect(result.metrics.sizeMismatch).toBe(false);
  });

  it('a faixa preta do modelo na borda de A não entra no resultado (recuo de 40 px)', async () => {
    const svc = service();
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const { sendW, sendH, box } = prepared.plan;
    const raw = await fakeModelOutput(
      prepared.imagePng,
      { x: 0, y: 0, w: sendW, h: sendH, color: [250, 120, 0] },
      20,
    );
    const result = await svc.completeEdit(prepared, raw);
    const final = await loadRgb(result.finalPng);
    const original = await loadRgb(master);
    const px = (img: Img, x: number, y: number) =>
      Array.from(img.data.slice((y * W + x) * 3, (y * W + x) * 3 + 3));
    // um pixel dentro de A, perto da borda de A: ainda é a cena original (fora de R)
    const edge = { x: Math.max(box.x, 0) + 2, y: H / 2 };
    if (prepared.authorized.data[edge.y * W + edge.x]) {
      expect(px(final, edge.x, edge.y)).toEqual(px(original, edge.x, edge.y));
    }
    expectColor(px(final, W / 2, H / 2), [250, 120, 0]);
  });

  it('modelo que devolve o recorte sem mudança marca noChange', async () => {
    const svc = service();
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const result = await svc.completeEdit(prepared, prepared.imagePng);
    expect(result.noChange).toBe(true);
    expect(result.metrics.insideMaskDiffRatio).toBeLessThan(0.02);
  });

  it('saída de tamanho diferente é reamostrada e sinalizada', async () => {
    const svc = service();
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const other = await sharp(prepared.imagePng).resize(512, 512, { fit: 'fill' }).png().toBuffer();
    const result = await svc.completeEdit(prepared, other);
    expect(result.metrics.sizeMismatch).toBe(true);
  });

  it('sem faixa de margem, marginDiffRatio é null (e não 0)', async () => {
    const svc = service({ TEMPLATE_SCENE_MARGIN_RATIO: '0' });
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const raw = await fakeModelOutput(prepared.imagePng, {
      x: 0,
      y: 0,
      w: prepared.plan.sendW,
      h: prepared.plan.sendH,
      color: [0, 200, 0],
    });
    const result = await svc.completeEdit(prepared, raw);
    expect(result.metrics.marginDiffRatio).toBeNull();
  });

  it('conferência falha com RECOMPOSE_MISMATCH quando algo fora da região muda', async () => {
    const actual = recomposeModule.recompose;
    jest.spyOn(recomposeModule, 'recompose').mockImplementation(async (...args) => {
      const result = await actual(...args);
      result.final.data[0] = (result.final.data[0] + 1) % 256; // canto superior esquerdo, fora de R
      return result;
    });
    const svc = service();
    const prepared = await svc.prepareEdit({ master, region: RECT, zones });
    const error = await svc.completeEdit(prepared, prepared.imagePng).catch((e) => e);
    expect(error).toBeInstanceOf(RecomposeMismatchError);
    expect(error.code).toBe('RECOMPOSE_MISMATCH');
    expect(error.mismatched).toBe(1);
  });

  it('zona do cabeçalho: recorte largo, reduzido, e exterior idêntico', async () => {
    const svc = service();
    const big = await syntheticScenePng(1920, 1920);
    const prepared = await svc.prepareEdit({
      master: big,
      region: { kind: 'zone', zone: 'header' },
      zones,
    });
    expect(prepared.plan.downscaled).toBe(true);
    const result = await svc.completeEdit(prepared, prepared.imagePng);
    const final = await loadRgb(result.finalPng);
    const original = await loadRgb(big);
    expect(equalRgb(original, final, prepared.authorized)).toBe(0);
  });

  it('cena nativa de 1920x3840 (pico de memória medido: cerca de 100 MB acima da base)', async () => {
    const svc = service();
    const tall = await syntheticScenePng(1920, 3840);
    const prepared = await svc.prepareEdit({
      master: tall,
      region: { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } },
      zones,
    });
    const raw = await fakeModelOutput(prepared.imagePng, {
      x: 0,
      y: 0,
      w: prepared.plan.sendW,
      h: prepared.plan.sendH,
      color: [10, 200, 90],
    });
    const result = await svc.completeEdit(prepared, raw);
    const [original, final] = await Promise.all([loadRgb(tall), loadRgb(result.finalPng)]);
    expect([final.width, final.height]).toEqual([1920, 3840]);
    expect(equalRgb(original, final, prepared.authorized)).toBe(0);
  });

  describe('margem preservada (PV-30)', () => {
    const TALL_RECT: RegionSpec = { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } };
    const mock = () =>
      new MockSceneImageProvider(new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0' }));
    const mockEdit = async (
      svc: SceneImageService,
      prepared: Awaited<ReturnType<SceneImageService['prepareEdit']>>,
      mask: Buffer,
    ) =>
      mock().edit({
        model: 'm',
        prompt: 'deixa o céu laranja',
        size: `${prepared.plan.sendW}x${prepared.plan.sendH}`,
        quality: 'high',
        correlationId: 'c',
        image: prepared.imagePng,
        mask,
        paintMask: await svc.shapeMask(prepared),
      });

    it('modelo que devolve a entrada: margem 0, sem redução e com recorte reduzido (a reamostragem não pesa)', async () => {
      const svc = service();
      const wide = await syntheticScenePng(1920, 1920);
      for (const [img, region] of [
        [master, RECT],
        [wide, { kind: 'zone', zone: 'header' } as RegionSpec],
      ] as const) {
        const prepared = await svc.prepareEdit({ master: img, region, zones });
        const result = await svc.completeEdit(prepared, prepared.imagePng);
        expect(result.metrics.marginDiffRatio).toBe(0);
      }
      const reduced = await svc.prepareEdit({
        master: wide,
        region: { kind: 'zone', zone: 'header' },
        zones,
      });
      expect(reduced.plan.downscaled).toBe(true);
    });

    it('modelo que altera só S: a faixa fica quase intacta (só o feather chega a ela)', async () => {
      const svc = service();
      const tall = await syntheticScenePng(1920, 3840);
      const prepared = await svc.prepareEdit({ master: tall, region: TALL_RECT, zones });
      const image = await loadRgb(prepared.imagePng);
      const alpha = await sharp(await svc.shapeMask(prepared))
        .ensureAlpha()
        .raw()
        .toBuffer();
      const data = Buffer.from(image.data);
      for (let i = 0; i < image.width * image.height; i += 1) {
        if (alpha[i * 4 + 3] === 255) data.set([250, 120, 0], i * 3);
      }
      const raw = await sharp(data, {
        raw: { width: image.width, height: image.height, channels: 3 },
      })
        .png()
        .toBuffer();
      const result = await svc.completeEdit(prepared, raw);
      expect(result.metrics.marginDiffRatio).toBeLessThan(0.05);
      expect(result.metrics.insideMaskDiffRatio).toBeGreaterThan(0.9);
    });

    it('provedor mock: pinta só S, e a faixa R \\ S sai com marginDiffRatio abaixo de 5% (chip acima de 95%)', async () => {
      const svc = service();
      const tall = await syntheticScenePng(1920, 3840);
      const prepared = await svc.prepareEdit({ master: tall, region: TALL_RECT, zones });
      const out = await mockEdit(svc, prepared, prepared.maskPng);
      const result = await svc.completeEdit(prepared, out.buffer);
      expect(result.metrics.insideMaskDiffRatio).toBeGreaterThan(0.9);
      expect(result.metrics.marginDiffRatio).toBeLessThan(0.05);
    });

    it('provedor mock sem a forma (só a máscara A): pinta a faixa, e o chip cai (causa do PV-30)', async () => {
      const svc = service();
      const tall = await syntheticScenePng(1920, 3840);
      const prepared = await svc.prepareEdit({ master: tall, region: TALL_RECT, zones });
      const out = await mock().edit({
        model: 'm',
        prompt: 'deixa o céu laranja',
        size: `${prepared.plan.sendW}x${prepared.plan.sendH}`,
        quality: 'high',
        correlationId: 'c',
        image: prepared.imagePng,
        mask: prepared.maskPng,
      });
      const result = await svc.completeEdit(prepared, out.buffer);
      expect(result.metrics.marginDiffRatio).toBeGreaterThan(0.4);
    });
  });
});
