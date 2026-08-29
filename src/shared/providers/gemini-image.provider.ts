import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import { TerminalProviderError, TransientProviderError, withRetry } from './provider-errors';

/** Modelo primário validado (Nano Banana Pro) e fallback documentado do plano §4. */
export const GEMINI_IMAGE_MODEL = 'nano-banana-pro-preview';
export const GEMINI_IMAGE_FALLBACK_MODEL = 'gemini-3-pro-image-preview';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Geração de imagem com referências leva dezenas de segundos — folga sobre o default de 30s. */
const REQUEST_TIMEOUT_MS = 120_000;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
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
 *     fallback de modelo gemini-3-pro-image-preview).
 */
@Injectable()
export class GeminiImageProvider {
  protected readonly logger = new Logger(GeminiImageProvider.name);

  constructor(private readonly config: ConfigService) {}

  /** Gera 1 imagem e devolve o binário (PNG/JPEG conforme o modelo devolver). */
  async generateImage(params: GeminiGenerateImageParams): Promise<Buffer> {
    const primary = params.model ?? GEMINI_IMAGE_MODEL;
    const references = await this.loadReferences(params.referenceImages ?? []);
    try {
      return await withRetry(() => this.callModel(primary, params, references));
    } catch (err) {
      // Só o modelo indisponível (404) cai para o fallback — quota e
      // content_policy valem para a CONTA/CONTEÚDO e falhariam igual.
      const modelMissing = err instanceof TerminalProviderError && err.code === 'model_not_found';
      if (!modelMissing || primary === GEMINI_IMAGE_FALLBACK_MODEL) throw err;
      this.logger.warn(
        `Modelo ${primary} indisponível — tentando fallback ${GEMINI_IMAGE_FALLBACK_MODEL}`,
      );
      return withRetry(() => this.callModel(GEMINI_IMAGE_FALLBACK_MODEL, params, references));
    }
  }

  private async callModel(
    model: string,
    params: GeminiGenerateImageParams,
    references: Array<{ mimeType: string; data: string }>,
  ): Promise<Buffer> {
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
    return this.extractImage(payload, model);
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
