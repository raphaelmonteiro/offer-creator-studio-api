import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EanCalibrationService } from './ean-calibration.service';
import { EanCandidateService, TOP_K } from './ean-candidate.service';
import { decidir } from './ean-decision';
import { EanJudgeService } from './ean-judge.service';
import { EanMatchCommitService } from './ean-match-commit.service';
import type { EanItemProcessor, ItemOutcome } from './ean-match-runner.service';
import type { EanCandidateRecord, JudgmentRecord } from './ean-match.types';
import { EanReferenceService } from './ean-reference.service';
import { aplicarVetos } from './ean-veto';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';

/**
 * O pipeline de um item (design §1):
 *
 *   EAN exato? → candidatas → vetos → referência → juiz A + juiz B → regra
 *
 * Cada estágio grava sua evidência no item, para auditoria e para a fila de
 * revisão. A gravação na galeria NÃO acontece aqui: só em `finalizarJob`,
 * depois que todos os itens foram decididos, porque a checagem de colisão
 * precisa enxergar o job inteiro.
 */
@Injectable()
export class EanItemPipelineService implements EanItemProcessor {
  private readonly logger = new Logger(EanItemPipelineService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly candidatas: EanCandidateService,
    private readonly referencias: EanReferenceService,
    private readonly juiz: EanJudgeService,
    private readonly calibracao: EanCalibrationService,
    private readonly commit: EanMatchCommitService,
  ) {}

  async processar(item: EanMatchItem, job: EanMatchJob): Promise<ItemOutcome> {
    const versao = this.juiz.version();
    if (job.judgeVersion !== versao) {
      await this.dataSource.query(
        `UPDATE ean_match_jobs SET "judgeVersion" = $2 WHERE id = $1 AND "judgeVersion" IS DISTINCT FROM $2`,
        [job.id, versao],
      );
      job.judgeVersion = versao;
    }

    const indice = await this.candidatas.indice();

    // 1) EAN exato: a galeria já tem esse código. É a única decisão sem IA.
    const exatas = indice.porEan.get(item.ean);
    if (exatas && exatas.length > 0) {
      return {
        patch: {
          status: 'exact',
          candidates: exatas.map((img) => ({
            imageId: img.id,
            filename: img.filename,
            url: img.url,
            title: img.metadata.title ?? null,
            brand: img.metadata.alternatives?.[0]?.brand ?? null,
            variant: img.metadata.alternatives?.[0]?.variant ?? null,
            quantity: null,
            score: 1,
            textScore: null,
            vectorScore: null,
            origins: [],
            vetoes: [],
          })),
        },
        costUsd: 0,
      };
    }

    // 2) Candidatas + 3) vetos.
    const todas = await this.candidatas.gerar(item.description, indice);
    const vivas = aplicarVetos(
      item.description,
      item.ean,
      todas,
      indice.porId,
      await this.candidatas.prefixMap(),
    ).slice(0, TOP_K);
    const vetadas = todas.filter((c) => c.vetoes.length > 0).slice(0, TOP_K);
    const registradas: EanCandidateRecord[] = [...vivas, ...vetadas];

    if (vivas.length === 0) {
      return { patch: { status: 'no-image', candidates: registradas }, costUsd: 0 };
    }

    // Mesmo EAN com o mesmo conjunto de candidatas já foi julgado (reenvio da
    // planilha, outro cliente): reaproveita sem pagar de novo.
    const anterior = await this.julgamentoAnterior(item, vivas, versao);
    let custo = 0;
    let reference = anterior?.reference ?? null;
    let judgments: JudgmentRecord[] = anterior?.judgments ?? [];

    if (!anterior) {
      // 4) Referência oficial.
      const ref = await this.referencias.resolver(item.ean);
      reference = ref.reference;
      custo += ref.costUsd;

      // 5) Juízes independentes.
      if (!this.juiz.isEnabled()) throw new Error('juiz indisponível: OPENAI_API_KEY ausente');
      const input = {
        itemId: item.id,
        ean: item.ean,
        descricao: item.description,
        reference,
        candidatas: vivas,
      };
      const imagens = await this.juiz.prepararImagens(input);
      if (imagens.candidatas.length === 0) {
        return {
          patch: {
            status: 'review',
            reviewReason: 'unreadable-images',
            candidates: registradas,
            reference,
          },
          costUsd: custo,
        };
      }
      judgments = await Promise.all([
        this.juiz.julgar('A', input, imagens),
        this.juiz.julgar('B', input, imagens),
      ]);
      custo += judgments.reduce((s, j) => s + j.costUsd, 0);
    }

    // 6) Regra de auto-aceite.
    const decisao = decidir({
      judgments,
      reference,
      descricao: item.description,
      calibracaoLiberada: await this.calibracao.autoAceiteLiberado(versao),
    });

    return {
      patch: {
        status: decisao.status,
        reviewReason: decisao.reviewReason,
        candidates: registradas,
        reference,
        judgments,
        aiDecision: decisao.aiDecision,
      },
      costUsd: custo,
    };
  }

  async finalizarJob(job: EanMatchJob): Promise<void> {
    await this.commit.gravarJob(job.id);
    this.candidatas.invalidar();
  }

  /**
   * Busca um item de qualquer job com o mesmo EAN, julgado pela mesma versão
   * do juiz, sobre exatamente o mesmo conjunto de candidatas.
   */
  private async julgamentoAnterior(
    item: EanMatchItem,
    vivas: EanCandidateRecord[],
    versao: string,
  ): Promise<Pick<EanMatchItem, 'reference' | 'judgments'> | null> {
    const ids = vivas.map((c) => c.imageId).sort();
    const rows: Array<Pick<EanMatchItem, 'reference' | 'judgments' | 'candidates'>> =
      await this.dataSource.query(
        `SELECT i.reference, i.judgments, i.candidates
         FROM ean_match_items i
         JOIN ean_match_jobs j ON j.id = i."jobId"
        WHERE i.ean = $1 AND i.id <> $2
          AND jsonb_array_length(i.judgments) = 2
          AND j."judgeVersion" = $3
        ORDER BY i."updatedAt" DESC
        LIMIT 5`,
        [item.ean, item.id, versao],
      );
    for (const r of rows) {
      if (r.judgments.some((j) => j.error)) continue;
      // Julgado sem referência: vale julgar de novo, a referência pode ter
      // aparecido (cache "none" expirou, Cosmos ligado, busca melhorada).
      if (!r.reference || r.reference.source === 'none') continue;
      const anteriores = r.candidates
        .filter((c) => c.vetoes.length === 0)
        .map((c) => c.imageId)
        .sort();
      if (anteriores.length === ids.length && anteriores.every((id, i) => id === ids[i])) {
        this.logger.log(`Item ${item.id}: reaproveitando julgamento anterior do EAN ${item.ean}`);
        return { reference: r.reference, judgments: r.judgments };
      }
    }
    return null;
  }
}
