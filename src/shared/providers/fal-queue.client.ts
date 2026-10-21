import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpProviderBase } from './http-provider.base';
import { TerminalProviderError } from './provider-errors';

const FAL_QUEUE_BASE_URL = 'https://queue.fal.run';

/**
 * App da fila fal a partir do id do modelo: `owner/alias` (dois primeiros
 * segmentos). Os subcaminhos do modelo (`ai-avatar/v2/pro`, `lip-sync/
 * image-to-video`) são rotas DENTRO do app e NÃO entram nas URLs de
 * status/resultado — o fal responde `.../fal-ai/kling-video/requests/{id}`
 * para `fal-ai/kling-video/ai-avatar/v2/pro`; a URL com o subcaminho devolve
 * 405 vazio (foi o que derrubou o poll reposto pelo watchdog em produção).
 */
export function falQueueAppId(model: string): string {
  const parts = model
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(0, 2).join('/');
}

/** URL de status de um request da fila fal, reconstruída de modelo + request_id. */
export function falRequestStatusUrl(model: string, requestId: string): string {
  return `${FAL_QUEUE_BASE_URL}/${falQueueAppId(model)}/requests/${requestId}/status`;
}

/** URL de resultado de um request da fila fal, reconstruída de modelo + request_id. */
export function falRequestResponseUrl(model: string, requestId: string): string {
  return `${FAL_QUEUE_BASE_URL}/${falQueueAppId(model)}/requests/${requestId}`;
}

/** Estados da fila fal (docs oficiais) — qualquer outro valor é tratado como desconhecido. */
export type FalQueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

export interface FalSubmitResult {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export interface FalStatusResult {
  status: FalQueueStatus;
  queuePosition?: number;
}

/**
 * Cliente GENÉRICO da fila fal.ai (plano-comerciais §5.2 — Kling/Seedance via
 * fal): submit em `POST {base}/{model}`, polling em `status_url`, resultado em
 * `response_url`, sempre com `Authorization: Key FAL_API_KEY`. Diferente do
 * FalKlingProvider do animations (modelo fixo), este recebe o modelo por
 * chamada — é a base dos steps de vídeo do commercials (B1b). Classificação de
 * erro herdada do HttpProviderBase (429/5xx transient; 4xx terminal); a
 * resposta COMPLETED sem vídeo é erro de VALIDAÇÃO terminal
 * (`invalid_provider_output`) — nunca re-tentar, o job do provider já acabou.
 */
@Injectable()
export class FalQueueClient extends HttpProviderBase {
  protected readonly logger = new Logger(FalQueueClient.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.config.get('FAL_API_KEY')}`,
      'Content-Type': 'application/json',
    };
  }

  /** Submete um job; as URLs de status/resultado vêm da resposta (fallback: montadas do request_id). */
  async submit(model: string, input: Record<string, unknown>): Promise<FalSubmitResult> {
    const res = await this.request<{
      request_id: string;
      status_url?: string;
      response_url?: string;
    }>(`${FAL_QUEUE_BASE_URL}/${model}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.request_id) {
      throw new TerminalProviderError(
        'Submit aceito mas sem request_id na resposta',
        'invalid_provider_output',
      );
    }
    return {
      requestId: res.request_id,
      statusUrl: res.status_url ?? falRequestStatusUrl(model, res.request_id),
      responseUrl: res.response_url ?? falRequestResponseUrl(model, res.request_id),
    };
  }

  async status(statusUrl: string): Promise<FalStatusResult> {
    const res = await this.request<{ status?: string; queue_position?: number }>(statusUrl, {
      headers: this.headers(),
    });
    if (res.status !== 'IN_QUEUE' && res.status !== 'IN_PROGRESS' && res.status !== 'COMPLETED') {
      throw new TerminalProviderError(
        `Status desconhecido da fila fal: ${res.status ?? 'ausente'}`,
        'invalid_provider_output',
      );
    }
    return { status: res.status, queuePosition: res.queue_position };
  }

  /** Resultado cru (JSON) — para modelos cujo output não é vídeo. */
  async result<T = Record<string, unknown>>(responseUrl: string): Promise<T> {
    return this.request<T>(responseUrl, { headers: this.headers() });
  }

  /**
   * Resultado de um modelo de VÍDEO: extrai `video.url` (formato fal para
   * Kling/Seedance). COMPLETED sem vídeo = erro de validação terminal — o
   * provider deu o job por concluído, re-tentar o download não muda nada.
   */
  async resultVideoUrl(responseUrl: string): Promise<string> {
    const res = await this.result<{ video?: { url?: string } }>(responseUrl);
    const url = res.video?.url;
    if (!url) {
      throw new TerminalProviderError(
        'Job COMPLETED mas a resposta não contém video.url',
        'invalid_provider_output',
      );
    }
    return url;
  }
}
