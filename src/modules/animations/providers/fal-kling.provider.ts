import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpProviderBase } from './http-provider.base';
import { ProviderStatusResult, ProviderSubmitResult, withRetry } from './provider.types';

/** Kling via fal.ai — animação de mascote/personagem a partir de imagem (TDD §5.2). */
@Injectable()
export class FalKlingProvider extends HttpProviderBase {
  protected readonly logger = new Logger(FalKlingProvider.name);
  private readonly model = 'fal-ai/kling-video/v2.1/standard/image-to-video';
  private readonly queueUrl = 'https://queue.fal.run';

  constructor(private readonly config: ConfigService) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.config.get('FAL_API_KEY')}`,
      'Content-Type': 'application/json',
    };
  }

  async submitImageToVideo(params: {
    imageUrl: string;
    motionPrompt: string;
    durationS: number;
  }): Promise<ProviderSubmitResult> {
    const res = await withRetry(() =>
      this.request<{ request_id: string }>(`${this.queueUrl}/${this.model}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          image_url: params.imageUrl,
          prompt: params.motionPrompt,
          duration: String(Math.min(10, Math.max(5, params.durationS))),
        }),
      }),
    );
    return { providerJobId: res.request_id };
  }

  async getStatus(providerJobId: string): Promise<ProviderStatusResult> {
    const status = await withRetry(() =>
      this.request<{ status: string }>(
        `${this.queueUrl}/${this.model}/requests/${providerJobId}/status`,
        { headers: this.headers() },
      ),
    );
    if (status.status === 'COMPLETED') {
      const result = await withRetry(() =>
        this.request<{ video?: { url: string } }>(
          `${this.queueUrl}/${this.model}/requests/${providerJobId}`,
          { headers: this.headers() },
        ),
      );
      return { state: 'succeeded', outputUrl: result.video?.url };
    }
    if (status.status === 'FAILED') {
      return { state: 'failed', errorCode: 'provider_failed' };
    }
    return { state: 'processing' };
  }
}
