import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { EanMatchStore } from './ean-match.store';

/** Resultado do processamento de um item: o que gravar nele e quanto custou. */
export interface ItemOutcome {
  patch: Partial<EanMatchItem>;
  costUsd: number;
}

/**
 * O pipeline de um item (candidatas → vetos → referência → juízes → regra).
 * `finalizarJob` roda quando não há mais pendentes: é onde entram a checagem
 * de colisão entre itens e a gravação na galeria.
 */
export interface EanItemProcessor {
  processar(item: EanMatchItem, job: EanMatchJob): Promise<ItemOutcome>;
  finalizarJob(job: EanMatchJob): Promise<void>;
}

export const EAN_ITEM_PROCESSOR = Symbol('EAN_ITEM_PROCESSOR');

/** Depois disso um item que só falha vai para revisão em vez de tentar para sempre. */
export const MAX_ATTEMPTS = 3;

const IDLE_DELAY_MS = 5_000;
const BUSY_DELAY_MS = 200;

/**
 * Executa jobs de vínculo EAN em segundo plano, dentro do `flyer-api`.
 *
 * Todo o estado vive no banco: reiniciar o processo só faz o runner voltar a
 * pegar os itens ainda `pending`. Vários processos podem rodar ao mesmo
 * tempo sem pegar o mesmo item (SKIP LOCKED no store).
 */
@Injectable()
export class EanMatchRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EanMatchRunnerService.name);
  private readonly concurrency: number;
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;

  constructor(
    private readonly store: EanMatchStore,
    @Inject(EAN_ITEM_PROCESSOR) private readonly processor: EanItemProcessor,
    configService: ConfigService,
  ) {
    const c = Number.parseInt(configService.get<string>('EAN_JOB_CONCURRENCY', '4'), 10);
    this.concurrency = Number.isFinite(c) && c > 0 ? Math.min(c, 16) : 4;
    this.enabled = configService.get<string>('EAN_JOB_RUNNER_ENABLED', 'true') !== 'false';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Runner de jobs EAN desligado (EAN_JOB_RUNNER_ENABLED=false)');
      return;
    }
    this.agendar(IDLE_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private agendar(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .then((trabalhou) => this.agendar(trabalhou ? BUSY_DELAY_MS : IDLE_DELAY_MS))
        .catch((err) => {
          this.logger.error(`Falha no runner de jobs EAN: ${(err as Error).message}`);
          this.agendar(IDLE_DELAY_MS);
        });
    }, ms);
    this.timer.unref();
  }

  /**
   * Um passo do runner: processa um lote de cada job em execução.
   * Devolve true se processou algum item (para agendar o próximo passo logo).
   */
  async tick(): Promise<boolean> {
    if (this.ticking) return false;
    this.ticking = true;
    try {
      let trabalhou = false;
      for (const job of await this.store.jobsEmExecucao()) {
        if (await this.passoDoJob(job)) trabalhou = true;
      }
      return trabalhou;
    } finally {
      this.ticking = false;
    }
  }

  private async passoDoJob(job: EanMatchJob): Promise<boolean> {
    const teto = Number(job.costCapUsd);
    if (teto > 0 && Number(job.costUsd) >= teto) {
      await this.store.mudarStatusSeExecutando(job.id, 'paused', 'teto de custo atingido');
      return false;
    }

    const itens = await this.store.travarPendentes(job.id, this.concurrency);
    if (itens.length === 0) {
      if ((await this.store.contarAbertos(job.id)) === 0) {
        await this.processor.finalizarJob(job);
        await this.store.mudarStatusSeExecutando(job.id, 'done');
        this.logger.log(`Job ${job.id} concluído`);
      }
      return false;
    }

    await Promise.all(itens.map((item) => this.processarItem(item, job)));
    return true;
  }

  private async processarItem(item: EanMatchItem, job: EanMatchJob): Promise<void> {
    try {
      const { patch, costUsd } = await this.processor.processar(item, job);
      await this.store.salvarItem(item.id, patch, costUsd);
      if (costUsd > 0) {
        const { custo, teto } = await this.store.somarCusto(job.id, costUsd);
        if (teto > 0 && custo >= teto) {
          await this.store.mudarStatusSeExecutando(job.id, 'paused', 'teto de custo atingido');
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (item.attempts >= MAX_ATTEMPTS) {
        this.logger.warn(`Item ${item.id} falhou ${item.attempts}x, vai para revisão: ${msg}`);
        await this.store.salvarItem(
          item.id,
          { status: 'review', reviewReason: 'processing-error' },
          0,
        );
      } else {
        this.logger.warn(`Item ${item.id} falhou (tentativa ${item.attempts}): ${msg}`);
        await this.store.liberarItem(item.id);
      }
    }
  }
}
