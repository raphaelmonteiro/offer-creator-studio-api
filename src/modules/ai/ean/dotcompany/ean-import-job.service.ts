import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { ImportItemResult, ImportJobStatus } from './dotcompany.types';
import { parseImportFile } from './ean-import-file.parser';
import { EanImportStore, JobCounts, NewImportRow } from './ean-import.store';
import { EanImportJob } from './entities/ean-import-job.entity';
import { classifyEan, CREDITS_PER_FOUND } from './dotcompany-lookup.service';

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

  /** Simula contra a galeria: não cria job, não grava nem chama provedores. */
  async previewArquivo(buffer: Buffer) {
    const parsed = parseImportFile(buffer);
    const classified = parsed.rows.map((row) => ({ row, code: classifyEan(row.ean) }));
    const gallery = await this.store.buscarImagensPorEan(
      classified
        .filter(({ row, code }) => !row.result && code.status === 'valid')
        .map(({ code }) => code.ean),
    );
    const items = parsed.rows.map((row) => this.previewItem(row, gallery));
    const counts = {
      already_exists: 0,
      needs_lookup: 0,
      invalid: 0,
      internal_use: 0,
      duplicate: 0,
    };
    for (const item of items) counts[item.result] += 1;
    const maxCredits = counts.needs_lookup * CREDITS_PER_FOUND;
    return {
      dryRun: true,
      totalRows: items.length,
      columns: parsed.columns,
      counts,
      maxCredits,
      maxCostBrl: (maxCredits / 100).toFixed(2),
      items,
    };
  }

  private previewItem(row: NewImportRow, gallery: Map<string, string>) {
    const code = classifyEan(row.ean);
    const galleryImageId = gallery.get(code.ean) ?? null;
    const result =
      row.result ??
      (code.status !== 'valid' ? code.status : galleryImageId ? 'already_exists' : 'needs_lookup');
    return {
      rowNumber: row.rowNumber,
      ean: code.ean,
      description: row.description,
      result,
      galleryImageId: result === 'already_exists' ? galleryImageId : null,
      reason: row.reason ?? (code.status !== 'valid' ? code.reason : null),
    };
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
