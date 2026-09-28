import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ProductMetadata } from '../metadata/product-metadata.schema';
import { EanMatchItem } from './entities/ean-match-item.entity';
import type { EanMatchItemStatus, EanReviewReason } from './ean-match.types';

/** Status de item cuja decisão aponta imagens para um EAN. */
const DECIDIDOS: EanMatchItemStatus[] = ['exact', 'auto-accepted', 'human-accepted', 'written'];

export interface ColisaoResultado {
  /** Itens mandados para revisão por disputarem imagem com outro EAN. */
  paraRevisao: string[];
}

/**
 * Gravação dos vínculos na galeria e reversão por job (spec
 * spreadsheet-ean-linking, design §8).
 *
 * Nada aqui decide identidade de produto — só aplica o que a adjudicação ou
 * o revisor decidiram, com as travas que protegem a galeria: uma imagem
 * nunca recebe dois EANs no mesmo job, EAN `manual` ou de outro ERP nunca é
 * sobrescrito em silêncio, e o metadata anterior fica guardado.
 */
@Injectable()
export class EanMatchCommitService {
  private readonly logger = new Logger(EanMatchCommitService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Imagens que a decisão do item aponta, conforme quem decidiu. */
  static imagensDoItem(item: EanMatchItem): string[] {
    if (item.status === 'written') return item.writtenImageIds;
    if (item.status === 'human-accepted') return item.humanDecision?.imageIds ?? [];
    if (item.status === 'auto-accepted') return item.aiDecision?.imageIds ?? [];
    if (item.status === 'exact') return item.candidates.map((c) => c.imageId);
    return [];
  }

  /** Quem decidiu o item: EAN exato na galeria, revisor humano ou a IA. */
  static origem(item: EanMatchItem): 'exact' | 'human' | 'ai' {
    if (item.humanDecision && item.humanDecision.decision === 'match') return 'human';
    if (item.status === 'exact' || (item.status === 'written' && !item.aiDecision)) return 'exact';
    return 'ai';
  }

  /**
   * Checagem de colisão dentro do job: uma imagem disputada por EANs
   * diferentes manda para revisão os itens decididos pela IA. Decisão humana
   * e EAN exato prevalecem sobre a IA; um item já gravado pela IA que perde a
   * disputa é revertido antes.
   */
  async resolverColisoes(jobId: string): Promise<ColisaoResultado> {
    const itens = await this.dataSource.getRepository(EanMatchItem).find({
      where: DECIDIDOS.map((status) => ({ jobId, status })),
    });

    const porImagem = new Map<string, EanMatchItem[]>();
    for (const item of itens) {
      for (const img of EanMatchCommitService.imagensDoItem(item)) {
        const lista = porImagem.get(img) ?? [];
        lista.push(item);
        porImagem.set(img, lista);
      }
    }

    // Na disputa por uma imagem entre EANs diferentes, só a IA perde: EAN
    // exato e decisão humana são autoridade. (Humano × humano é barrado na
    // hora da decisão, na fila de revisão.)
    const perdedores = new Map<string, EanMatchItem>();
    for (const disputa of porImagem.values()) {
      if (new Set(disputa.map((i) => i.ean)).size < 2) continue;
      for (const item of disputa) {
        if (EanMatchCommitService.origem(item) === 'ai') perdedores.set(item.id, item);
      }
    }

    for (const item of perdedores.values()) {
      if (item.status === 'written') await this.reverterItem(item);
      await this.marcarRevisao(item.id, 'collision');
    }
    if (perdedores.size > 0) {
      this.logger.warn(`Job ${jobId}: ${perdedores.size} itens em colisão foram para revisão`);
    }
    return { paraRevisao: [...perdedores.keys()] };
  }

  /** Grava todos os itens aceitos e ainda não gravados do job. */
  async gravarJob(jobId: string): Promise<{ gravados: number; conflitos: number }> {
    await this.resolverColisoes(jobId);
    const pendentes = await this.dataSource.getRepository(EanMatchItem).find({
      where: [
        { jobId, status: 'exact' },
        { jobId, status: 'auto-accepted' },
        { jobId, status: 'human-accepted' },
      ],
      order: { rowNumber: 'ASC' },
    });
    let gravados = 0;
    let conflitos = 0;
    for (const item of pendentes) {
      const r = await this.gravarItem(item);
      if (r === 'written') gravados += 1;
      else if (r !== 'noop') conflitos += 1;
    }
    this.logger.log(`Job ${jobId}: ${gravados} itens gravados, ${conflitos} em conflito`);
    return { gravados, conflitos };
  }

  /**
   * Grava um item em uma transação, travando as linhas das imagens. Checa
   * TODAS as imagens antes de escrever qualquer uma: ou o item grava inteiro,
   * ou vai para revisão sem ter mexido na galeria.
   */
  async gravarItem(item: EanMatchItem): Promise<'written' | EanReviewReason | 'noop'> {
    const imagens = EanMatchCommitService.imagensDoItem(item);
    if (imagens.length === 0) return 'noop';
    const origem = EanMatchCommitService.origem(item);
    const verificadoPor = origem === 'ai' ? 'ai-consensus' : origem;

    const resultado = await this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string; metadata: ProductMetadata }> = await manager.query(
        `SELECT id, metadata FROM gallery_images WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
        [imagens],
      );
      if (rows.length !== imagens.length) return 'processing-error' as const;

      for (const { metadata } of rows) {
        const conflito = conflitoDeFonte(metadata, item.ean);
        if (conflito) return conflito;
      }

      const anteriores: Record<string, ProductMetadata> = {};
      const agora = new Date().toISOString();
      for (const { id, metadata } of rows) {
        anteriores[id] = metadata;
        const proximo: ProductMetadata = {
          ...metadata,
          ean: item.ean,
          eanSource: 'erp',
          eanConfidence: verificadoPor === 'ai-consensus' ? 0.99 : 1,
          eanVerifiedAt: agora,
          eanStatus: 'resolved',
          eanVerifiedBy: verificadoPor,
          eanJobId: item.jobId,
          warnings: [
            ...(metadata.warnings ?? []),
            `erp-match: job ${item.jobId.slice(0, 8)} linha ${item.rowNumber} "${item.description.slice(0, 60)}"`,
          ],
        };
        await manager.query(`UPDATE gallery_images SET metadata = $1::jsonb WHERE id = $2`, [
          JSON.stringify(proximo),
          id,
        ]);
      }
      await this.atualizarItem(manager, item.id, {
        status: 'written',
        writtenImageIds: imagens,
        previousMetadata: anteriores,
      });
      return 'written' as const;
    });

    if (resultado !== 'written') await this.marcarRevisao(item.id, resultado);
    return resultado;
  }

  /**
   * Desfaz as gravações de um job. Só restaura imagens cujo metadata ainda
   * carrega este job — se outra fonte gravou depois, a imagem fica e é
   * listada como não revertida.
   */
  async reverterJob(jobId: string): Promise<{ revertidas: number; naoRevertidas: string[] }> {
    const itens = await this.dataSource
      .getRepository(EanMatchItem)
      .find({ where: { jobId, status: 'written' } });
    let revertidas = 0;
    const naoRevertidas: string[] = [];
    for (const item of itens) {
      const r = await this.reverterItem(item);
      revertidas += r.revertidas;
      naoRevertidas.push(...r.naoRevertidas);
      await this.dataSource
        .getRepository(EanMatchItem)
        .update({ id: item.id }, { status: 'reverted' });
    }
    this.logger.log(
      `Job ${jobId} revertido: ${revertidas} imagens, ${naoRevertidas.length} mantidas`,
    );
    return { revertidas, naoRevertidas };
  }

  private async reverterItem(
    item: EanMatchItem,
  ): Promise<{ revertidas: number; naoRevertidas: string[] }> {
    let revertidas = 0;
    const naoRevertidas: string[] = [];
    await this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string; metadata: ProductMetadata }> = await manager.query(
        `SELECT id, metadata FROM gallery_images WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
        [item.writtenImageIds],
      );
      for (const { id, metadata } of rows) {
        const anterior = item.previousMetadata?.[id];
        if (!anterior || metadata.eanJobId !== item.jobId || metadata.ean !== item.ean) {
          naoRevertidas.push(id);
          continue;
        }
        await manager.query(`UPDATE gallery_images SET metadata = $1::jsonb WHERE id = $2`, [
          JSON.stringify(anterior),
          id,
        ]);
        revertidas += 1;
      }
    });
    return { revertidas, naoRevertidas };
  }

  private async marcarRevisao(itemId: string, motivo: EanReviewReason): Promise<void> {
    await this.dataSource
      .getRepository(EanMatchItem)
      .update({ id: itemId }, { status: 'review', reviewReason: motivo });
  }

  private async atualizarItem(
    manager: EntityManager,
    itemId: string,
    patch: Partial<EanMatchItem>,
  ): Promise<void> {
    await manager.getRepository(EanMatchItem).update({ id: itemId }, patch as never);
  }
}

/**
 * Pode gravar `ean` por cima do que a imagem tem? EAN `manual` diferente é
 * palavra final de humano; EAN de outro ERP diferente significa que um dos
 * dois cadastros está errado — os dois casos vão para revisão. EAN igual, ou
 * de fonte mais fraca (off, visão, cosmos), é substituído.
 */
export function conflitoDeFonte(
  metadata: ProductMetadata,
  ean: string,
): 'manual-conflict' | 'erp-conflict' | null {
  if (!metadata.ean || metadata.ean === ean) return null;
  if (metadata.eanSource === 'manual') return 'manual-conflict';
  if (metadata.eanSource === 'erp') return 'erp-conflict';
  return null;
}
