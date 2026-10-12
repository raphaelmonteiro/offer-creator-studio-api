import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
} from '../../../shared/providers/gemini-image.provider';
import {
  MC_LOGO_LOCATOR_PROMPT,
  McLogoLocatorResult,
  parseLogoLocatorResponse,
} from '../domain/mc-logo-face';
import { McLogoBox } from '../domain/mc-types';

/**
 * Caixa fixa do modo mock (`found`/`low`): rodapé à esquerda de uma arte
 * 4:5 — em 1080×1350 são 238×122 px em (54, 1161). A fixture real dos testes
 * compõe o logo exatamente aqui.
 */
export const MC_LOGO_LOCATOR_MOCK_BOX: McLogoBox = { x: 0.05, y: 0.86, w: 0.22, h: 0.09 };

/** Cenários do modo mock (MC_LOGO_LOCATOR_MOCK): found (default) | not_found | low. */
const MOCK_RESULTS: Record<string, Pick<McLogoLocatorResult, 'found' | 'bbox' | 'confidence'>> = {
  found: { found: true, bbox: MC_LOGO_LOCATOR_MOCK_BOX, confidence: 0.92 },
  low: { found: true, bbox: MC_LOGO_LOCATOR_MOCK_BOX, confidence: 0.45 },
  not_found: { found: false, bbox: null, confidence: 0 },
};

/** Lado maior da arte enviada à visão (a caixa é fracionária: reduzir não muda a resposta). */
const ART_MAX_SIDE = 1536;
const LOGO_MAX_SIDE = 512;
/** Teto da localização inteira (inclui retries): a ponte chama dentro do request de criação. */
const LOCATE_TIMEOUT_MS = 45_000;

/**
 * Localizador do logo na arte (D9b, camada b): pergunta ao Gemini (visão)
 * onde o logo do kit (2ª imagem) aparece na arte (1ª imagem) e devolve
 * `{found, bbox, confidence}` com a caixa em frações da arte. NUNCA lança:
 * arquivo ilegível, visão indisponível, timeout ou resposta não
 * interpretável viram `{found: false, confidence: 0, error}` — o usuário
 * marca a caixa na prévia.
 *
 * MC_KIT_PROVIDER=mock (default em dev) devolve um resultado sintético sem
 * gastar visão (as imagens ainda são lidas, para o caminho de arquivo ser
 * exercitado); MC_LOGO_LOCATOR_MOCK escolhe o cenário.
 */
@Injectable()
export class McLogoLocatorService {
  private readonly logger = new Logger(McLogoLocatorService.name);

  constructor(private readonly gemini: GeminiImageProvider) {}

  isMock(): boolean {
    return (process.env.MC_KIT_PROVIDER || 'mock') === 'mock';
  }

  /** `artPath`/`logoPath`: caminhos absolutos no disco (bucket /uploads). */
  async locate(artPath: string, logoPath: string): Promise<McLogoLocatorResult> {
    const at = new Date().toISOString();
    const mock = this.isMock();
    const model = mock ? 'mock' : GEMINI_VISION_MODEL;
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`localização do logo excedeu ${LOCATE_TIMEOUT_MS / 1000}s`)),
          LOCATE_TIMEOUT_MS,
        );
      });
      return await Promise.race([this.run(artPath, logoPath, mock, at), deadline]);
    } catch (err) {
      const message = ((err as Error)?.message ?? 'erro desconhecido').slice(0, 200);
      this.logger.warn(`Localização do logo indisponível (${message}) — o usuário marca a caixa.`);
      return {
        found: false,
        bbox: null,
        confidence: 0,
        model,
        at,
        error: message,
        ...(mock ? { mock } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(
    artPath: string,
    logoPath: string,
    mock: boolean,
    at: string,
  ): Promise<McLogoLocatorResult> {
    const [art, logo] = await Promise.all([
      McLogoLocatorService.prepare(artPath, ART_MAX_SIDE),
      McLogoLocatorService.prepare(logoPath, LOGO_MAX_SIDE),
    ]);
    if (mock) {
      const scenario = process.env.MC_LOGO_LOCATOR_MOCK || 'found';
      const base = MOCK_RESULTS[scenario] ?? MOCK_RESULTS.found;
      return { ...base, bbox: base.bbox ? { ...base.bbox } : null, model: 'mock', at, mock: true };
    }
    const text = await this.gemini.describeImages({
      prompt: MC_LOGO_LOCATOR_PROMPT,
      images: [art, logo],
      mimeType: 'image/png',
    });
    const parsed = parseLogoLocatorResponse(text);
    if (!parsed) {
      this.logger.warn(`Localizador do logo: resposta não interpretável: ${text.slice(0, 120)}`);
      return {
        found: false,
        bbox: null,
        confidence: 0,
        model: GEMINI_VISION_MODEL,
        at,
        error: 'resposta não interpretável',
      };
    }
    return { ...parsed, model: GEMINI_VISION_MODEL, at };
  }

  /** Lê e reduz (sem ampliar) para PNG — mantém o alfa do logo; as frações não mudam. */
  private static async prepare(filePath: string, maxSide: number): Promise<Buffer> {
    const input = await fs.readFile(filePath);
    return sharp(input)
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  }
}
