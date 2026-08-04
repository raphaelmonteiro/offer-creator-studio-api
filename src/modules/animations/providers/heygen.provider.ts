import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpProviderBase } from './http-provider.base';
import { ProviderStatusResult, ProviderSubmitResult, withRetry } from './provider.types';

/** HeyGen — avatar humano falando com lip-sync (TDD §5.3). */
@Injectable()
export class HeyGenProvider extends HttpProviderBase {
  protected readonly logger = new Logger(HeyGenProvider.name);
  private readonly baseUrl = 'https://api.heygen.com';

  constructor(private readonly config: ConfigService) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      'X-Api-Key': this.config.get('HEYGEN_API_KEY') ?? '',
      'Content-Type': 'application/json',
    };
  }

  async submitTalkingPhoto(params: {
    photoUrl: string;
    audioUrl: string;
  }): Promise<ProviderSubmitResult> {
    const res = await withRetry(() =>
      this.request<{ data: { video_id: string } }>(`${this.baseUrl}/v2/video/generate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          video_inputs: [
            {
              character: { type: 'talking_photo', talking_photo_url: params.photoUrl },
              voice: { type: 'audio', audio_url: params.audioUrl },
            },
          ],
          dimension: { width: 720, height: 720 },
        }),
      }),
    );
    return { providerJobId: res.data.video_id };
  }

  async getStatus(providerJobId: string): Promise<ProviderStatusResult> {
    const res = await withRetry(() =>
      this.request<{ data: { status: string; video_url?: string; error?: { message: string } } }>(
        `${this.baseUrl}/v1/video_status.get?video_id=${providerJobId}`,
        { headers: this.headers() },
      ),
    );
    switch (res.data.status) {
      case 'completed':
        return { state: 'succeeded', outputUrl: res.data.video_url };
      case 'failed':
        return {
          state: 'failed',
          errorCode: 'provider_failed',
          errorMessage: res.data.error?.message,
        };
      default:
        return { state: 'processing' };
    }
  }
}
