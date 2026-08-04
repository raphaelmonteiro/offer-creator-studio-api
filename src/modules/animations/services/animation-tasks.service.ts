import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { AnimationTask } from '../entities/animation-task.entity';
import { TaskStatus, TERMINAL_TASK_STATUSES } from '../domain/task-state-machine';
import { buildPipeline, stepCost } from '../domain/pricing.config';
import {
  CreateAnimationTaskDto,
  TalkingMascotInputDto,
  VoiceTtsInputDto,
} from '../dto/create-animation-task.dto';
import { CreditsService, creditsEnabled } from './credits.service';
import { TaskTransitionService } from './task-transition.service';
import { TtsCacheService } from './tts-cache.service';
import { AnimationQueueService, QUEUES } from './animation-queue.service';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? 3);
const MAX_TASKS_PER_DAY = Number(process.env.MAX_TASKS_PER_DAY ?? 100);

@Injectable()
export class AnimationTasksService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditsService,
    private readonly transitions: TaskTransitionService,
    private readonly ttsCache: TtsCacheService,
    private readonly queue: AnimationQueueService,
  ) {}

  /**
   * Criação de task (TDD §3.4): monta pipeline, aplica cache de TTS (exclui o
   * custo da etapa cacheada da reserva — regra 5), reserva créditos e enfileira
   * — tudo na MESMA transação (pg-boss é Postgres).
   */
  async create(userId: string, dto: CreateAnimationTaskDto): Promise<AnimationTask> {
    return this.dataSource.transaction(async (manager) => {
      await this.enforceLimits(manager, userId);

      const input = dto.input as unknown as Record<string, unknown>;
      const steps = buildPipeline(dto.type, input);

      // Cache de TTS: etapa 'tts' com hash já existente vira succeeded_cached
      let cachedTtsAssetId: string | undefined;
      const pipeline = await Promise.all(
        steps.map(async (step) => {
          const base = {
            key: step.key,
            label: step.label,
            costCredits: stepCost(step),
            provider: step.provider,
            status: 'pending' as const,
          };
          if (step.key !== 'tts') return base;
          const speech = dto.input as TalkingMascotInputDto | VoiceTtsInputDto;
          const hash = this.ttsCache.computeKey(speech.speechText, speech.voiceId);
          const cached = await this.ttsCache.findCached(manager, userId, hash);
          if (!cached) return { ...base, contentHash: hash };
          cachedTtsAssetId = cached.id;
          return {
            ...base,
            contentHash: hash,
            costCredits: 0, // custo excluído da reserva (TDD §3.4 regra 5)
            status: 'succeeded_cached' as const,
            resultAssetId: cached.id,
          };
        }),
      );

      // Cobrança desligada (AI_CREDITS_ENABLED != true): reserva 0 e nenhum
      // lançamento no ledger — estornos viram no-op naturalmente.
      const reservedCredits = creditsEnabled()
        ? pipeline.reduce((sum, s) => sum + s.costCredits, 0)
        : 0;

      const task = manager.create(AnimationTask, {
        userId,
        type: dto.type,
        status: TaskStatus.QUEUED,
        input,
        pipeline,
        currentStepIndex: pipeline.findIndex((s) => s.status === 'pending'),
        reservedCredits,
      });
      await manager.save(task);
      if (cachedTtsAssetId) {
        task.input = { ...input, cachedTtsAssetId, ttsCached: true };
        await manager.save(task);
      }

      await this.credits.reserve(manager, userId, task.id, reservedCredits);
      await this.queue.publish(QUEUES.AI_GENERATE, { taskId: task.id });
      return task;
    });
  }

  async findAll(
    userId: string,
    filters: { status?: string; type?: string } = {},
  ): Promise<AnimationTask[]> {
    return this.dataSource.getRepository(AnimationTask).find({
      where: {
        userId,
        ...(filters.status && { status: filters.status as TaskStatus }),
        ...(filters.type && { type: filters.type }),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async findOne(userId: string, id: string): Promise<AnimationTask> {
    const task = await this.dataSource.getRepository(AnimationTask).findOneBy({ id });
    if (!task) throw new NotFoundException('Task não encontrada');
    if (task.userId !== userId) throw new ForbiddenException();
    return task;
  }

  /** Cancelamento: só em queued (CAS garante) — estorno total. */
  async cancel(userId: string, id: string): Promise<AnimationTask> {
    const task = await this.findOne(userId, id);
    return this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.transitionTask(
        manager,
        task.id,
        TaskStatus.QUEUED,
        TaskStatus.CANCELED,
        { finishedAt: new Date() },
        { by: 'user' },
      );
      if (!won) {
        throw new BadRequestException('Task já iniciou o processamento e não pode ser cancelada');
      }
      await this.credits.refundUnconsumed(
        manager,
        userId,
        task.id,
        task.reservedCredits,
        task.consumedCredits,
      );
      return manager.findOneByOrFail(AnimationTask, { id: task.id });
    });
  }

  /**
   * Retry de task falhada (TDD §3.4 regra 5): nova reserva apenas das etapas
   * ainda não concluídas (etapas succeeded/cached são puladas e não recobradas).
   */
  async retry(userId: string, id: string): Promise<AnimationTask> {
    const task = await this.findOne(userId, id);
    if (task.status !== TaskStatus.FAILED) {
      throw new BadRequestException('Apenas tasks falhadas podem ser re-tentadas');
    }
    return this.dataSource.transaction(async (manager) => {
      const remainingCost = creditsEnabled()
        ? task.pipeline
            .filter((s) => s.status !== 'succeeded' && s.status !== 'succeeded_cached')
            .reduce((sum, s) => sum + s.costCredits, 0)
        : 0;
      const won = await this.transitions.transitionTask(
        manager,
        task.id,
        TaskStatus.FAILED,
        TaskStatus.QUEUED,
        {
          attempts: task.attempts + 1,
          errorCode: null,
          errorMessage: null,
          reservedCredits: remainingCost,
          consumedCredits: 0,
          // sem zerar, o timeout de 10 min do poll conta desde a 1ª tentativa e
          // mata a nova imediatamente
          startedAt: new Date(),
        },
        { by: 'user', retry: true },
      );
      if (!won) throw new BadRequestException('Task não está mais em estado de falha');
      await this.credits.reserve(manager, userId, task.id, remainingCost);
      await this.queue.publish(QUEUES.AI_GENERATE, { taskId: task.id });
      return manager.findOneByOrFail(AnimationTask, { id: task.id });
    });
  }

  /** Falha terminal disparada pelo worker/webhook: transição + estorno do não-consumido. */
  async failTask(
    manager: EntityManager,
    taskId: string,
    from: TaskStatus,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const task = await manager.findOneByOrFail(AnimationTask, { id: taskId });
    const won = await this.transitions.transitionTask(
      manager,
      taskId,
      from,
      TaskStatus.FAILED,
      { errorCode, errorMessage, finishedAt: new Date() },
      { errorCode },
    );
    if (won) {
      await this.credits.refundUnconsumed(
        manager,
        task.userId,
        taskId,
        task.reservedCredits,
        task.consumedCredits,
      );
    }
    return won;
  }

  private async enforceLimits(manager: EntityManager, userId: string): Promise<void> {
    const active = await manager.count(AnimationTask, {
      where: {
        userId,
        status: In(
          Object.values(TaskStatus).filter(
            (s) => !TERMINAL_TASK_STATUSES.includes(s) && s !== TaskStatus.FAILED,
          ),
        ),
      },
    });
    if (active >= MAX_CONCURRENT_TASKS) {
      throw new HttpException(
        {
          code: 'TOO_MANY_ACTIVE_TASKS',
          message: `Limite de ${MAX_CONCURRENT_TASKS} tasks simultâneas`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = await manager
      .createQueryBuilder(AnimationTask, 't')
      .where('t.userId = :userId AND t.createdAt >= :dayStart', { userId, dayStart })
      .getCount();
    if (today >= MAX_TASKS_PER_DAY) {
      throw new HttpException(
        { code: 'TOO_MANY_ACTIVE_TASKS', message: `Limite diário de ${MAX_TASKS_PER_DAY} tasks` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
