import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { tabelaExiste } from './ean-candidate.service';
import type { EanReferenceRecord } from './ean-match.types';
import { EanReference } from './entities/ean-reference.entity';

export interface ReferenceResult {
  reference: EanReferenceRecord;
  costUsd: number;
}

/**
 * Referência de um EAN SEM API externa (decisão do usuário, 2026-09-28):
 *
 * - a base local `off_products` (dump da Open Food Facts), quando conhece o
 *   EAN: nome completo, marca, quantidade e foto — em cache em `ean_references`;
 * - senão, a descrição do próprio cadastro do cliente, que é o dado do PDV
 *   para aquele EAN. Não entra no cache: é específica de cada item.
 *
 * A segurança do auto-aceite não depende de a referência ser externa: vem do
 * consenso dos juízes, do rótulo compatível e da calibração.
 */
@Injectable()
export class EanReferenceService {
  private readonly logger = new Logger(EanReferenceService.name);
  private offDisponivel: boolean | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async resolver(ean: string, descricaoCadastro: string): Promise<ReferenceResult> {
    const local = await this.daBaseLocal(ean);
    if (local) return { reference: local, costUsd: 0 };
    return {
      reference: {
        ean,
        source: 'erp',
        name: descricaoCadastro,
        brand: null,
        quantity: null,
        imageUrl: null,
      },
      costUsd: 0,
    };
  }

  /** `off_products` local, com cache. Sem a tabela (ambiente sem o dump), devolve null. */
  async daBaseLocal(ean: string): Promise<EanReferenceRecord | null> {
    const repo = this.dataSource.getRepository(EanReference);
    const cache = await repo.findOne({ where: { ean } });
    if (cache && cache.source === 'off') return paraRegistro(cache);

    if (this.offDisponivel === null) {
      this.offDisponivel = await tabelaExiste(this.dataSource, 'off_products');
      if (!this.offDisponivel) this.logger.log('off_products ausente: referência só pelo cadastro');
    }
    if (!this.offDisponivel) return null;

    const variantes = [...new Set([ean, ean.replace(/^0+/, ''), ean.padStart(13, '0')])];
    const rows: Array<{
      product_name: string | null;
      brand_raw: string | null;
      quantity_raw: string | null;
      image_url: string | null;
    }> = await this.dataSource.query(
      `SELECT product_name, brand_raw, quantity_raw, image_url
         FROM off_products WHERE gtin = ANY($1) LIMIT 1`,
      [variantes],
    );
    const r = rows[0];
    if (!r || !r.product_name) return null;

    const registro: EanReferenceRecord = {
      ean,
      source: 'off',
      name: r.product_name,
      brand: r.brand_raw,
      quantity: r.quantity_raw,
      imageUrl: r.image_url,
    };
    await repo.save({ ...registro, raw: r });
    return registro;
  }
}

function paraRegistro(r: EanReference): EanReferenceRecord {
  return {
    ean: r.ean,
    source: r.source,
    name: r.name,
    brand: r.brand,
    quantity: r.quantity,
    imageUrl: r.imageUrl,
  };
}
