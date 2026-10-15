import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import { TerminalProviderError, TransientProviderError, withRetry } from './provider-errors';

/** Modelo primário validado (Nano Banana Pro) e fallback documentado do plano §4. */
export const GEMINI_IMAGE_MODEL = 'nano-banana-pro-preview';
export const GEMINI_IMAGE_FALLBACK_MODEL = 'gemini-3-pro-image-preview';
/** Modelo de VISÃO (imagens → texto) usado na inspeção de clipes. */
export const GEMINI_VISION_MODEL = 'gemini-3.8-flash';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Timeout de UMA chamada (geração de imagem com referências leva dezenas de
 * segundos — folga sobre o default de 30s). Exportado porque a expiração dos
 * jobs do kit na fila é calculada a partir dele (mc-kit-candidates.service).
 */
export const GEMINI_IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = GEMINI_IMAGE_REQUEST_TIMEOUT_MS;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/** `usageMetadata` do generateContent (contagem de tokens cobrados). */
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Uso de tokens de UMA chamada, lido do `usageMetadata` da resposta — base do
 * custo registrado pelo chamador (o provider não precifica: a tabela de
 * tarifas fica com quem registra o custo, ex.: commercials/domain/mc-kit-costs).
 */
export interface GeminiUsage {
  /** Entrada (texto + imagens de referência). */
  promptTokens: number;
  /** Saída total (imagem + texto), sem o raciocínio. */
  candidatesTokens: number;
  /** Raciocínio ("thinking"), cobrado como saída de texto. */
  thoughtsTokens: number;
  /** Parte IMAGE da saída quando o Gemini detalha por modalidade; null = sem detalhe. */
  outputImageTokens: number | null;
  totalTokens: number | null;
}

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** `usageMetadata` → `GeminiUsage`; null quando a resposta não traz uso. */
export function parseGeminiUsage(raw: unknown): GeminiUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw as GeminiUsageMetadata;
  const details = Array.isArray(meta.candidatesTokensDetails) ? meta.candidatesTokensDetails : null;
  const imageDetail = details?.filter((d) => String(d?.modality ?? '').toUpperCase() === 'IMAGE');
  return {
    promptTokens: tokenCount(meta.promptTokenCount),
    candidatesTokens: tokenCount(meta.candidatesTokenCount),
    thoughtsTokens: tokenCount(meta.thoughtsTokenCount),
    outputImageTokens: details
      ? (imageDetail ?? []).reduce((sum, d) => sum + tokenCount(d?.tokenCount), 0)
      : null,
    totalTokens:
      typeof meta.totalTokenCount === 'number' && Number.isFinite(meta.totalTokenCount)
        ? meta.totalTokenCount
        : null,
  };
}

/**
 * Chamada que a Gemini COBROU sem entregar o resultado: resposta 200 sem
 * imagem (recusa de segurança, `no_image_returned`), visão 200 sem texto, ou
 * geração abortada no timeout do cliente (`timedOut`: a Gemini pode ter
 * gerado e cobrado mesmo assim; uso desconhecido). Vai anexada ao erro
 * lançado (`geminiBilledFailure(err)`) para quem registra custo não perder a
 * chamada paga.
 */
export interface GeminiBilledFailure {
  model: string;
  usage: GeminiUsage | null;
  timedOut?: boolean;
}

const BILLING_KEY = 'geminiBilling';

/** Anexa a cobrança a um erro (ver `GeminiBilledFailure`); exportada para testes. */
export function withGeminiBilling<E extends Error>(err: E, billing: GeminiBilledFailure): E {
  Object.defineProperty(err, BILLING_KEY, { value: billing, enumerable: false });
  return err;
}

/** Cobrança anexada a um erro do provider (ver `GeminiBilledFailure`); null = chamada sem resposta cobrada. */
export function geminiBilledFailure(err: unknown): GeminiBilledFailure | null {
  if (!err || typeof err !== 'object') return null;
  const value = (err as Record<string, unknown>)[BILLING_KEY];
  return value && typeof value === 'object' ? (value as GeminiBilledFailure) : null;
}

/** finishReason/blockReason que significam recusa de conteúdo (→ content_policy, plano §6.4). */
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'RECITATION',
  'IMAGE_PROHIBITED_CONTENT',
]);

export interface GeminiGenerateImageParams {
  prompt: string;
  /** Imagens de referência (Buffer ou caminho absoluto no disco) — inlineData na chamada. */
  referenceImages?: Array<Buffer | string>;
  /** Ex.: '1:1', '9:16', '16:9' — vai em generationConfig.imageConfig. */
  aspectRatio?: string;
  /** Override de modelo (default nano-banana-pro-preview, fallback gemini-3-pro-image-preview). */
  model?: string;
  /**
   * false = timeout do cliente é TERMINAL (`provider_timeout`, com a cobrança
   * estimada anexada): a requisição abortada pode ter sido gerada e cobrada,
   * e re-tentar pagaria a imagem de novo. Default true (re-tenta, legado).
   */
  retryOnTimeout?: boolean;
}

/**
 * Cliente Gemini de GERAÇÃO DE IMAGEM (Nano Banana Pro — plano-comerciais §4):
 * `generateContent` com responseModalities TEXT/IMAGE, referências como
 * inlineData e parse de candidates[].content.parts[].inlineData. Erros
 * classificados no padrão do http-provider.base (plano §6.4):
 *   - 429/5xx/rede → TransientProviderError (retry com backoff + Retry-After);
 *   - 402/403      → TerminalProviderError 'quota' (sinal de kill-switch);
 *   - bloqueio de segurança (HTTP 400 ou resposta 200 sem imagem com
 *     blockReason/finishReason de safety) → TerminalProviderError 'content_policy';
 *   - 404          → TerminalProviderError 'model_not_found' (dispara o
 *     fallback de modelo gemini-3-pro-image-preview);
 *   - timeout do cliente com `retryOnTimeout: false` → TerminalProviderError
 *     'provider_timeout' (sem nova requisição paga).
 * Falha depois de uma resposta cobrada leva `geminiBilledFailure(err)`.
 */
@Injectable()
export class GeminiImageProvider {
  protected readonly logger = new Logger(GeminiImageProvider.name);

  constructor(private readonly config: ConfigService) {}

  /** Gera 1 imagem e devolve o binário (PNG/JPEG conforme o modelo devolver). */
  async generateImage(params: GeminiGenerateImageParams): Promise<Buffer> {
    return (await this.generateImageWithModel(params)).image;
  }

  /**
   * Cadeia de modelos (change video-formatos-personagem, 2.6): o modelo
   * pedido (ex.: GEMINI_IMAGE_MODEL_REFS) → o modelo atual → o fallback
   * documentado, sem repetição. Só o modelo indisponível (404) avança na
   * cadeia — quota e content_policy valem para a CONTA/CONTEÚDO e falhariam
   * igual.
   */
  static modelChain(requested?: string | null): string[] {
    const chain = [
      requested?.trim() || GEMINI_IMAGE_MODEL,
      GEMINI_IMAGE_MODEL,
      GEMINI_IMAGE_FALLBACK_MODEL,
    ];
    return chain.filter((model, index) => chain.indexOf(model) === index);
  }

  /**
   * Igual a `generateImage`, devolvendo também o modelo que efetivamente gerou
   * (hash/auditoria) e o uso de tokens da chamada que deu certo (custo; null
   * quando a resposta não traz `usageMetadata`).
   */
  async generateImageWithModel(
    params: GeminiGenerateImageParams,
  ): Promise<{ image: Buffer; model: string; usage?: GeminiUsage | null }> {
    const chain = GeminiImageProvider.modelChain(params.model);
    const references = await this.loadReferences(params.referenceImages ?? []);
    for (const [index, model] of chain.entries()) {
      try {
        const { image, usage } = await withRetry(() => this.callModel(model, params, references));
        return { image, model, usage };
      } catch (err) {
        const modelMissing = err instanceof TerminalProviderError && err.code === 'model_not_found';
        const next = chain[index + 1];
        if (!modelMissing || !next) throw err;
        this.logger.warn(`Modelo ${model} indisponível — tentando fallback ${next}`);
      }
    }
    // inalcançável: a cadeia nunca é vazia e o último erro é relançado acima
    throw new TerminalProviderError('Nenhum modelo de imagem disponível', 'model_not_found');
  }

  private async callModel(
    model: string,
    params: GeminiGenerateImageParams,
    references: Array<{ mimeType: string; data: string }>,
  ): Promise<{ image: Buffer; usage: GeminiUsage | null }> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new TerminalProviderError('GEMINI_API_KEY não configurada', 'missing_api_key');
    }

    const parts: GeminiPart[] = [
      { text: params.prompt },
      ...references.map((ref) => ({ inlineData: ref })),
    ];
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(params.aspectRatio ? { imageConfig: { aspectRatio: params.aspectRatio } } : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted && params.retryOnTimeout === false) {
        throw withGeminiBilling(
          new TerminalProviderError(
            `Tempo esgotado (${REQUEST_TIMEOUT_MS / 1000}s) no ${model} — sem nova tentativa paga`,
            'provider_timeout',
          ),
          { model, usage: null, timedOut: true },
        );
      }
      throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after')) || undefined;
      throw new TransientProviderError(`HTTP ${response.status}`, retryAfter);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 402 || response.status === 403) {
        throw new TerminalProviderError(`HTTP ${response.status}: ${text.slice(0, 300)}`, 'quota');
      }
      if (response.status === 404) {
        throw new TerminalProviderError(`Modelo ${model} não encontrado`, 'model_not_found');
      }
      const safety = /SAFETY|PROHIBITED|BLOCK/i.test(text);
      throw new TerminalProviderError(
        `HTTP ${response.status}: ${text.slice(0, 300)}`,
        safety ? 'content_policy' : 'provider_rejected',
      );
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    const usage = parseGeminiUsage(payload.usageMetadata);
    try {
      return { image: this.extractImage(payload, model), usage };
    } catch (err) {
      // 200 sem imagem (recusa/sem saída): a chamada foi cobrada mesmo assim
      throw withGeminiBilling(err as Error, { model, usage });
    }
  }

  /**
   * Imagens → TEXTO (inspeção/QA): manda as imagens como inlineData e devolve
   * o texto concatenado da resposta. Mesma classificação de erro do
   * generateImage; sem fallback de modelo.
   */
  async describeImages(params: {
    prompt: string;
    images: Buffer[];
    model?: string;
    mimeType?: string;
  }): Promise<string> {
    return (await this.describeImagesWithUsage(params)).text;
  }

  /** Igual a `describeImages`, devolvendo também o modelo e o uso de tokens (custo do chamador). */
  async describeImagesWithUsage(params: {
    prompt: string;
    images: Buffer[];
    model?: string;
    mimeType?: string;
  }): Promise<{ text: string; model: string; usage: GeminiUsage | null }> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new TerminalProviderError('GEMINI_API_KEY não configurada', 'missing_api_key');
    }
    const model = params.model ?? GEMINI_VISION_MODEL;
    const parts: GeminiPart[] = [
      { text: params.prompt },
      ...params.images.map((img) => ({
        inlineData: { mimeType: params.mimeType ?? 'image/jpeg', data: img.toString('base64') },
      })),
    ];
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['TEXT'], temperature: 0 },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new TerminalProviderError(
          `HTTP ${response.status}: ${text.slice(0, 300)}`,
          response.status === 402 || response.status === 403 ? 'quota' : 'provider_rejected',
        );
      }
      const payload = (await response.json()) as GeminiGenerateContentResponse;
      const text = (payload.candidates ?? [])
        .flatMap((c) => c.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      const usage = parseGeminiUsage(payload.usageMetadata);
      if (!text) {
        // 200 sem texto: cobrada mesmo assim
        throw withGeminiBilling(
          new TerminalProviderError('Resposta sem texto', 'invalid_provider_output'),
          { model, usage },
        );
      }
      return { text, model, usage };
    });
  }

  /** Parse de candidates[].content.parts[].inlineData — primeira imagem encontrada. */
  private extractImage(payload: GeminiGenerateContentResponse, model: string): Buffer {
    for (const candidate of payload.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.data) {
          return Buffer.from(part.inlineData.data, 'base64');
        }
      }
    }
    const blockReason = payload.promptFeedback?.blockReason;
    const finishReason = payload.candidates?.[0]?.finishReason;
    if (blockReason || (finishReason && SAFETY_FINISH_REASONS.has(finishReason))) {
      throw new TerminalProviderError(
        `Geração bloqueada pelo provider (${blockReason ?? finishReason})`,
        'content_policy',
      );
    }
    throw new TerminalProviderError(
      `Resposta do ${model} sem imagem (finishReason=${finishReason ?? 'n/d'})`,
      'no_image_returned',
    );
  }

  /** Buffer passa direto; string é caminho absoluto lido do disco. Detecta o MIME pela assinatura. */
  private async loadReferences(
    refs: Array<Buffer | string>,
  ): Promise<Array<{ mimeType: string; data: string }>> {
    const loaded: Array<{ mimeType: string; data: string }> = [];
    for (const ref of refs) {
      const buffer = Buffer.isBuffer(ref) ? ref : await fs.readFile(ref);
      loaded.push({ mimeType: sniffImageMime(buffer), data: buffer.toString('base64') });
    }
    return loaded;
  }
}

/** PNG/WebP/JPEG pela assinatura dos primeiros bytes (default PNG — nosso formato de recorte). */
export function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'image/png';
}
