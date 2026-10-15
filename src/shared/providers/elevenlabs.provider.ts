import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isPreRequestNetworkError,
  networkErrorCodes,
  TerminalProviderError,
  TransientProviderError,
  withRetry,
} from './provider-errors';

/** Modelo padrão do TTS — o mesmo usado desde o módulo de animações (TDD §5.3). */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * Alinhamento por caractere devolvido pelos endpoints `with-timestamps`
 * (nomes originais da API — o domain do commercials consome exatamente isto).
 */
export interface ElevenLabsCharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Voz premade da ElevenLabs como vem do GET /v1/voices (campos que usamos). */
export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

/** Teto do cliente para UMA geração de TTS (fala curta leva poucos segundos). */
export const ELEVENLABS_TTS_TIMEOUT_MS = 120_000;

/** Códigos terminais de uma geração que PODE ter sido feita e cobrada (nunca re-tentar nem cair no fallback). */
export const ELEVENLABS_AMBIGUOUS_CODES = ['provider_timeout', 'provider_response_lost'] as const;

// Classificação da falha de rede movida para provider-errors (o provider Gemini usa a mesma);
// reexportada aqui para os consumidores existentes.
export { isPreRequestNetworkError };

/**
 * ElevenLabs TTS (TDD §5.3) — síncrono: retorna o áudio direto (mp3).
 * Extraído de modules/animations/providers para src/shared/ (plano-comerciais
 * §11): animations e commercials consomem daqui, sem se importarem.
 * `modelId` é opcional e o default preserva o comportamento original do
 * módulo de animações; o fallback eleven_v3 → multilingual_v2 é decisão do
 * CHAMADOR (commercials faz; animations continua no multilingual_v2).
 */
@Injectable()
export class ElevenLabsProvider {
  protected readonly logger = new Logger(ElevenLabsProvider.name);
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(private readonly config: ConfigService) {}

  async synthesize(params: {
    text: string;
    voiceId: string;
    settings?: Record<string, unknown>;
    /** Default eleven_multilingual_v2 (comportamento original do animations). */
    modelId?: string;
  }): Promise<Buffer> {
    const response = await this.postGeneration(`${this.baseUrl}/text-to-speech/${params.voiceId}`, {
      text: params.text,
      model_id: params.modelId ?? ELEVENLABS_DEFAULT_MODEL,
      voice_settings: params.settings ?? { stability: 0.5, similarity_boost: 0.75 },
    });
    return this.readGenerated(response, async (r) => Buffer.from(await r.arrayBuffer()));
  }

  /**
   * `POST /v1/text-to-speech/{voice_id}/with-timestamps` — mesmo TTS, mas a
   * resposta é JSON com `audio_base64` + alinhamento POR CARACTERE
   * (`characters`, `character_start_times_seconds`,
   * `character_end_times_seconds`). É a fonte das legendas queimadas do
   * commercials (plano §5.4: "legendas usam os timestamps do TTS, sem ASR").
   *
   * `normalized_alignment` é preferido quando vem: ele reflete o texto
   * NORMALIZADO que o modelo realmente falou (números viram extenso), que é o
   * que aparece no áudio — e portanto o que a legenda deve mostrar.
   *
   * `previousText`/`nextText` (opcionais): texto das falas vizinhas, enviado
   * como `previous_text`/`next_text` para a prosódia de uma fala por chamada
   * (change video-formatos-personagem, D7) — nunca é falado, só condiciona.
   */
  async synthesizeWithTimestamps(params: {
    text: string;
    voiceId: string;
    settings?: Record<string, unknown>;
    modelId?: string;
    previousText?: string | null;
    nextText?: string | null;
  }): Promise<{ audio: Buffer; alignment: ElevenLabsCharacterAlignment | null }> {
    const response = await this.postGeneration(
      `${this.baseUrl}/text-to-speech/${params.voiceId}/with-timestamps`,
      {
        text: params.text,
        model_id: params.modelId ?? ELEVENLABS_DEFAULT_MODEL,
        voice_settings: params.settings ?? { stability: 0.5, similarity_boost: 0.75 },
        ...(params.previousText?.trim() ? { previous_text: params.previousText.trim() } : {}),
        ...(params.nextText?.trim() ? { next_text: params.nextText.trim() } : {}),
      },
    );
    const body = await this.readGenerated(
      response,
      async (r) =>
        (await r.json()) as {
          audio_base64?: string;
          alignment?: ElevenLabsCharacterAlignment | null;
          normalized_alignment?: ElevenLabsCharacterAlignment | null;
        } | null,
    );
    if (!body?.audio_base64) {
      throw new TerminalProviderError(
        'Resposta com timestamps sem audio_base64',
        'invalid_provider_output',
      );
    }
    return {
      audio: Buffer.from(body.audio_base64, 'base64'),
      alignment: body.normalized_alignment ?? body.alignment ?? null,
    };
  }

  /**
   * POST de uma geração paga SEM duplicata (achado 2 da 3.7). A ElevenLabs não
   * tem idempotência, então só re-tenta o que certamente não gerou nada:
   * - rede antes da entrega (conexão recusada, DNS, timeout de conexão) → retry;
   * - 429 e 5xx (resposta de erro, sem áudio) → retry;
   * - qualquer outra falha depois do envio (reset/socket fechado, timeout do
   *   cliente) → `TerminalProviderError` `provider_response_lost` /
   *   `provider_timeout`, sem nova requisição: a geração pode ter sido cobrada.
   * Cada retry é logado.
   */
  private async postGeneration(url: string, payload: Record<string, unknown>): Promise<Response> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs());
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'xi-api-key': this.config.get('ELEVENLABS_API_KEY') ?? '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) {
            throw new TerminalProviderError(
              `TTS sem resposta em ${this.timeoutMs()} ms — a geração pode ter sido feita; sem nova tentativa automática`,
              'provider_timeout',
            );
          }
          if (isPreRequestNetworkError(err)) {
            throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
          }
          throw new TerminalProviderError(
            `Resposta do TTS perdida (${(err as Error).message}${networkErrorCodes(err).length ? ` ${networkErrorCodes(err).join(',')}` : ''}) — a geração pode ter sido feita; sem nova tentativa automática`,
            'provider_response_lost',
          );
        } finally {
          clearTimeout(timer);
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new TransientProviderError(
            `HTTP ${response.status}`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          );
        }
        if (!response.ok) {
          // O corpo da ElevenLabs diz o MOTIVO (ex.: invalid_uid) — sem ele o
          // "HTTP 400" seco já mascarou diagnóstico em produção real.
          const body = await response.text().catch(() => '');
          throw new TerminalProviderError(
            `HTTP ${response.status}: ${body.slice(0, 300)}`,
            'provider_rejected',
          );
        }
        return response;
      },
      {
        onRetry: (err, nextAttempt, delayMs) =>
          this.logger.warn(
            `ElevenLabs TTS: ${err.message} antes da geração — tentativa ${nextAttempt} em ${Math.round(delayMs)} ms`,
          ),
      },
    );
  }

  /** Lê o corpo de uma resposta 200: falhar aqui é áudio já gerado (e cobrado) perdido — terminal. */
  private async readGenerated<T>(
    response: Response,
    read: (r: Response) => Promise<T>,
  ): Promise<T> {
    try {
      return await read(response);
    } catch (err) {
      throw new TerminalProviderError(
        `Corpo da resposta do TTS perdido (${(err as Error).message}) — a geração foi feita; sem nova tentativa automática`,
        'provider_response_lost',
      );
    }
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get('ELEVENLABS_TTS_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : ELEVENLABS_TTS_TIMEOUT_MS;
  }

  /**
   * GET /v1/voices — lista de vozes da conta (premade + clonadas). Usada pelo
   * seed do voice_catalog do commercials para resolver voice_ids reais.
   */
  async listVoices(): Promise<ElevenLabsVoice[]> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/voices`, {
        headers: { 'xi-api-key': this.config.get('ELEVENLABS_API_KEY') ?? '' },
      }).catch((err) => {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      });
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new TerminalProviderError(`HTTP ${response.status}`, 'provider_rejected');
      }
      const body = (await response.json()) as { voices?: ElevenLabsVoice[] };
      return body.voices ?? [];
    });
  }
}
