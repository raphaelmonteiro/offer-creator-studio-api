import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DotcompanyBudgetService } from './dotcompany-budget.service';
import {
  classifyEan,
  CREDITS_PER_FOUND,
  DotcompanyLookupService,
} from './dotcompany-lookup.service';
import { DotcompanyPhotoImporter } from './dotcompany-photo.importer';
import type { ConsumerKind } from './dotcompany.types';
import { EanImportStore, ItemOutcome } from './ean-import.store';
import { EanImportItem } from './entities/ean-import-item.entity';
import { EanImportJob } from './entities/ean-import-job.entity';

/** Itens por passo: um lote da DotCompany. */
export const STEP_ITEMS = 100;
/** Depois disso um item que só falha fica como "erro" (aparece no relatório). */
export const MAX_ITEM_ATTEMPTS = 3;
const IDLE_DELAY_MS = 5_000;
/** Ritmo entre passos com trabalho; a janela por minuto é garantida pelo controlador. */
const BUSY_DELAY_MS = 2_500;

/** Gancho opcional chamado depois de cada lote de fotos importadas (fase 2: ligador por âncora). */
export const EAN_IMPORT_AFTER_PHOTOS = Symbol('EAN_IMPORT_AFTER_PHOTOS');
export interface AfterPhotosHook {
  afterPhotos(eans: string[]): Promise<void>;
}

/**
 * Executa os jobs de importação DotCompany em segundo plano, dentro do
 * `flyer-api`. Todo o estado vive no banco: reiniciar o processo só faz o
 * runner voltar a pegar os itens ainda `pending`.
 *
 * Espera de orçamento (janela, limite por hora/dia, reserva, sem crédito) NÃO
 * é pausa: o job vai para `waiting_budget` com `waitUntil` e volta sozinho.
 * Só a pausa manual (`paused`) exige `retomar`.
 */
@Injectable()
export class EanImportRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EanImportRunner.name);
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;

  constructor(
    private readonly store: EanImportStore,
    private readonly lookups: DotcompanyLookupService,
    private readonly photos: DotcompanyPhotoImporter,
    private readonly budget: DotcompanyBudgetService,
    configService: ConfigService,
    @Optional() @Inject(EAN_IMPORT_AFTER_PHOTOS) private readonly afterPhotos?: AfterPhotosHook,
  ) {
    this.enabled = configService.get<string>('EAN_IMPORT_RUNNER_ENABLED', 'true') !== 'false';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Runner de importação DotCompany desligado (EAN_IMPORT_RUNNER_ENABLED=false)',
      );
      return;
    }
    this.agendar(IDLE_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Acorda o runner já (ex.: logo depois de criar um job). */
  wake(): void {
    if (!this.enabled || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.agendar(0);
  }

  private agendar(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .then((trabalhou) => this.agendar(trabalhou ? BUSY_DELAY_MS : IDLE_DELAY_MS))
        .catch((err) => {
          this.logger.error(`Falha no runner de importação DotCompany: ${(err as Error).message}`);
          this.agendar(IDLE_DELAY_MS);
        });
    }, ms);
    this.timer.unref();
  }

  /** Um passo: processa um lote de cada job elegível. Devolve se trabalhou. */
  async tick(): Promise<boolean> {
    if (this.ticking) return false;
    this.ticking = true;
    try {
      let trabalhou = false;
      for (const job of await this.store.jobsParaRodar()) {
        if (await this.passo(job)) trabalhou = true;
      }
      return trabalhou;
    } finally {
      this.ticking = false;
    }
  }

  private async passo(job: EanImportJob): Promise<boolean> {
    if (job.status !== 'running') {
      const ok = await this.store.mudarStatus(job.id, ['pending', 'waiting_budget'], 'running');
      if (!ok) return false;
    }

    const itens = await this.store.travarPendentes(job.id, STEP_ITEMS);
    if (itens.length === 0) {
      if ((await this.store.contarAbertos(job.id)) === 0) {
        await this.store.mudarStatus(job.id, ['running'], 'done');
      }
      return false;
    }

    const kind: ConsumerKind = job.kind === 'flyer' ? 'interactive' : 'batch';
    const concluir: Array<[EanImportItem, ItemOutcome]> = [];
    const consultar: EanImportItem[] = [];

    for (const item of itens) {
      const c = classifyEan(item.ean);
      if (c.status === 'invalid') concluir.push([item, { result: 'invalid', reason: c.reason }]);
      else if (c.status === 'internal_use')
        concluir.push([item, { result: 'internal_use', reason: c.reason }]);
      else consultar.push(item);
    }

    // A galeria inteira vem antes do cache DotCompany: OFF, ERP e fotos manuais
    // também evitam uma consulta paga e uma foto duplicada.
    const gallery = await this.store.buscarImagensPorEan(
      consultar.map((item) => classifyEan(item.ean).ean),
    );
    for (let i = consultar.length - 1; i >= 0; i--) {
      const item = consultar[i];
      const imageId = gallery.get(classifyEan(item.ean).ean);
      if (!imageId) continue;
      concluir.push([item, { result: 'already_exists', galleryImageId: imageId }]);
      consultar.splice(i, 1);
    }

    // Teto do job: estima só o que ainda não está no cache (cache não custa).
    if (job.costCapCredits > 0 && consultar.length) {
      const cache = await this.lookups.findCached(consultar.map((i) => classifyEan(i.ean).ean));
      const now = this.budget.now();
      const semCache = consultar.filter((i) => {
        const row = cache.get(classifyEan(i.ean).ean);
        return !(
          row?.status === 'found' ||
          (row?.status === 'not_found' && row.retryAfter && row.retryAfter > now)
        );
      }).length;
      if (job.costCredits + semCache * CREDITS_PER_FOUND > job.costCapCredits) {
        for (const [item, outcome] of concluir) await this.store.concluirItem(item.id, outcome);
        await this.store.liberarItens(
          consultar.map((i) => i.id),
          true,
        );
        await this.store.mudarStatus(job.id, ['running'], 'paused_cap', {
          error: `próximo lote pode passar do teto (${job.costCapCredits} créditos)`,
        });
        return concluir.length > 0;
      }
    }

    const liberar: string[] = [];
    let espera: { reason: NonNullable<EanImportJob['waitReason']>; retryAt: Date | null } | null =
      null;
    let falhaCredencial: string | null = null;

    if (consultar.length) {
      const summary = await this.lookups.resolve(
        consultar.map((i) => i.ean),
        { kind },
      );
      if (summary.credits > 0) await this.store.somarCusto(job.id, summary.credits);
      if (summary.blocked)
        espera = { reason: summary.blocked.reason, retryAt: summary.blocked.retryAt };
      falhaCredencial = summary.authError;

      const encontrados: Array<{
        item: EanImportItem;
        ean: string;
        outcome: NonNullable<ReturnType<typeof summary.outcomes.get>>;
      }> = [];
      for (const item of consultar) {
        const o = summary.outcomes.get(item.ean);
        if (!o || o.status === 'blocked') {
          liberar.push(item.id);
        } else if (o.status === 'found') {
          encontrados.push({ item, ean: o.ean, outcome: o });
        } else if (o.status === 'not_found') {
          concluir.push([item, { result: 'not_found', reason: o.reason ?? null }]);
        } else if (o.status === 'invalid' || o.status === 'internal_use') {
          concluir.push([item, { result: o.status, reason: o.reason ?? null }]);
        } else if (falhaCredencial || item.attempts < MAX_ITEM_ATTEMPTS) {
          liberar.push(item.id);
        } else {
          concluir.push([item, { result: 'error', reason: o.reason ?? null }]);
        }
      }

      if (encontrados.length) {
        const fotos = await this.photos.importMany(
          encontrados.map((e) => ({ ean: e.ean, lookup: e.outcome.lookup! })),
          { kind, concurrency: 4 },
        );
        const importados: string[] = [];
        for (const e of encontrados) {
          const r = fotos.get(e.ean);
          if (r?.status === 'imported' || r?.status === 'already_exists') {
            if (r.status === 'imported') importados.push(e.ean);
            concluir.push([e.item, { result: r.status, galleryImageId: r.galleryImageId }]);
          } else if (r?.status === 'no_image') {
            concluir.push([e.item, { result: 'no_image', reason: r.reason ?? null }]);
          } else if (e.item.attempts < MAX_ITEM_ATTEMPTS) {
            liberar.push(e.item.id);
          } else {
            concluir.push([
              e.item,
              { result: 'error', reason: r?.reason ?? 'falha ao importar a foto' },
            ]);
          }
        }
        if (importados.length && this.afterPhotos) {
          await this.afterPhotos
            .afterPhotos(importados)
            .catch((err) =>
              this.logger.warn(`Gancho pós-importação falhou: ${(err as Error).message}`),
            );
        }
      }
    }

    for (const [item, outcome] of concluir) await this.store.concluirItem(item.id, outcome);
    // Espera de orçamento não conta como tentativa do item.
    await this.store.liberarItens(liberar, Boolean(espera) || Boolean(falhaCredencial));

    if (falhaCredencial) {
      await this.store.mudarStatus(job.id, ['running'], 'failed', { error: falhaCredencial });
    } else if (espera) {
      const waitUntil =
        espera.retryAt ??
        new Date(this.budget.now().getTime() + this.budget.limits.balanceRefreshMs);
      await this.store.mudarStatus(job.id, ['running'], 'waiting_budget', {
        waitReason: espera.reason,
        waitUntil,
      });
      this.logger.log(
        `Job ${job.id} esperando orçamento (${espera.reason}) até ${waitUntil.toISOString()}`,
      );
    }

    return concluir.length > 0;
  }
}
