import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { WebhookService } from '../services/webhook.service';

/**
 * Webhooks públicos de providers (TDD ADR-04): rota @Public — a autenticação é
 * a assinatura HMAC por provider, validada em cima do corpo bruto.
 */
@ApiTags('animations')
@Controller('animations/webhooks')
export class AnimationWebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  @Public()
  @Post(':provider')
  async handle(
    @Param('provider') provider: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    this.webhooks.verifySignature(provider, JSON.stringify(body), signature);
    const providerJobId = String(
      body.id ??
        body.request_id ??
        body.video_id ??
        (body.data as Record<string, unknown>)?.video_id ??
        '',
    );
    return this.webhooks.handle(provider, providerJobId);
  }
}
