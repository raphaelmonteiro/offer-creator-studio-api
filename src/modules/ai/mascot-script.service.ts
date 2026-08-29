import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import OpenAI from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { MascotScriptRequestDto, MascotScriptTone } from './dto/mascot-script-request.dto';
import {
  MASCOT_SCRIPT_SYSTEM_PROMPT,
  buildMascotScriptUserPrompt,
} from './prompts/mascot-script.prompts';
import {
  MascotScriptProduct,
  PT_BR_CHARS_PER_SECOND,
  buildFallbackScript,
  charBudgetForSeconds,
  estimateSpeechSeconds,
  extractFlyerProducts,
  rankOffers,
  suggestProductCount,
} from './utils/mascot-script.util';
import { spellOutPricesPtBr } from './utils/price-to-words.util';
import { withAiLogging } from './utils/ai-telemetry.util';

const DEFAULT_MAX_VIDEO_DURATION_S = 30;

export interface MascotScriptResult {
  script: string;
  tone: MascotScriptTone;
  estimatedSeconds: number;
  charactersPerSecond: number;
  characters: number;
  maxSeconds: number;
  hardLimitSeconds: number;
  withinLimit: boolean;
  source: 'ai' | 'fallback';
  products: MascotScriptProduct[];
  warnings: string[];
}

interface FlyerSource {
  id: string;
  name: string;
  document: unknown;
  clientName?: string | null;
}

/**
 * Roteiro automático a partir das ofertas do encarte (spike §4).
 *
 * Duas decisões que valem explicar:
 * - **Preços por extenso são calculados aqui, não pela IA** — o modelo erra
 *   número e cada tentativa custa. A IA recebe `priceSpelled` pronto e é
 *   instruída a copiar; o texto ainda passa por `spellOutPricesPtBr` na saída,
 *   como rede de segurança.
 * - **A duração é estimada antes de gastar TTS**: acima do teto duro o roteiro
 *   é recusado com mensagem acionável, em vez de virar áudio caro e inútil.
 */
@Injectable()
export class MascotScriptService {
  private readonly logger = new Logger(MascotScriptService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.models = getOpenAiModelConfig(configService);
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — roteiro do mascote usará fallback.');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async createScript(dto: MascotScriptRequestDto): Promise<MascotScriptResult> {
    const hardLimitSeconds = this.getHardLimitSeconds();
    const maxSeconds = Math.min(dto.maxSeconds, hardLimitSeconds);
    const warnings: string[] = [];
    if (dto.maxSeconds > hardLimitSeconds) {
      warnings.push(
        `A duração pedida foi reduzida para ${hardLimitSeconds}s, o limite de vídeo do servidor.`,
      );
    }

    const flyer = await this.loadFlyer(dto.flyerId);
    const allProducts = extractFlyerProducts(flyer.document);
    if (allProducts.length === 0) {
      warnings.push(
        'Nenhum produto com preço foi encontrado neste encarte — o roteiro ficou genérico.',
      );
    }
    const count = dto.maxProducts ?? suggestProductCount(maxSeconds);
    const products = rankOffers(allProducts).slice(0, count);

    const fallbackScript = buildFallbackScript({
      products,
      tone: dto.tone,
      storeName: flyer.clientName ?? undefined,
      callToAction: dto.callToAction,
    });

    let script = fallbackScript;
    let source: MascotScriptResult['source'] = 'fallback';

    if (this.openai && products.length > 0) {
      try {
        const aiScript = await this.generateWithAi(dto, products, maxSeconds, flyer);
        const cleaned = this.sanitize(aiScript);
        if (cleaned.length > 0 && estimateSpeechSeconds(cleaned) <= maxSeconds) {
          script = cleaned;
          source = 'ai';
        } else if (cleaned.length > 0) {
          warnings.push(
            'O roteiro da IA ficou mais longo que a duração pedida; usamos a versão automática mais curta.',
          );
        }
      } catch (error) {
        this.logger.warn(`Roteiro por IA indisponível, usando fallback. ${String(error)}`);
        warnings.push('A IA não respondeu; geramos um roteiro automático que você pode editar.');
      }
    } else if (!this.openai) {
      warnings.push('IA não configurada no servidor: roteiro gerado automaticamente.');
    }

    const estimatedSeconds = estimateSpeechSeconds(script);
    if (estimatedSeconds > hardLimitSeconds) {
      throw new UnprocessableEntityException({
        code: 'SCRIPT_TOO_LONG',
        message:
          `O roteiro tem cerca de ${estimatedSeconds}s de locução e o limite é ${hardLimitSeconds}s. ` +
          'Reduza a quantidade de ofertas ou encurte o texto antes de gerar a voz.',
      });
    }

    return {
      script,
      tone: dto.tone,
      estimatedSeconds,
      charactersPerSecond: PT_BR_CHARS_PER_SECOND,
      characters: script.length,
      maxSeconds,
      hardLimitSeconds,
      withinLimit: estimatedSeconds <= maxSeconds,
      source,
      products,
      warnings,
    };
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private getHardLimitSeconds(): number {
    const raw = Number(this.configService.get<string>('MAX_VIDEO_DURATION_S'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_VIDEO_DURATION_S;
  }

  /**
   * O encarte pode estar no builder V2 (`flyer_builder_v2_documents`) ou no
   * formato legado (`flyers.configuration`). Procuramos nos dois, nessa ordem.
   */
  private async loadFlyer(flyerId: string): Promise<FlyerSource> {
    const v2 = await this.dataSource.query(
      `SELECT d.id, d.name, d.document, c.name AS "clientName"
         FROM flyer_builder_v2_documents d
         LEFT JOIN clients c ON c.id = d."clientId"
        WHERE d.id = $1
        LIMIT 1`,
      [flyerId],
    );
    if (v2?.[0]) return v2[0] as FlyerSource;

    const legacy = await this.dataSource.query(
      `SELECT f.id, f.name, f.configuration AS document, c.name AS "clientName"
         FROM flyers f
         LEFT JOIN clients c ON c.id = f."clientId"
        WHERE f.id = $1
        LIMIT 1`,
      [flyerId],
    );
    if (legacy?.[0]) return legacy[0] as FlyerSource;

    throw new NotFoundException({
      code: 'FLYER_NOT_FOUND',
      message: 'Encarte não encontrado. Salve o documento antes de gerar o roteiro.',
    });
  }

  private async generateWithAi(
    dto: MascotScriptRequestDto,
    products: MascotScriptProduct[],
    maxSeconds: number,
    flyer: FlyerSource,
  ): Promise<string> {
    const payload = {
      tone: dto.tone,
      maxSeconds,
      maxCharacters: charBudgetForSeconds(maxSeconds),
      storeName: flyer.clientName ?? null,
      flyerName: flyer.name ?? null,
      callToAction: dto.callToAction ?? null,
      offers: products.map((p) => ({
        name: p.name,
        priceSpelled: p.priceSpelled,
        unit: p.unit ?? null,
        category: p.category ?? null,
        hasDiscount: Boolean(p.originalPrice),
      })),
    };

    const response = await withAiLogging(
      this.logger,
      {
        feature: 'mascot.script',
        endpoint: 'chat.completions',
        model: this.models.fastTextModel,
      },
      () =>
        this.openai!.chat.completions.create({
          model: this.models.fastTextModel,
          temperature: dto.tone === 'animado' ? 0.7 : 0.4,
          max_tokens: 600,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'mascot_script_v1',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['script'],
                properties: { script: { type: 'string' } },
              },
            },
          },
          messages: [
            { role: 'system', content: MASCOT_SCRIPT_SYSTEM_PROMPT },
            { role: 'user', content: buildMascotScriptUserPrompt(payload) },
          ],
        }),
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Resposta vazia da IA');
    const parsed = JSON.parse(raw) as { script?: unknown };
    if (typeof parsed.script !== 'string') throw new Error('Roteiro inválido retornado pela IA');
    return parsed.script;
  }

  /**
   * Rede de segurança: mesmo instruída, a IA às vezes devolve "19,90".
   * Aqui qualquer número de preço que escapou vira extenso, e quebras de linha
   * e aspas somem (atrapalham a locução).
   */
  private sanitize(script: string): string {
    return spellOutPricesPtBr(String(script ?? ''))
      .replace(/["'`*_#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
