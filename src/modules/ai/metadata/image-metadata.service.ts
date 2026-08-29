import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getOpenAiModelConfig, OpenAiModelConfig } from '../config/openai-models.config';
import { withAiLogging } from '../utils/ai-telemetry.util';
import {
  averageConfidence,
  parseMetadataLenient,
  ProductMetadata,
} from './product-metadata.schema';
import { TaxonomyService } from './taxonomy/taxonomy.service';

const MODEL_VERSION = 'vision-v1-2026-06';
const VISION_LOW_PROMOTION_THRESHOLD = 0.5;
const DEFAULT_MAX_CONCURRENCY = 4;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

@Injectable()
export class ImageMetadataService {
  private readonly logger = new Logger(ImageMetadataService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;
  private readonly enabled: boolean;
  private readonly maxConcurrency: number;
  private readonly uploadDest: string;

  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly taxonomy: TaxonomyService,
  ) {
    this.models = getOpenAiModelConfig(configService);
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.enabled = configService.get<string>('AI_IMAGE_METADATA_ENABLED', 'true') !== 'false';

    const raw = configService.get<string>(
      'AI_IMAGE_METADATA_CONCURRENCY',
      String(DEFAULT_MAX_CONCURRENCY),
    );
    const parsed = Number.parseInt(raw, 10);
    this.maxConcurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENCY;

    this.uploadDest = path.resolve(configService.get<string>('UPLOAD_DEST', './uploads'));
  }

  isEnabled(): boolean {
    return this.enabled && this.openai !== null;
  }

  modelVersion(): string {
    return MODEL_VERSION;
  }

  async extractFromImage(imageUrl: string): Promise<ProductMetadata | null> {
    if (!this.isEnabled()) return null;
    await this.acquire();
    try {
      const dataUrl = await this.toDataUrl(imageUrl);
      if (!dataUrl) {
        this.logger.warn(`Não consegui carregar a imagem para envio à Vision: ${imageUrl}`);
        return null;
      }
      const first = await this.callVision(dataUrl, 'low');
      if (!first) return null;
      if (averageConfidence(first) >= VISION_LOW_PROMOTION_THRESHOLD) {
        return first;
      }
      const promoted = await this.callVision(dataUrl, 'high');
      return promoted ?? first;
    } catch (error) {
      this.logger.warn(`extractFromImage falhou para ${imageUrl}: ${(error as Error).message}`);
      return null;
    } finally {
      this.release();
    }
  }

  private async callVision(
    imageData: string,
    detail: 'low' | 'high',
  ): Promise<ProductMetadata | null> {
    if (!this.openai) return null;

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt();

    const response = (await withAiLogging(
      this.logger,
      {
        feature: 'image-metadata.extract',
        endpoint: 'chat.completions',
        model: this.models.fastTextModel,
        mode: detail,
      },
      () =>
        this.openai!.chat.completions.create({
          model: this.models.fastTextModel,
          temperature: 0.1,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: imageData, detail } },
              ],
            },
          ],
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
    )) as OpenAI.Chat.ChatCompletion;

    const raw = response.choices[0]?.message?.content ?? '';
    if (!raw.trim()) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Resposta da visão não é JSON válido: ${raw.slice(0, 200)}`);
      return null;
    }

    return parseMetadataLenient(parsed, {
      source: 'vision',
      modelVersion: MODEL_VERSION,
    });
  }

  private buildSystemPrompt(): string {
    return [
      'Você é um analista de produtos de varejo brasileiro. Recebe a foto de um item',
      'de catálogo de supermercado e deve extrair metadados estruturados em JSON.',
      '',
      'Regras inegociáveis:',
      '- Retorne JSON estrito no schema fornecido. Sem texto fora do JSON.',
      '- NÃO invente EAN/SKU. Só preencha se estiverem claramente legíveis na embalagem.',
      '- Categoria deve ser escolhida da lista abaixo (use o id numérico). Se nenhuma',
      '  encaixar, use 999 (Outros).',
      '- Marca / sub-marca / variante: extraia apenas o que estiver visível.',
      '- alternatives[] deve ter exatamente 1 entrada para foto de produto (a foto',
      '  mostra UM produto específico).',
      '- fieldConfidence: número 0..1 por campo refletindo o quão certo você está.',
      '  Campos não inferidos devem ter confiança 0.',
      '- Idioma: português brasileiro nos valores textuais.',
      '',
      'QUANTITY — REGRAS CRÍTICAS (afeta o matching):',
      '- Sempre que a embalagem mostrar a quantidade líquida (peso, volume ou contagem),',
      '  preencha quantity. Procure agressivamente por números seguidos de g, kg, mg,',
      '  ml, L, m, "un", "und", "unidades", "rolos", "cápsulas", "comprimidos".',
      '- Use a unidade EXATAMENTE como está na embalagem ("kg" se diz "5kg"; "g" se diz',
      '  "500g"). NÃO converta. O matching normaliza depois.',
      '- Para absorventes/fraldas/lenços, "16 unidades" / "C/16" / "x16" → {value:16, unit:"un"}.',
      '- Para papel higiênico, "12 rolos" → {value:12, unit:"un"} (não use "m" do rolo;',
      '  o comprimento vai à parte se aparecer separado, ex.: 30m).',
      '',
      'CATEGORIA — pistas fortes (evite enganos comuns):',
      '- Marcas Always, Intimus, Sempre Livre, Carefree, Mili, Modess, Cottonbaby,',
      '  Sym, Definity, Ladysoft, Poise → SEMPRE id=308 (Absorventes e protetores).',
      '  Termos "tripla proteção", "noturno", "adapt", "extra suave" NÃO são produto',
      '  infantil — são variantes de absorvente feminino.',
      '- Marcas Vanish, Brilhante Oxi, Plush Oxy, Tixan, Cândida (alvejante) →',
      '  id=290 (Limpeza > Alvejantes e tira-manchas). NÃO confundir com id=283',
      '  (água sanitária pura tipo Qboa).',
      '- Marcas Skol, Brahma, Heineken, Antarctica → id=166 (Cervejas).',
      '- Marcas Lacta, Garoto, Nestlé chocolate, Hershey, Trento, Bis → id=148.',
      '',
      'Categorias disponíveis (id|caminho):',
      this.taxonomy.promptList(),
    ].join('\n');
  }

  private buildUserPrompt(): string {
    return [
      'Extraia os metadados desta imagem de produto. Retorne JSON com este formato:',
      '{',
      '  "title": string,',
      '  "category": { "id": number, "path": string[] } | null,',
      '  "quantity": { "value": number, "unit": "g"|"kg"|"ml"|"l"|"un"|"m" } | null,',
      '  "packageType": "garrafa"|"lata"|"pote"|"sache"|"caixa"|"fardo"|"pacote"|"bandeja"|"tubo"|"frasco"|"rolo"|"unidade"|"desconhecido"|null,',
      '  "pack": { "count": number, "promoCount"?: number } | null,',
      '  "alternatives": [ { "brand": string|null, "subBrand": string|null, "variant": string|null } ],',
      '  "ean": string|null,',
      '  "sku": string|null,',
      '  "claims": string[],',
      '  "promo": string|null,',
      '  "dominantColors": string[],',
      '  "fieldConfidence": { [campo: string]: number },',
      '  "warnings": string[]',
      '}',
    ].join('\n');
  }

  /**
   * Loads the image bytes and returns a `data:<mime>;base64,...` URL the
   * OpenAI Vision API can consume directly. We avoid sending a public URL
   * because `http://localhost:...` is not resolvable from OpenAI's network.
   * Strategy:
   *   1. If the URL host is local (localhost/127.0.0.1/0.0.0.0/::1), resolve
   *      the filename within UPLOAD_DEST and read from disk.
   *   2. Otherwise, fetch the URL (real CDN).
   */
  private async toDataUrl(input: string): Promise<string | null> {
    try {
      const parsed = new URL(input);
      const ext = path.extname(parsed.pathname).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

      if (LOCAL_HOSTS.has(parsed.hostname)) {
        const rel = parsed.pathname.replace(/^\/+uploads\/+/, '');
        const filePath = path.join(this.uploadDest, rel);
        if (!filePath.startsWith(this.uploadDest)) {
          this.logger.warn(`Caminho de upload fora do UPLOAD_DEST: ${filePath}`);
          return null;
        }
        const bytes = await fs.readFile(filePath);
        return `data:${mime};base64,${bytes.toString('base64')}`;
      }

      const res = await fetch(input);
      if (!res.ok) {
        this.logger.warn(`Falha ao baixar imagem (${res.status}): ${input}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? mime;
      return `data:${contentType};base64,${buf.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `Erro ao preparar imagem para a Vision (${input}): ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
