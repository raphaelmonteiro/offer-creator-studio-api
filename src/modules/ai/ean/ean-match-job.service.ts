import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import type { EanMatchItemStatus, EanMatchJobStatus } from './ean-match.types';
import { SpreadsheetEanMatchService } from './spreadsheet-ean-match.service';

/** Teto padrão de custo de IA por job, em dólares. */
export const DEFAULT_JOB_COST_CAP_USD = 50;

const INSERT_CHUNK = 500;

export interface JobProgress {
  job: EanMatchJob;
  porStatus: Partial<Record<EanMatchItemStatus, number>>;
  costUsd: number;
  costCapUsd: number;
}

/**
 * Jobs de vínculo EAN planilha→galeria (openspec vinculo-ean-planilha-alta-confianca).
 *
 * A ingestão só persiste as linhas: quem processa é o `EanMatchRunnerService`,
 * em segundo plano. Assim a requisição de upload responde na hora e o estado
 * do job sobrevive a um restart do backend.
 */
@Injectable()
export class EanMatchJobService {
  private readonly logger = new Logger(EanMatchJobService.name);
  private readonly defaultCostCap: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly planilha: SpreadsheetEanMatchService,
    configService: ConfigService,
  ) {
    const raw = Number.parseFloat(
      configService.get<string>('EAN_JOB_COST_CAP_USD', String(DEFAULT_JOB_COST_CAP_USD)),
    );
    this.defaultCostCap = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_JOB_COST_CAP_USD;
  }

  /** Lê a planilha, cria o job e seus itens. Não processa nada. */
  async criarJob(
    buffer: Buffer,
    options: { fileName?: string | null; clientId?: string | null; costCapUsd?: number } = {},
  ): Promise<{ jobId: string; itens: number; descartadas: number; totalLinhas: number }> {
    const { linhas, totalLinhas, semEan } = this.planilha.lerPlanilha(buffer);
    const fileHash = createHash('sha256').update(buffer).digest('hex');
    const costCap = options.costCapUsd ?? this.defaultCostCap;

    const jobId = await this.dataSource.transaction(async (manager) => {
      const job = await manager.save(
        manager.create(EanMatchJob, {
          status: 'running' as EanMatchJobStatus,
          fileName: options.fileName ?? null,
          fileHash,
          clientId: options.clientId ?? null,
          totalRows: linhas.length,
          discardedRows: semEan,
          costCapUsd: costCap.toFixed(4),
        }),
      );

      for (let i = 0; i < linhas.length; i += INSERT_CHUNK) {
        const lote = linhas.slice(i, i + INSERT_CHUNK).map((l) => ({
          jobId: job.id,
          rowNumber: l.linha,
          ean: l.ean,
          description: l.descricao,
          status: 'pending' as EanMatchItemStatus,
        }));
        await manager.insert(EanMatchItem, lote);
      }
      return job.id;
    });

    this.logger.log(
      `Job ${jobId}: ${linhas.length} itens, ${semEan} linhas descartadas, teto US$${costCap}`,
    );
    return { jobId, itens: linhas.length, descartadas: semEan, totalLinhas };
  }

  async buscarJob(jobId: string): Promise<EanMatchJob> {
    const job = await this.dataSource.getRepository(EanMatchJob).findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} não encontrado`);
    return job;
  }

  async progresso(jobId: string): Promise<JobProgress> {
    const job = await this.buscarJob(jobId);
    const rows: Array<{ status: EanMatchItemStatus; n: number }> = await this.dataSource.query(
      `SELECT status, COUNT(*)::int AS n FROM ean_match_items WHERE "jobId" = $1 GROUP BY status`,
      [jobId],
    );
    const porStatus: JobProgress['porStatus'] = {};
    for (const r of rows) porStatus[r.status] = r.n;
    return { job, porStatus, costUsd: Number(job.costUsd), costCapUsd: Number(job.costCapUsd) };
  }

  async pausar(jobId: string): Promise<EanMatchJob> {
    await this.buscarJob(jobId);
    await this.dataSource.query(
      `UPDATE ean_match_jobs SET status = 'paused', "updatedAt" = now()
        WHERE id = $1 AND status IN ('pending', 'running')`,
      [jobId],
    );
    return this.buscarJob(jobId);
  }

  /** Retoma um job pausado; opcionalmente eleva o teto de custo. */
  async retomar(jobId: string, costCapUsd?: number): Promise<EanMatchJob> {
    const job = await this.buscarJob(jobId);
    const teto = costCapUsd ?? Number(job.costCapUsd);
    await this.dataSource.query(
      `UPDATE ean_match_jobs
          SET status = 'running', "costCapUsd" = $2, error = NULL, "updatedAt" = now()
        WHERE id = $1 AND status IN ('paused', 'failed', 'done')`,
      [jobId, teto.toFixed(4)],
    );
    return this.buscarJob(jobId);
  }

  async listarItens(
    jobId: string,
    filtro: { status?: EanMatchItemStatus; limit?: number; offset?: number } = {},
  ): Promise<{ total: number; itens: EanMatchItem[] }> {
    const [itens, total] = await this.dataSource.getRepository(EanMatchItem).findAndCount({
      where: { jobId, ...(filtro.status ? { status: filtro.status } : {}) },
      order: { rowNumber: 'ASC' },
      take: Math.min(Math.max(filtro.limit ?? 50, 1), 500),
      skip: Math.max(filtro.offset ?? 0, 0),
    });
    return { total, itens };
  }

  async listarJobs(limit = 20): Promise<EanMatchJob[]> {
    return this.dataSource
      .getRepository(EanMatchJob)
      .find({ order: { createdAt: 'DESC' }, take: Math.min(Math.max(limit, 1), 100) });
  }
}
