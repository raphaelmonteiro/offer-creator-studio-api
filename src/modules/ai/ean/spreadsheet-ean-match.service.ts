import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as XLSX from 'xlsx';
import { GalleryEmbeddingService } from '../gallery-embedding.service';
import { canOverwriteEan, ProductMetadata } from '../metadata/product-metadata.schema';
import {
  canonicalQuantity,
  isPlausibleRetailGtin,
  normalizeBrand,
  normalizeGtin,
  parseFreeTextQuantity,
  quantityMatches,
} from './gtin.util';
import { normalizeText, overlapScore, variantGate } from './variant-token.util';

/**
 * Feature 14 — Fase 5: casar planilha do cliente com a galeria e VINCULAR o EAN.
 *
 * Entrada: CSV/XLSX do ERP ou do encarte do cliente. Para cada linha que traz
 * um EAN válido, procura na galeria a imagem daquele produto e grava o EAN no
 * `metadata` dela com `eanSource: 'erp'`.
 *
 * Precedência: `erp` (80) está acima de `off` (20), então o EAN do cliente
 * sobrescreve o que a Open Food Facts inferiu — e a divergência entre os dois
 * é reportada, porque ela mede a precisão real da resolução por OFF.
 *
 * Tudo determinístico: nenhuma chamada de LLM. Reaproveita os mesmos portões
 * da Fase 2-bis (conflito de variante, quantidade, margem).
 */

const MARGIN_MIN = 0.2;
const CONFIDENCE_EAN_EXACT = 1;
const CONFIDENCE_DESCRIPTION = 0.85;
const MIN_OVERLAP = 0.15;

export interface PlanilhaLinha {
  linha: number;
  eanBruto: string;
  ean: string;
  descricao: string;
}

export interface LinhaResultado {
  linha: number;
  ean: string;
  descricao: string;
  status: 'ean-exato' | 'casada-por-descricao' | 'ambigua' | 'sem-imagem';
  imagemId?: string;
  filename?: string;
  url?: string;
  score?: number;
  conflitoCom?: string;
}

interface ImagemIndexada {
  id: string;
  filename: string;
  url: string;
  metadata: ProductMetadata;
  texto: string;
  marcaNorm: string;
}

@Injectable()
export class SpreadsheetEanMatchService {
  private readonly logger = new Logger(SpreadsheetEanMatchService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embedding: GalleryEmbeddingService,
  ) {}

  /**
   * Detecta as colunas pelo CONTEÚDO, não pelo cabeçalho.
   *
   * O arquivo real do cliente tem cabeçalho imprevisível — no exemplo que
   * recebemos a coluna de descrição se chamava "FLV 17 A 20 SETEMBRO". Então:
   * a coluna de EAN é a que tem mais valores aprovados no checksum GS1, e a de
   * descrição é a com mais texto por célula entre as demais.
   */
  detectarColunas(linhas: unknown[][]): { ean: number; descricao: number } | null {
    if (linhas.length === 0) return null;
    const nCols = Math.max(...linhas.map((l) => l.length));

    let colEan = -1;
    let melhorContagem = 0;
    for (let c = 0; c < nCols; c++) {
      let validos = 0;
      for (const linha of linhas) {
        const v = linha[c];
        if (v == null) continue;
        const g = normalizeGtin(String(v));
        if (g && isPlausibleRetailGtin(g)) validos += 1;
      }
      if (validos > melhorContagem) {
        melhorContagem = validos;
        colEan = c;
      }
    }
    if (colEan < 0 || melhorContagem === 0) return null;

    let colDesc = -1;
    let melhorTexto = 0;
    for (let c = 0; c < nCols; c++) {
      if (c === colEan) continue;
      let letras = 0;
      for (const linha of linhas) {
        const v = linha[c];
        if (typeof v !== 'string') continue;
        letras += v.replace(/[^A-Za-zÀ-ÿ]/g, '').length;
      }
      if (letras > melhorTexto) {
        melhorTexto = letras;
        colDesc = c;
      }
    }
    if (colDesc < 0) return null;

    return { ean: colEan, descricao: colDesc };
  }

  /** Lê CSV ou XLSX e devolve só as linhas que trazem EAN válido. */
  lerPlanilha(buffer: Buffer): { linhas: PlanilhaLinha[]; totalLinhas: number; semEan: number } {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grade = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });

    const cols = this.detectarColunas(grade);
    if (!cols) return { linhas: [], totalLinhas: grade.length, semEan: grade.length };

    const linhas: PlanilhaLinha[] = [];
    let semEan = 0;

    for (let i = 0; i < grade.length; i++) {
      const bruto = grade[i][cols.ean];
      const descricao = String(grade[i][cols.descricao] ?? '').trim();
      const ean = bruto == null ? null : normalizeGtin(String(bruto));

      if (!ean || !isPlausibleRetailGtin(ean) || !descricao) {
        semEan += 1;
        continue;
      }
      linhas.push({ linha: i + 1, eanBruto: String(bruto), ean, descricao });
    }

    return { linhas, totalLinhas: grade.length, semEan };
  }

  /**
   * Carrega a galeria em memória e indexa por marca. São ~13k registros — cabe
   * com folga, e evita uma query por linha da planilha.
   */
  private async carregarGaleria(): Promise<{
    porEan: Map<string, ImagemIndexada>;
    porMarca: Map<string, ImagemIndexada[]>;
    todas: ImagemIndexada[];
  }> {
    const rows: Array<{
      id: string;
      filename: string;
      url: string;
      metadata: ProductMetadata;
    }> = await this.dataSource.query(
      `SELECT id, filename, url, metadata
         FROM gallery_images
        WHERE metadata IS NOT NULL`,
    );

    const porEan = new Map<string, ImagemIndexada>();
    const porMarca = new Map<string, ImagemIndexada[]>();
    const todas: ImagemIndexada[] = [];

    for (const row of rows) {
      const alt = row.metadata.alternatives?.[0];
      const img: ImagemIndexada = {
        id: row.id,
        filename: row.filename,
        url: row.url,
        metadata: row.metadata,
        texto: [row.metadata.title, alt?.variant, row.filename.replace(/\.[a-z0-9]+$/i, '')]
          .filter((p): p is string => Boolean(p && p.trim()))
          .join(' '),
        marcaNorm: normalizeBrand(alt?.brand),
      };
      todas.push(img);

      const eanExistente = row.metadata.ean;
      if (eanExistente) porEan.set(eanExistente, img);

      if (img.marcaNorm) {
        const lista = porMarca.get(img.marcaNorm) ?? [];
        lista.push(img);
        porMarca.set(img.marcaNorm, lista);
      }
    }

    return { porEan, porMarca, todas };
  }

  /**
   * Candidatas: imagens cuja MARCA aparece como token (ou bigrama) na
   * descrição da planilha. Reduz de 13k para uma dezena sem varrer tudo.
   */
  private candidatasPorMarca(
    descricao: string,
    porMarca: Map<string, ImagemIndexada[]>,
  ): ImagemIndexada[] {
    const texto = normalizeText(descricao);
    const tokens = texto.split(' ').filter(Boolean);
    const chaves = new Set<string>();

    for (let i = 0; i < tokens.length; i++) {
      chaves.add(tokens[i]);
      if (i + 1 < tokens.length) chaves.add(`${tokens[i]} ${tokens[i + 1]}`);
    }

    const out = new Map<string, ImagemIndexada>();
    for (const chave of chaves) {
      for (const img of porMarca.get(chave) ?? []) out.set(img.id, img);
    }
    return [...out.values()];
  }

  /** Casa uma linha contra a galeria. Determinístico, sem LLM. */
  private casarLinha(
    linha: PlanilhaLinha,
    indice: Awaited<ReturnType<typeof this.carregarGaleria>>,
  ): LinhaResultado {
    // 1) EAN exato — a imagem já carrega esse código.
    const exata = indice.porEan.get(linha.ean);
    if (exata) {
      return {
        linha: linha.linha,
        ean: linha.ean,
        descricao: linha.descricao,
        status: 'ean-exato',
        imagemId: exata.id,
        filename: exata.filename,
        url: exata.url,
        score: CONFIDENCE_EAN_EXACT,
      };
    }

    // 2) Por descrição, com os mesmos portões da Fase 2-bis.
    const qtdLinha = parseFreeTextQuantity(linha.descricao);
    const candidatas = this.candidatasPorMarca(linha.descricao, indice.porMarca)
      .filter((img) => variantGate(linha.descricao, img.texto).pass)
      .filter((img) => {
        // Quantidade só reprova quando os DOIS lados declaram e divergem.
        const qtdImg = canonicalQuantity(img.metadata.quantity);
        if (!qtdLinha || !qtdImg) return true;
        return quantityMatches(qtdLinha, qtdImg);
      })
      .map((img) => ({ img, score: overlapScore(linha.descricao, img.texto) }))
      .filter((c) => c.score >= MIN_OVERLAP)
      .sort((a, b) => b.score - a.score);

    if (candidatas.length === 0) {
      return {
        linha: linha.linha,
        ean: linha.ean,
        descricao: linha.descricao,
        status: 'sem-imagem',
      };
    }

    const margem = candidatas[0].score - (candidatas[1]?.score ?? 0);
    if (candidatas.length > 1 && margem < MARGIN_MIN) {
      return {
        linha: linha.linha,
        ean: linha.ean,
        descricao: linha.descricao,
        status: 'ambigua',
      };
    }

    const vencedora = candidatas[0];
    return {
      linha: linha.linha,
      ean: linha.ean,
      descricao: linha.descricao,
      status: 'casada-por-descricao',
      imagemId: vencedora.img.id,
      filename: vencedora.img.filename,
      url: vencedora.img.url,
      score: Number(vencedora.score.toFixed(4)),
      conflitoCom:
        vencedora.img.metadata.ean && vencedora.img.metadata.ean !== linha.ean
          ? vencedora.img.metadata.ean
          : undefined,
    };
  }

  /**
   * Processa a planilha inteira. Com `dryRun`, mede sem gravar.
   */
  async processar(
    buffer: Buffer,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    totalLinhas: number;
    semEan: number;
    comEan: number;
    eanExato: number;
    casadaPorDescricao: number;
    ambigua: number;
    semImagem: number;
    vinculadas: number;
    conflitosComOff: Array<{ imagemId: string; filename: string; eanOff: string; eanErp: string }>;
    resultados: LinhaResultado[];
    dryRun: boolean;
  }> {
    const dryRun = options.dryRun ?? false;
    const { linhas, totalLinhas, semEan } = this.lerPlanilha(buffer);
    const indice = await this.carregarGaleria();

    const resultados: LinhaResultado[] = [];
    const conflitosComOff: Array<{
      imagemId: string;
      filename: string;
      eanOff: string;
      eanErp: string;
    }> = [];
    let vinculadas = 0;

    // Uma imagem não pode receber dois EANs diferentes da mesma planilha.
    const jaVinculada = new Set<string>();

    for (const linha of linhas) {
      const r = this.casarLinha(linha, indice);
      resultados.push(r);

      if (r.status !== 'casada-por-descricao' || !r.imagemId) continue;
      if (jaVinculada.has(r.imagemId)) {
        r.status = 'ambigua';
        continue;
      }

      const img = indice.todas.find((i) => i.id === r.imagemId);
      if (!img) continue;

      // A divergência entre o EAN do ERP e o que a OFF inferiu é o dado mais
      // valioso deste processo: mede a precisão real da Fase 2.
      if (r.conflitoCom && img.metadata.eanSource === 'off') {
        conflitosComOff.push({
          imagemId: img.id,
          filename: img.filename,
          eanOff: r.conflitoCom,
          eanErp: linha.ean,
        });
      }

      if (!canOverwriteEan(img.metadata.eanSource ?? null, 'erp')) continue;
      jaVinculada.add(r.imagemId);
      vinculadas += 1;

      if (dryRun) continue;

      const proximo: ProductMetadata = {
        ...img.metadata,
        ean: linha.ean,
        eanSource: 'erp',
        eanConfidence: CONFIDENCE_DESCRIPTION,
        eanVerifiedAt: new Date().toISOString(),
        eanStatus: 'resolved',
        warnings: [
          ...(img.metadata.warnings ?? []),
          `erp-match: linha ${linha.linha} "${linha.descricao.slice(0, 60)}"`,
        ],
      };
      await this.embedding.saveImageMetadata(img.id, proximo);
    }

    const conta = (s: LinhaResultado['status']) => resultados.filter((r) => r.status === s).length;
    const resumo = {
      totalLinhas,
      semEan,
      comEan: linhas.length,
      eanExato: conta('ean-exato'),
      casadaPorDescricao: conta('casada-por-descricao'),
      ambigua: conta('ambigua'),
      semImagem: conta('sem-imagem'),
      vinculadas,
      conflitosComOff,
      resultados,
      dryRun,
    };

    this.logger.log(
      `Planilha: ${totalLinhas} linhas, ${linhas.length} com EAN → ${resumo.eanExato} exatas, ` +
        `${resumo.casadaPorDescricao} por descrição, ${resumo.ambigua} ambíguas, ` +
        `${resumo.semImagem} sem imagem, ${vinculadas} vinculadas${dryRun ? ' (dry-run)' : ''}`,
    );

    return resumo;
  }
}
