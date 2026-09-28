import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { EanCalibrationService } from './ean-calibration.service';
import { EanMatchCommitService } from './ean-match-commit.service';
import type { EanMatchItemStatus, EanReviewReason, HumanDecisionRecord } from './ean-match.types';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';

export const DEFAULT_CALIBRATION_SAMPLE = 200;

export interface DecisaoRevisor {
  decision: 'match' | 'none' | 'skip';
  imageIds?: string[];
}

/** Item como o revisor vê: nos de calibração a opinião da IA fica oculta. */
export type ItemRevisao = Omit<EanMatchItem, 'judgments' | 'aiDecision' | 'previousMetadata'> & {
  judgments: EanMatchItem['judgments'] | null;
  aiDecision: EanMatchItem['aiDecision'] | null;
  concorrentes: Array<{ itemId: string; ean: string; description: string; imageIds: string[] }>;
};

/**
 * Fila de revisão humana (spec ean-review-queue). A decisão humana é a
 * palavra final do item e é gravada na galeria na hora; também vira rótulo
 * para a calibração do auto-aceite.
 */
@Injectable()
export class EanReviewService {
  private readonly logger = new Logger(EanReviewService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commit: EanMatchCommitService,
    private readonly calibracao: EanCalibrationService,
  ) {}

  async listar(filtro: {
    jobId?: string;
    limit?: number;
    offset?: number;
    calibracao?: boolean;
  }): Promise<{
    total: number;
    itens: ItemRevisao[];
  }> {
    const repo = this.dataSource.getRepository(EanMatchItem);
    const [itens, total] = await repo.findAndCount({
      where: {
        status: 'review',
        ...(filtro.jobId ? { jobId: filtro.jobId } : {}),
        ...(filtro.calibracao !== undefined ? { isCalibration: filtro.calibracao } : {}),
      },
      // Calibração primeiro (destrava o auto-aceite), depois pela ordem da planilha.
      order: { isCalibration: 'DESC', rowNumber: 'ASC' },
      take: Math.min(Math.max(filtro.limit ?? 20, 1), 100),
      skip: Math.max(filtro.offset ?? 0, 0),
    });
    const comContexto = await Promise.all(itens.map((i) => this.paraRevisor(i)));
    return { total, itens: comContexto };
  }

  async buscar(itemId: string): Promise<ItemRevisao> {
    return this.paraRevisor(await this.item(itemId));
  }

  /**
   * Registra a decisão do revisor e grava na galeria. Humano × humano sobre a
   * mesma imagem com EANs diferentes é recusado (409) — um dos dois errou e o
   * revisor precisa ver o outro item.
   */
  async decidir(itemId: string, d: DecisaoRevisor, userId: string): Promise<ItemRevisao> {
    const item = await this.item(itemId);
    if (item.status !== 'review') {
      throw new BadRequestException(`Item não está em revisão (status: ${item.status})`);
    }
    if (d.decision === 'skip') return this.paraRevisor(item);

    const imageIds = d.decision === 'match' ? [...new Set(d.imageIds ?? [])] : [];
    if (d.decision === 'match') {
      if (imageIds.length === 0) throw new BadRequestException('Escolha ao menos uma imagem');
      const conhecidas = new Set(item.candidates.map((c) => c.imageId));
      const estranha = imageIds.find((id) => !conhecidas.has(id));
      if (estranha) throw new BadRequestException(`Imagem ${estranha} não é candidata deste item`);

      const conflito = await this.conflitoHumano(item, imageIds);
      if (conflito) {
        throw new ConflictException(
          `A imagem já foi atribuída por um revisor ao EAN ${conflito.ean} (linha ${conflito.rowNumber}: "${conflito.description}")`,
        );
      }
    }

    const humanDecision: HumanDecisionRecord = {
      decision: d.decision,
      imageIds,
      userId,
      decidedAt: new Date().toISOString(),
    };
    const status: EanMatchItemStatus = d.decision === 'match' ? 'human-accepted' : 'human-none';
    await this.dataSource
      .getRepository(EanMatchItem)
      .update({ id: item.id }, { status, reviewReason: null, humanDecision });

    if (d.decision === 'match') {
      // A IA que disputava essas imagens perde (e é revertida se já gravou).
      await this.commit.resolverColisoes(item.jobId);
      const atualizado = await this.item(item.id);
      const r = await this.commit.gravarItem(atualizado);
      if (r !== 'written') {
        this.logger.warn(`Decisão humana do item ${item.id} não gravou: ${r}`);
      }
    }
    return this.buscar(item.id);
  }

  /**
   * Amostra estratificada para calibração: motivo × faixa de score. Entram
   * inclusive itens que a IA aceitaria sozinha — senão a precisão medida
   * seria só a dos casos difíceis. Os itens voltam para a fila marcados como
   * calibração, e nada deles é gravado até o humano decidir.
   */
  async montarAmostraCalibracao(
    jobId: string,
    tamanho = DEFAULT_CALIBRATION_SAMPLE,
  ): Promise<{
    selecionados: number;
    estratos: Record<string, number>;
  }> {
    const candidatos = await this.dataSource.getRepository(EanMatchItem).find({
      where: {
        jobId,
        isCalibration: false,
        status: In(['review', 'auto-accepted', 'no-image'] as EanMatchItemStatus[]),
      },
      select: ['id', 'status', 'reviewReason', 'candidates', 'aiDecision', 'humanDecision'],
    });
    const elegiveis = candidatos.filter((i) => i.aiDecision && !i.humanDecision);

    const estratos = new Map<string, string[]>();
    for (const i of elegiveis) {
      const chave = `${estratoDe(i)}|${faixaDeScore(i)}`;
      const lista = estratos.get(chave) ?? [];
      lista.push(i.id);
      estratos.set(chave, lista);
    }

    const escolhidos = alocarProporcional(estratos, tamanho);
    if (escolhidos.length > 0) {
      await this.dataSource
        .getRepository(EanMatchItem)
        .update(
          { id: In(escolhidos) },
          { isCalibration: true, status: 'review', reviewReason: 'calibration-sample' },
        );
    }

    const contagem: Record<string, number> = {};
    const escolhidosSet = new Set(escolhidos);
    for (const [chave, ids] of estratos)
      contagem[chave] = ids.filter((id) => escolhidosSet.has(id)).length;
    this.logger.log(`Job ${jobId}: amostra de calibração com ${escolhidos.length} itens`);
    return { selecionados: escolhidos.length, estratos: contagem };
  }

  /**
   * Depois de uma calibração aprovada: itens que só não foram aceitos por
   * falta de calibração viram auto-aceitos e são gravados, sem chamar a IA
   * de novo.
   */
  async reavaliarAposCalibracao(jobId: string): Promise<{ aceitos: number; gravados: number }> {
    const job = await this.dataSource.getRepository(EanMatchJob).findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job ${jobId} não encontrado`);
    if (!job.judgeVersion || !(await this.calibracao.autoAceiteLiberado(job.judgeVersion))) {
      throw new BadRequestException(
        'Auto-aceite não está liberado para a versão do juiz deste job',
      );
    }

    const itens = await this.dataSource.getRepository(EanMatchItem).find({
      where: { jobId, status: 'review', reviewReason: 'calibration-off', isCalibration: false },
    });
    const aceitos = itens.filter(
      (i) => i.aiDecision?.autoAcceptEligible && i.aiDecision.decision !== 'none',
    );
    const nenhum = itens.filter(
      (i) => i.aiDecision?.autoAcceptEligible && i.aiDecision.decision === 'none',
    );
    if (aceitos.length) {
      await this.dataSource
        .getRepository(EanMatchItem)
        .update(
          { id: In(aceitos.map((i) => i.id)) },
          { status: 'auto-accepted', reviewReason: null },
        );
    }
    if (nenhum.length) {
      await this.dataSource
        .getRepository(EanMatchItem)
        .update({ id: In(nenhum.map((i) => i.id)) }, { status: 'no-image', reviewReason: null });
    }
    const { gravados } = await this.commit.gravarJob(jobId);
    return { aceitos: aceitos.length, gravados };
  }

  private async item(itemId: string): Promise<EanMatchItem> {
    const item = await this.dataSource.getRepository(EanMatchItem).findOneBy({ id: itemId });
    if (!item) throw new NotFoundException(`Item ${itemId} não encontrado`);
    return item;
  }

  private async conflitoHumano(
    item: EanMatchItem,
    imageIds: string[],
  ): Promise<EanMatchItem | null> {
    const outros = await this.dataSource.getRepository(EanMatchItem).find({
      where: {
        jobId: item.jobId,
        status: In(['human-accepted', 'written'] as EanMatchItemStatus[]),
      },
    });
    const alvo = new Set(imageIds);
    return (
      outros.find(
        (o) =>
          o.id !== item.id &&
          o.ean !== item.ean &&
          EanMatchCommitService.origem(o) === 'human' &&
          EanMatchCommitService.imagensDoItem(o).some((id) => alvo.has(id)),
      ) ?? null
    );
  }

  /** Itens do mesmo job que disputam alguma candidata deste (colisões). */
  private async paraRevisor(item: EanMatchItem): Promise<ItemRevisao> {
    const ids = item.candidates.map((c) => c.imageId);
    const concorrentes: ItemRevisao['concorrentes'] = [];
    if (item.reviewReason === 'collision' && ids.length) {
      const rows: Array<{ id: string; ean: string; description: string; imageIds: string[] }> =
        await this.dataSource.query(
          `SELECT id, ean, description,
                  COALESCE("humanDecision"->'imageIds', "aiDecision"->'imageIds', '[]'::jsonb) AS "imageIds"
             FROM ean_match_items
            WHERE "jobId" = $1 AND id <> $2
              AND COALESCE("humanDecision"->'imageIds', "aiDecision"->'imageIds', '[]'::jsonb) ?| $3`,
          [item.jobId, item.id, ids],
        );
      for (const r of rows) {
        concorrentes.push({
          itemId: r.id,
          ean: r.ean,
          description: r.description,
          imageIds: r.imageIds,
        });
      }
    }

    const { previousMetadata: _omit, ...resto } = item;
    return {
      ...resto,
      judgments: item.isCalibration ? null : item.judgments,
      aiDecision: item.isCalibration ? null : item.aiDecision,
      concorrentes,
    };
  }
}

/** Estrato pelo motivo (ou status) com que o item saiu da adjudicação. */
export function estratoDe(i: Pick<EanMatchItem, 'status' | 'reviewReason'>): string {
  return i.status === 'review' ? ((i.reviewReason as EanReviewReason) ?? 'review') : i.status;
}

/** Faixa do melhor score entre as candidatas sobreviventes. */
export function faixaDeScore(i: Pick<EanMatchItem, 'candidates'>): string {
  const vivas = i.candidates.filter((c) => c.vetoes.length === 0);
  const top = Math.max(0, ...vivas.map((c) => c.score));
  return top >= 0.6 ? 'alto' : top >= 0.35 ? 'medio' : 'baixo';
}

/**
 * Alocação proporcional ao tamanho do estrato, com pelo menos 1 por estrato
 * não vazio (enquanto couber), sorteio aleatório dentro de cada um.
 */
export function alocarProporcional(estratos: Map<string, string[]>, tamanho: number): string[] {
  const total = [...estratos.values()].reduce((s, l) => s + l.length, 0);
  if (total === 0 || tamanho <= 0) return [];
  if (total <= tamanho) return [...estratos.values()].flat();

  const cotas = new Map<string, number>();
  for (const [k, l] of estratos)
    cotas.set(k, Math.max(1, Math.floor((l.length / total) * tamanho)));
  // Ajusta para bater exatamente o tamanho: tira dos maiores, põe nos com
  // sobra. Para quando uma volta inteira não consegue mexer (ex.: mais
  // estratos que vagas — aí alguns estratos ficam com 1 e a amostra excede).
  let soma = [...cotas.values()].reduce((s, n) => s + n, 0);
  const ordem = [...estratos.keys()].sort(
    (a, b) => estratos.get(b)!.length - estratos.get(a)!.length,
  );
  const ajustar = (podeMexer: (k: string) => boolean, delta: number, continuar: () => boolean) => {
    let semProgresso = 0;
    for (let i = 0; continuar() && semProgresso < ordem.length; i = (i + 1) % ordem.length) {
      const k = ordem[i];
      if (podeMexer(k)) {
        cotas.set(k, cotas.get(k)! + delta);
        soma += delta;
        semProgresso = 0;
      } else {
        semProgresso += 1;
      }
    }
  };
  ajustar(
    (k) => cotas.get(k)! > 1,
    -1,
    () => soma > tamanho,
  );
  ajustar(
    (k) => cotas.get(k)! < estratos.get(k)!.length,
    +1,
    () => soma < tamanho,
  );

  const out: string[] = [];
  for (const [k, l] of estratos) {
    const embaralhado = [...l].sort(() => Math.random() - 0.5);
    out.push(...embaralhado.slice(0, cotas.get(k)));
  }
  return out;
}
