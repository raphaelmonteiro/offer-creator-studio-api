import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GalleryEmbeddingService } from '../gallery-embedding.service';
import { ProductMetadata } from '../metadata/product-metadata.schema';
import type { EanCandidateRecord } from './ean-match.types';
import { Gs1PrefixMap } from './gs1-prefix-map';
import { normalizeBrand } from './gtin.util';
import { normalizeText, overlapScore } from './variant-token.util';

/** Candidatas que seguem para o juiz, depois dos vetos. */
export const TOP_K = 12;
/** Quantas vêm de cada fonte antes da intercalação. */
const PER_SOURCE = 12;
/** A galeria e o mapa GS1 são recarregados depois disso (fotos novas entram). */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface ImagemGaleria {
  id: string;
  filename: string;
  url: string;
  metadata: ProductMetadata;
  /** Título + variante + nome do arquivo: o texto comparado com a planilha. */
  texto: string;
  marcaNorm: string;
}

export interface IndiceGaleria {
  porId: Map<string, ImagemGaleria>;
  porEan: Map<string, ImagemGaleria[]>;
  porMarca: Map<string, ImagemGaleria[]>;
}

/**
 * Gera candidatas para uma linha da planilha, com foco em RECALL: a decisão
 * é do juiz, então aqui o pior erro é deixar a imagem certa de fora.
 *
 * Duas fontes intercaladas por posição (as escalas dos scores não são
 * comparáveis): imagens da marca citada na descrição, por Jaccard de tokens,
 * e busca vetorial em `metadata_embedding`, que alcança as ~15% de imagens
 * sem marca no metadata.
 */
@Injectable()
export class EanCandidateService {
  private readonly logger = new Logger(EanCandidateService.name);
  private indiceCache: { at: number; value: Promise<IndiceGaleria> } | null = null;
  private prefixCache: { at: number; value: Promise<Gs1PrefixMap> } | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embedding: GalleryEmbeddingService,
  ) {}

  indice(): Promise<IndiceGaleria> {
    if (!this.indiceCache || Date.now() - this.indiceCache.at > CACHE_TTL_MS) {
      this.indiceCache = { at: Date.now(), value: this.carregarIndice() };
      this.indiceCache.value.catch(() => (this.indiceCache = null));
    }
    return this.indiceCache.value;
  }

  prefixMap(): Promise<Gs1PrefixMap> {
    if (!this.prefixCache || Date.now() - this.prefixCache.at > CACHE_TTL_MS) {
      this.prefixCache = { at: Date.now(), value: this.carregarPrefixMap() };
      this.prefixCache.value.catch(() => (this.prefixCache = null));
    }
    return this.prefixCache.value;
  }

  /** Esquece os caches — usado depois de gravar vínculos. */
  invalidar(): void {
    this.indiceCache = null;
    this.prefixCache = null;
  }

  private async carregarIndice(): Promise<IndiceGaleria> {
    const rows: Array<{ id: string; filename: string; url: string; metadata: ProductMetadata }> =
      await this.dataSource.query(
        `SELECT id, filename, url, metadata FROM gallery_images WHERE metadata IS NOT NULL`,
      );
    const indice = montarIndice(rows);
    this.logger.log(
      `Índice da galeria: ${indice.porId.size} imagens, ${indice.porMarca.size} marcas`,
    );
    return indice;
  }

  private async carregarPrefixMap(): Promise<Gs1PrefixMap> {
    const mapa = new Gs1PrefixMap();
    // Só fontes confiáveis: o dump da OFF (o GTIN é o próprio registro) e
    // vínculos verificados na galeria. EANs `off` inferidos NÃO entram —
    // medimos 82,7% de precisão neles, e o mapa ensinaria os erros.
    // `off_products` é criada pelo script de ingestão da OFF; sem ela o mapa
    // só aprende com a galeria.
    if (await tabelaExiste(this.dataSource, 'off_products')) {
      const off: Array<{ gtin: string; brand: string }> = await this.dataSource.query(
        `SELECT gtin, brand_raw AS brand FROM off_products WHERE brand_raw IS NOT NULL`,
      );
      for (const r of off) mapa.add(r.gtin, r.brand);
    }

    const galeria: Array<{ ean: string; brand: string }> = await this.dataSource.query(
      `SELECT metadata->>'ean' AS ean, metadata->'alternatives'->0->>'brand' AS brand
         FROM gallery_images
        WHERE metadata->>'ean' IS NOT NULL
          AND (metadata->>'eanSource' IN ('manual', 'erp', 'barcode-scan')
               OR metadata->>'eanVerifiedBy' IN ('exact', 'human'))`,
    );
    for (const r of galeria) mapa.add(r.ean, r.brand);
    this.logger.log(`Mapa GS1: ${mapa.size} prefixos`);
    return mapa;
  }

  /** Candidatas antes dos vetos, já intercaladas e sem limite de K. */
  async gerar(descricao: string, indice: IndiceGaleria): Promise<EanCandidateRecord[]> {
    const porMarca = candidatasPorMarca(descricao, indice.porMarca)
      .map((img) => ({ img, s: overlapScore(descricao, img.texto) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, PER_SOURCE * 2);

    const porVetor: Array<{ img: ImagemGaleria; s: number }> = [];
    const vetor = await this.embedding.embedText(normalizeText(descricao));
    if (vetor) {
      const achados = await this.embedding.searchByMetadataEmbedding(vetor, PER_SOURCE * 2);
      for (const a of achados) {
        const img = indice.porId.get(a.id);
        if (img) porVetor.push({ img, s: Math.max(0, 1 - a.distance) });
      }
    }

    return intercalar(descricao, porMarca, porVetor);
  }
}

export function montarIndice(
  rows: Array<{ id: string; filename: string; url: string; metadata: ProductMetadata }>,
): IndiceGaleria {
  const porId = new Map<string, ImagemGaleria>();
  const porEan = new Map<string, ImagemGaleria[]>();
  const porMarca = new Map<string, ImagemGaleria[]>();

  for (const row of rows) {
    const alt = row.metadata.alternatives?.[0];
    const img: ImagemGaleria = {
      id: row.id,
      filename: row.filename,
      url: row.url,
      metadata: row.metadata,
      texto: [row.metadata.title, alt?.variant, row.filename.replace(/\.[a-z0-9]+$/i, '')]
        .filter((p): p is string => Boolean(p && p.trim()))
        .join(' '),
      marcaNorm: normalizeBrand(alt?.brand),
    };
    porId.set(img.id, img);
    if (row.metadata.ean) {
      const lista = porEan.get(row.metadata.ean) ?? [];
      lista.push(img);
      porEan.set(row.metadata.ean, lista);
    }
    if (img.marcaNorm) {
      const lista = porMarca.get(img.marcaNorm) ?? [];
      lista.push(img);
      porMarca.set(img.marcaNorm, lista);
    }
  }
  return { porId, porEan, porMarca };
}

/** Imagens cuja marca aparece como token ou bigrama na descrição. */
export function candidatasPorMarca(
  descricao: string,
  porMarca: Map<string, ImagemGaleria[]>,
): ImagemGaleria[] {
  const tokens = normalizeText(descricao).split(' ').filter(Boolean);
  const chaves = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    chaves.add(tokens[i]);
    if (i + 1 < tokens.length) chaves.add(`${tokens[i]} ${tokens[i + 1]}`);
    if (i + 2 < tokens.length) chaves.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  const out = new Map<string, ImagemGaleria>();
  for (const chave of chaves) for (const img of porMarca.get(chave) ?? []) out.set(img.id, img);
  return [...out.values()];
}

/** Intercala as duas listas por posição, deduplicando e juntando os scores. */
export function intercalar(
  descricao: string,
  porMarca: Array<{ img: ImagemGaleria; s: number }>,
  porVetor: Array<{ img: ImagemGaleria; s: number }>,
): EanCandidateRecord[] {
  const out = new Map<string, EanCandidateRecord>();
  const n = Math.max(porMarca.length, porVetor.length);
  for (let i = 0; i < n; i++) {
    for (const [lista, origem] of [
      [porMarca, 'brand'],
      [porVetor, 'vector'],
    ] as const) {
      const c = lista[i];
      if (!c) continue;
      const atual = out.get(c.img.id) ?? paraRegistro(descricao, c.img);
      if (origem === 'brand') atual.textScore = round(c.s);
      else atual.vectorScore = round(c.s);
      if (!atual.origins.includes(origem)) atual.origins.push(origem);
      atual.score = Math.max(atual.textScore ?? 0, atual.vectorScore ?? 0);
      out.set(c.img.id, atual);
    }
  }
  return [...out.values()];
}

function paraRegistro(descricao: string, img: ImagemGaleria): EanCandidateRecord {
  const alt = img.metadata.alternatives?.[0];
  const q = img.metadata.quantity;
  return {
    imageId: img.id,
    filename: img.filename,
    url: img.url,
    title: img.metadata.title ?? null,
    brand: alt?.brand ?? null,
    variant: alt?.variant ?? null,
    quantity: q && q.value ? `${q.value}${q.unit ?? ''}` : null,
    score: 0,
    textScore: round(overlapScore(descricao, img.texto)),
    vectorScore: null,
    origins: [],
    vetoes: [],
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export async function tabelaExiste(dataSource: DataSource, tabela: string): Promise<boolean> {
  const [row]: Array<{ ok: boolean }> = await dataSource.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [tabela],
  );
  return Boolean(row?.ok);
}
