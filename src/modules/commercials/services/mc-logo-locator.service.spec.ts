import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { logoBoxIoU, MC_LOGO_LOCATOR_PROMPT, resolveLogoBox } from '../domain/mc-logo-face';
import { McLogoBox } from '../domain/mc-types';
import { MC_LOGO_LOCATOR_MOCK_BOX, McLogoLocatorService } from './mc-logo-locator.service';

/**
 * Localizador do logo (D9b camada b) com IMAGENS REAIS: a fixture é uma arte
 * 1080×1350 gerada com sharp (fundo, faixa de preço que serve de "isca" e o
 * logo PNG com alfa composto numa caixa conhecida). A caixa verdadeira é
 * MEDIDA nos pixels (arte com logo × arte sem logo), não copiada da
 * constante — o IoU ≥ 0,8 compara o que o localizador devolve com o lugar
 * onde o logo de fato está.
 */
const ART_W = 1080;
const ART_H = 1350;
const LOGO_W = 238;
const LOGO_H = 122;
/** Posição em px do logo na fixture: a caixa do modo mock (`found`) em 1080×1350. */
const LOGO_LEFT = Math.round(MC_LOGO_LOCATOR_MOCK_BOX.x * ART_W); // 54
const LOGO_TOP = Math.round(MC_LOGO_LOCATOR_MOCK_BOX.y * ART_H); // 1161
/** Isca: faixa de preço vermelha no meio da arte (o logo também é vermelho). */
const DECOY = { left: 620, top: 520, width: 360, height: 180 };

const logoSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_W}" height="${LOGO_H}">
     <ellipse cx="${LOGO_W / 2}" cy="${LOGO_H / 2}" rx="${LOGO_W / 2}" ry="${LOGO_H / 2}" fill="#D7261E"/>
     <rect x="40" y="48" width="158" height="26" rx="6" fill="#FFFFFF"/>
     <circle cx="70" cy="40" r="12" fill="#FFD400"/>
   </svg>`,
);

async function writeFixtures(dir: string) {
  const logoPath = path.join(dir, 'logo.png');
  await sharp(logoSvg).png().toFile(logoPath);
  const decoy = await sharp({
    create: { width: DECOY.width, height: DECOY.height, channels: 3, background: '#D7261E' },
  })
    .png()
    .toBuffer();
  const background = sharp({
    create: { width: ART_W, height: ART_H, channels: 3, background: '#F4EBD0' },
  });
  const withoutLogo = await background
    .clone()
    .composite([{ input: decoy, left: DECOY.left, top: DECOY.top }])
    .png()
    .toBuffer();
  const artPath = path.join(dir, 'art.png');
  await sharp(withoutLogo)
    .composite([{ input: await fs.readFile(logoPath), left: LOGO_LEFT, top: LOGO_TOP }])
    .png()
    .toFile(artPath);
  return { artPath, logoPath, withoutLogo };
}

/** Caixa (frações) dos pixels que diferem entre a arte com e sem logo. */
async function measuredLogoBox(artPath: string, withoutLogo: Buffer): Promise<McLogoBox> {
  const a = await sharp(artPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(withoutLogo).removeAlpha().raw().toBuffer();
  const { width, height, channels } = a.info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const diff =
        Math.abs(a.data[i] - b[i]) +
        Math.abs(a.data[i + 1] - b[i + 1]) +
        Math.abs(a.data[i + 2] - b[i + 2]);
      if (diff > 24) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
  };
}

describe('McLogoLocatorService — localizar o logo do kit na arte (D9b, tarefa 4.6)', () => {
  const env = { ...process.env };
  let dir: string;
  let fixture: Awaited<ReturnType<typeof writeFixtures>>;
  let truth: McLogoBox;
  let gemini: { describeImages: jest.Mock };
  let service: McLogoLocatorService;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-logo-locator-'));
    fixture = await writeFixtures(dir);
    truth = await measuredLogoBox(fixture.artPath, fixture.withoutLogo);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    gemini = { describeImages: jest.fn() };
    service = new McLogoLocatorService(gemini as unknown as GeminiImageProvider);
    delete process.env.MC_LOGO_LOCATOR_MOCK;
    process.env.MC_KIT_PROVIDER = 'mock';
  });

  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });

  it('a fixture tem o logo onde foi composto (medido nos pixels) e a isca fica longe dele', () => {
    expect(truth.x * ART_W).toBeCloseTo(LOGO_LEFT, 0);
    expect(truth.y * ART_H).toBeCloseTo(LOGO_TOP, 0);
    expect(truth.w * ART_W).toBeGreaterThan(LOGO_W - 4);
    expect(truth.h * ART_H).toBeGreaterThan(LOGO_H - 4);
    const decoyBox = {
      x: DECOY.left / ART_W,
      y: DECOY.top / ART_H,
      w: DECOY.width / ART_W,
      h: DECOY.height / ART_H,
    };
    // o IoU discrimina: caixa na isca ou levemente deslocada não passa de 0,8
    expect(logoBoxIoU(decoyBox, truth)).toBe(0);
    expect(logoBoxIoU({ ...truth, x: truth.x + truth.w * 0.3 }, truth)).toBeLessThan(0.8);
  });

  describe('modo mock (MC_KIT_PROVIDER=mock)', () => {
    it('`found` (default): caixa fixa com IoU ≥ 0,8 sobre o logo real da fixture, sem gastar visão', async () => {
      const result = await service.locate(fixture.artPath, fixture.logoPath);
      expect(result).toMatchObject({ found: true, confidence: 0.92, model: 'mock', mock: true });
      expect(result.error).toBeUndefined();
      expect(logoBoxIoU(result.bbox as McLogoBox, truth)).toBeGreaterThanOrEqual(0.8);
      expect(gemini.describeImages).not.toHaveBeenCalled();
      // camada (c): proposta ao usuário, não confirmada
      expect(resolveLogoBox({ detection: result })).toMatchObject({
        source: 'detected',
        confirmed: false,
        actions: ['confirm_logo_box', 'mark_logo_box'],
      });
    });

    it('`low`: confiança 0,45 → o usuário marca a caixa', async () => {
      process.env.MC_LOGO_LOCATOR_MOCK = 'low';
      const result = await service.locate(fixture.artPath, fixture.logoPath);
      expect(result).toMatchObject({ found: true, confidence: 0.45, mock: true });
      expect(resolveLogoBox({ detection: result })).toMatchObject({
        source: 'none',
        logoBox: null,
      });
    });

    it('`not_found`: sem caixa', async () => {
      process.env.MC_LOGO_LOCATOR_MOCK = 'not_found';
      const result = await service.locate(fixture.artPath, fixture.logoPath);
      expect(result).toMatchObject({ found: false, bbox: null, confidence: 0, mock: true });
    });

    it('arquivo ausente não lança: "não localizado" com o erro', async () => {
      const result = await service.locate(path.join(dir, 'nao-existe.png'), fixture.logoPath);
      expect(result).toMatchObject({ found: false, bbox: null, confidence: 0, mock: true });
      expect(result.error).toMatch(/ENOENT/);
    });
  });

  describe('visão real (Gemini stubado — nenhuma chamada paga)', () => {
    beforeEach(() => {
      process.env.MC_KIT_PROVIDER = 'gemini';
    });

    it('arte + logo vão como PNG (logo com alfa, ≤ 512 px); `box_2d` vira a caixa com IoU ≥ 0,8', async () => {
      // resposta no formato nativo do Gemini, a partir da caixa medida (0–1000, [ymin, xmin, ymax, xmax])
      const box2d = [
        Math.round(truth.y * 1000),
        Math.round(truth.x * 1000),
        Math.round((truth.y + truth.h) * 1000),
        Math.round((truth.x + truth.w) * 1000),
      ];
      gemini.describeImages.mockResolvedValue(
        `\`\`\`json\n{"found": true, "confidence": 0.86, "box_2d": [${box2d.join(', ')}]}\n\`\`\``,
      );
      const result = await service.locate(fixture.artPath, fixture.logoPath);

      expect(gemini.describeImages).toHaveBeenCalledTimes(1);
      const call = gemini.describeImages.mock.calls[0][0] as {
        prompt: string;
        images: Buffer[];
        mimeType: string;
      };
      expect(call.prompt).toBe(MC_LOGO_LOCATOR_PROMPT);
      expect(call.mimeType).toBe('image/png');
      expect(call.images).toHaveLength(2);
      const [artMeta, logoMeta] = await Promise.all(
        call.images.map((img) => sharp(img).metadata()),
      );
      expect(artMeta).toMatchObject({ format: 'png', width: ART_W, height: ART_H }); // ≤ 1536: sem redução
      expect(logoMeta).toMatchObject({ format: 'png', hasAlpha: true });
      expect(Math.max(logoMeta.width ?? 0, logoMeta.height ?? 0)).toBeLessThanOrEqual(512);

      expect(result).toMatchObject({ found: true, confidence: 0.86, model: 'gemini-3.8-flash' });
      expect(result.mock).toBeUndefined();
      expect(logoBoxIoU(result.bbox as McLogoBox, truth)).toBeGreaterThanOrEqual(0.8);
      expect(resolveLogoBox({ detection: result }).source).toBe('detected');
    });

    it('arte grande é reduzida a 1536 px no lado maior (as frações não mudam)', async () => {
      const bigArt = path.join(dir, 'big.png');
      await sharp(fixture.artPath).resize(2160, 2700).png().toFile(bigArt);
      gemini.describeImages.mockResolvedValue('{"found": false, "confidence": 0, "box_2d": null}');
      await service.locate(bigArt, fixture.logoPath);
      const artMeta = await sharp(gemini.describeImages.mock.calls[0][0].images[0]).metadata();
      expect(Math.max(artMeta.width ?? 0, artMeta.height ?? 0)).toBe(1536);
    });

    it('visão fora do ar → {found: false, confidence: 0, error}, sem lançar', async () => {
      gemini.describeImages.mockRejectedValue(new Error('HTTP 503'));
      const result = await service.locate(fixture.artPath, fixture.logoPath);
      expect(result).toMatchObject({
        found: false,
        bbox: null,
        confidence: 0,
        model: 'gemini-3.8-flash',
        error: 'HTTP 503',
      });
      expect(resolveLogoBox({ detection: result }).source).toBe('none');
    });

    it('resposta não interpretável → "não localizado" com o motivo', async () => {
      gemini.describeImages.mockResolvedValue('Não consegui identificar.');
      const result = await service.locate(fixture.artPath, fixture.logoPath);
      expect(result).toMatchObject({
        found: false,
        confidence: 0,
        error: 'resposta não interpretável',
      });
    });

    it('visão que não responde em 45 s → timeout tratado como "não localizado"', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      gemini.describeImages.mockReturnValue(new Promise(() => undefined));
      const pending = service.locate(fixture.artPath, fixture.logoPath);
      jest.advanceTimersByTime(45_000);
      const result = await pending;
      expect(result).toMatchObject({ found: false, confidence: 0 });
      expect(result.error).toMatch(/excedeu 45s/);
    });
  });
});
