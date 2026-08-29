import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminalProviderError, TransientProviderError, withRetry } from './provider-errors';

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
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/text-to-speech/${params.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.get('ELEVENLABS_API_KEY') ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: params.text,
          model_id: params.modelId ?? ELEVENLABS_DEFAULT_MODEL,
          voice_settings: params.settings ?? { stability: 0.5, similarity_boost: 0.75 },
        }),
      }).catch((err) => {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      });
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
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
      return Buffer.from(await response.arrayBuffer());
    });
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
   */
  async synthesizeWithTimestamps(params: {
    text: string;
    voiceId: string;
    settings?: Record<string, unknown>;
    modelId?: string;
  }): Promise<{ audio: Buffer; alignment: ElevenLabsCharacterAlignment | null }> {
    return withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/text-to-speech/${params.voiceId}/with-timestamps`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.config.get('ELEVENLABS_API_KEY') ?? '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: params.text,
            model_id: params.modelId ?? ELEVENLABS_DEFAULT_MODEL,
            voice_settings: params.settings ?? { stability: 0.5, similarity_boost: 0.75 },
          }),
        },
      ).catch((err) => {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      });
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new TerminalProviderError(
          `HTTP ${response.status}: ${body.slice(0, 300)}`,
          'provider_rejected',
        );
      }
      const body = (await response.json().catch(() => null)) as {
        audio_base64?: string;
        alignment?: ElevenLabsCharacterAlignment | null;
        normalized_alignment?: ElevenLabsCharacterAlignment | null;
      } | null;
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
    });
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
