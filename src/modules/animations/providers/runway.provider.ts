import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpProviderBase } from './http-provider.base';
import { ProviderStatusResult, ProviderSubmitResult, withRetry } from './provider.types';

/** Runway image-to-video / Gen-4 Image (TDD §5.1). */
@Injectable()
export class RunwayProvider extends HttpProviderBase {
  protected readonly logger = new Logger(RunwayProvider.name);
  private readonly baseUrl = 'https://api.dev.runwayml.com/v1';

  constructor(private readonly config: ConfigService) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.get('RUNWAY_API_KEY')}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    };
  }

  async submitImageToVideo(params: {
    imageUrl: string;
    prompt: string;
    durationS: number;
    ratio: string;
  }): Promise<ProviderSubmitResult> {
    const body = {
      model: 'gen4_turbo',
      promptImage: params.imageUrl,
      promptText: params.prompt,
      duration: params.durationS,
      ratio: params.ratio,
    };
    const res = await withRetry(() =>
      this.request<{ id: string }>(`${this.baseUrl}/image_to_video`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }),
    );
    return { providerJobId: res.id };
  }

  async getStatus(providerJobId: string): Promise<ProviderStatusResult> {
    const res = await withRetry(() =>
      this.request<{ status: string; output?: string[]; failure?: string; failureCode?: string }>(
        `${this.baseUrl}/tasks/${providerJobId}`,
        { headers: this.headers() },
      ),
    );
    switch (res.status) {
      case 'SUCCEEDED':
        return { state: 'succeeded', outputUrl: res.output?.[0] };
      case 'FAILED':
        return {
          state: 'failed',
          errorCode: res.failureCode ?? 'provider_failed',
          errorMessage: res.failure,
        };
      default:
        return { state: 'processing' };
    }
  }
}
