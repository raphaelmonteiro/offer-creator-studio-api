import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { ImportItemResult, ImportJobStatus } from './dotcompany.types';
import { parseImportFile } from './ean-import-file.parser';
import { EanImportStore, JobCounts } from './ean-import.store';
import { EanImportJob } from './entities/ean-import-job.entity';

export interface JobView extends EanImportJob {
  counts: JobCounts;
  /** Custo em reais (1 crédito = R$ 0,01). */
  costBrl: string;
}

/** Criação e operação dos jobs de importação do catálogo DotCompany. */
@Injectable()
export class EanImportJobService {
  private readonly defaultCapCredits: number;

  constructor(
    private readonly store: EanImportStore,
    configService: ConfigService,
  ) {
    const cap = Number.parseInt(
      configService.get<string>('EAN_IMPORT_DEFAULT_CAP_CREDITS') ?? '',
      10,
    );
    this.defaultCapCredits = Number.isFinite(cap) && cap >= 0 ? cap : 12_000;
  }

  /** Cria o job de um cadastro (CSV/XLSX). O mesmo arquivo devolve o job que já existe. */
  async criarJobDeArquivo(
    buffer: Buffer,
    options: { fileName?: string | null; clientId?: string | null; costCapCredits?: number | null },
  ): Promise<{
    job: JobView;
    created: boolean;
    columns?: { ean: string; description: string | null };
  }> {
    const fileHash = createHash('sha256').update(buffer).digest('hex');
    const existing = await this.store.buscarPorHash(fileHash);
    if (existing) return { job: await this.view(existing), created: false };

    const parsed = parseImportFile(buffer);
    const job = await this.store.criarJob({
      kind: 'file',
      fileName: options.fileName ?? null,
      fileHash,
      clientId: options.clientId ?? null,
      costCapCredits: options.costCapCredits ?? this.defaultCapCredits,
      rows: parsed.rows,
    });
    return { job: await this.view(job), created: true, columns: parsed.columns };
  }

  /** Job interno com os EANs de um encarte que não terminaram no prazo da requisição. */
  async criarJobDoEncarte(
    eans: Array<{ ean: string; description: string }>,
    clientId: string | null,
  ): Promise<EanImportJob> {
    return this.store.criarJob({
      kind: 'flyer',
      clientId,
      costCapCredits: 0,
      rows: eans.map((e, i) => ({ rowNumber: i + 1, ean: e.ean, description: e.description })),
    });
  }

  async listar(limit?: number): Promise<JobView[]> {
    const jobs = await this.store.listarJobs(limit);
    return Promise.all(jobs.map((j) => this.view(j)));
  }

  async detalhe(jobId: string): Promise<JobView> {
    return this.view(await this.buscar(jobId));
  }

  async itens(
    jobId: string,
    filtro: { result?: ImportItemResult | 'pending'; page?: number; limit?: number },
  ) {
    await this.buscar(jobId);
    return this.store.listarItens(jobId, filtro);
  }

  /** Pausa manual: só volta com `retomar`. */
  async pausar(jobId: string): Promise<JobView> {
    await this.buscar(jobId);
    const ok = await this.store.mudarStatus(
      jobId,
      ['pending', 'running', 'waiting_budget'],
      'paused',
    );
    if (!ok)
      throw new BadRequestException(
        'Só dá para pausar um job pendente, em execução ou esperando orçamento.',
      );
    return this.detalhe(jobId);
  }

  /** Retoma um job pausado (manual, teto ou falha). Com `costCapCredits`, troca o teto. */
  async retomar(jobId: string, costCapCredits?: number | null): Promise<JobView> {
    const job = await this.buscar(jobId);
    const de: ImportJobStatus[] = ['paused', 'paused_cap', 'failed', 'waiting_budget'];
    if (!de.includes(job.status)) {
      throw new BadRequestException(`Job está "${job.status}": nada para retomar.`);
    }
    if (costCapCredits !== undefined && costCapCredits !== null) {
      await this.store.definirTeto(jobId, costCapCredits);
    }
    await this.store.mudarStatus(jobId, de, 'pending');
    return this.detalhe(jobId);
  }

  private async buscar(jobId: string): Promise<EanImportJob> {
    const job = await this.store.buscarJob(jobId);
    if (!job) throw new NotFoundException('Job de importação não encontrado.');
    return job;
  }

  private async view(job: EanImportJob): Promise<JobView> {
    return {
      ...job,
      counts: await this.store.contagens(job.id),
      costBrl: (job.costCredits / 100).toFixed(2),
    };
  }
}
