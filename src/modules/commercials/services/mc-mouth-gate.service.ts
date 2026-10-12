import { Injectable, Logger } from '@nestjs/common';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
  sniffImageMime,
} from '../../../shared/providers/gemini-image.provider';
import { MC_MOUTH_GATE_PROMPT, McMouthVerdict, parseMouthVerdict } from '../domain/mc-mouth-gate';

/** Vereditos sintéticos do modo mock (MC_MOUTH_GATE_MOCK): passed (default) | blocked | undecided. */
const MOCK_VERDICTS: Record<string, Omit<McMouthVerdict, 'model' | 'at' | 'mock'>> = {
  passed: {
    hasMouth: true,
    mouthOpenPossible: true,
    confidence: 0.95,
    bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
  },
  blocked: {
    hasMouth: false,
    mouthOpenPossible: false,
    confidence: 0.9,
    bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
  },
  undecided: {
    hasMouth: true,
    mouthOpenPossible: false,
    confidence: 0.4,
    bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
  },
};

/**
 * Gate de boca legível (D4): pergunta ao Gemini (visão) se a imagem tem boca
 * identificável e com abertura articulável, devolvendo também a caixa do
 * rosto (insumo do recorte do tile). Nunca lança: visão indisponível vira
 * veredito INDECISO com `error` — a aprovação segue só com aceite de risco.
 *
 * MC_KIT_PROVIDER=mock (default em dev) devolve um veredito sintético, sem
 * gastar visão; MC_MOUTH_GATE_MOCK escolhe o cenário para testes/e2e.
 */
@Injectable()
export class McMouthGateService {
  private readonly logger = new Logger(McMouthGateService.name);

  constructor(private readonly gemini: GeminiImageProvider) {}

  isMock(): boolean {
    return (process.env.MC_KIT_PROVIDER || 'mock') === 'mock';
  }

  async inspect(image: Buffer): Promise<McMouthVerdict> {
    const at = new Date().toISOString();
    if (this.isMock()) {
      const scenario = process.env.MC_MOUTH_GATE_MOCK || 'passed';
      const base = MOCK_VERDICTS[scenario] ?? MOCK_VERDICTS.passed;
      return { ...base, model: 'mock', at, mock: true };
    }
    try {
      const text = await this.gemini.describeImages({
        prompt: MC_MOUTH_GATE_PROMPT,
        images: [image],
        mimeType: sniffImageMime(image),
      });
      const parsed = parseMouthVerdict(text);
      if (!parsed) {
        this.logger.warn(`Gate de boca: resposta não interpretável: ${text.slice(0, 120)}`);
        return this.undecided(at, 'resposta não interpretável');
      }
      return { ...parsed, model: GEMINI_VISION_MODEL, at };
    } catch (err) {
      const message = (err as Error).message ?? 'erro desconhecido';
      this.logger.warn(`Gate de boca indisponível (${message}) — veredito indeciso.`);
      return this.undecided(at, message.slice(0, 200));
    }
  }

  private undecided(at: string, error: string): McMouthVerdict {
    return {
      hasMouth: false,
      mouthOpenPossible: false,
      confidence: 0,
      bbox: null,
      model: GEMINI_VISION_MODEL,
      at,
      error,
    };
  }
}
