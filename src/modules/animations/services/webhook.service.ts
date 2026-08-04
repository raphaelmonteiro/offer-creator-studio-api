import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { AnimationTask } from '../entities/animation-task.entity';
import { TaskStatus } from '../domain/task-state-machine';
import { TaskTransitionService } from './task-transition.service';
import { AnimationQueueService, QUEUES } from './animation-queue.service';

/**
 * Webhooks de providers (TDD ADR-04): assinados com HMAC por provider; o
 * handler valida que o providerJobId pertence à task e apenas ANTECIPA o poll
 * (enfileira ai.poll imediato). Idempotente: transições são CAS — webhook
 * duplicado ou concorrente com o poll vira no-op.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
  ) {}

  verifySignature(provider: string, rawBody: string, signature: string | undefined): void {
    const secret = this.config.get<string>(`WEBHOOK_SECRET_${provider.toUpperCase()}`);
    if (!secret) throw new UnauthorizedException('Webhook não configurado para este provider');
    if (!signature) throw new UnauthorizedException('Assinatura ausente');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Assinatura inválida');
    }
  }

  async handle(provider: string, providerJobId: string): Promise<{ accepted: boolean }> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneBy({
      provider,
      providerJobId,
    });
    if (!task) {
      // job desconhecido: aceita silenciosamente (provider pode re-enviar histórico)
      this.logger.warn(`Webhook ${provider} para job desconhecido ${providerJobId}`);
      return { accepted: false };
    }
    if (task.status !== TaskStatus.PROVIDER_PROCESSING && task.status !== TaskStatus.SUBMITTED) {
      // já processado por poll anterior — no-op idempotente
      return { accepted: false };
    }
    // antecipação do poll: consumer ai.poll resolve o resultado imediatamente
    await this.queue.publish(
      QUEUES.AI_POLL,
      { taskId: task.id },
      { singletonKey: `poll:${task.id}` },
    );
    return { accepted: true };
  }
}
