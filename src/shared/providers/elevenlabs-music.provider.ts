import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminalProviderError, TransientProviderError, withRetry } from './provider-errors';

/** Faixa aceita pelo endpoint (docs oficiais): 3s a 10 min. */
export const MUSIC_MIN_LENGTH_MS = 3_000;
export const MUSIC_MAX_LENGTH_MS = 600_000;

/** Código terminal usado pelo assembly para DEGRADAR sem derrubar o projeto. */
export const MUSIC_UNAVAILABLE_CODE = 'music_unavailable';

/**
 * ElevenLabs Music (plano-comerciais §5.1 etapa 6 / §5.3: "ElevenLabs Music,
 * direitos comerciais inclusos") — `POST /v1/music` devolve o ÁUDIO direto
 * (mp3), com `prompt` + `music_length_ms` (3.000–600.000ms) e
 * `force_instrumental` para garantir faixa sem vocais.
 *
 * `model_id` NÃO é enviado por padrão: o default do endpoint acompanha a conta
 * e mandar um id que a conta não tem produz 422 desnecessário. Quem quiser
 * fixar usa ELEVENLABS_MUSIC_MODEL.
 *
 * Contas sem acesso ao Eleven Music respondem 401/403 (e 422 quando o plano não
 * cobre) — todos viram `TerminalProviderError` com código `music_unavailable`,
 * que o assembly trata como DEGRADAÇÃO (segue sem trilha, evento
 * `music_skipped`), nunca como falha do comercial.
 */
@Injectable()
export class ElevenLabsMusicProvider {
  protected readonly logger = new Logger(ElevenLabsMusicProvider.name);
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(private readonly config: ConfigService) {}

  async compose(params: { prompt: string; lengthMs: number }): Promise<Buffer> {
    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY') ?? '';
    if (!apiKey) {
      throw new TerminalProviderError(
        'ELEVENLABS_API_KEY ausente — trilha indisponível',
        MUSIC_UNAVAILABLE_CODE,
      );
    }
    const lengthMs = Math.min(
      MUSIC_MAX_LENGTH_MS,
      Math.max(MUSIC_MIN_LENGTH_MS, Math.round(params.lengthMs)),
    );
    const model = this.config.get<string>('ELEVENLABS_MUSIC_MODEL');

    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/music`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: params.prompt,
          music_length_ms: lengthMs,
          force_instrumental: true,
          ...(model ? { model_id: model } : {}),
        }),
      }).catch((err) => {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      });
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // 401/403 = conta sem acesso ao Music; 402/422 = plano/limite.
        // Tudo terminal com o MESMO código: o assembly degrada, não falha.
        throw new TerminalProviderError(
          `HTTP ${response.status}: ${body.slice(0, 300)}`,
          MUSIC_UNAVAILABLE_CODE,
        );
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        throw new TerminalProviderError('Resposta de música vazia', MUSIC_UNAVAILABLE_CODE);
      }
      return audio;
    });
  }
}
