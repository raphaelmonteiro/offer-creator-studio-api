import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminalProviderError, TransientProviderError, withRetry } from './provider.types';

/** ElevenLabs TTS (TDD §5.3) — síncrono: retorna o áudio direto (mp3). */
@Injectable()
export class ElevenLabsProvider {
  protected readonly logger = new Logger(ElevenLabsProvider.name);
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(private readonly config: ConfigService) {}

  async synthesize(params: {
    text: string;
    voiceId: string;
    settings?: Record<string, unknown>;
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
          model_id: 'eleven_multilingual_v2',
          voice_settings: params.settings ?? { stability: 0.5, similarity_boost: 0.75 },
        }),
      }).catch((err) => {
        throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
      });
      if (response.status === 429 || response.status >= 500) {
        throw new TransientProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new TerminalProviderError(`HTTP ${response.status}`, 'provider_rejected');
      }
      return Buffer.from(await response.arrayBuffer());
    });
  }
}
