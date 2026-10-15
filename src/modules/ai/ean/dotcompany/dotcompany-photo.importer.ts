import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { GalleryService } from '../../../gallery/gallery.service';
import { UploadsService } from '../../../uploads/uploads.service';
import { DotcompanyLookupService } from './dotcompany-lookup.service';
import { DotcompanyMetadataBuilder } from './dotcompany-metadata.builder';
import type { ConsumerKind, DotcompanyProduct } from './dotcompany.types';
import { DotcompanyLookup } from './entities/dotcompany-lookup.entity';

/** Pasta da galeria onde as fotos importadas ficam (para o operador filtrar). */
export const DOTCOMPANY_GALLERY_FOLDER = 'DotCompany';

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Teto de pixels decodificados pelo sharp (proteção contra imagem-bomba). */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Hosts de onde a foto pode vir: DotCompany e o Backblaze para onde ela redireciona. */
const ALLOWED_HOSTS = ['app.dotcompany.com.br', 'erp.dotcompany.com.br'];
const ALLOWED_HOST_SUFFIXES = ['.backblazeb2.com'];

/** A `imagem_url` é dado de terceiro: só https e só hosts conhecidos (evita SSRF). */
export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return (
    ALLOWED_HOSTS.includes(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export type PhotoImportStatus = 'imported' | 'already_exists' | 'no_image' | 'error';

export interface PhotoImportResult {
  ean: string;
  status: PhotoImportStatus;
  galleryImageId: string | null;
  reason?: string | null;
}

/** A URL assinada da DotCompany venceu (o Backblaze responde 401/403/404/410). */
class ExpiredImageUrlError extends Error {}

/**
 * Leva a foto de um EAN encontrado na DotCompany para a galeria do Chroma:
 * baixa NA HORA (a `imagem_url` é assinada e expira em ~12 dias), normaliza
 * para PNG com fundo branco, salva no armazenamento próprio e registra a
 * imagem com metadata de EAN exato — sem extração por visão.
 *
 * No máximo uma foto DotCompany por EAN: `dotcompany_lookups.galleryImageId`
 * é a fonte de verdade e o índice único parcial da galeria é o reforço.
 */
@Injectable()
export class DotcompanyPhotoImporter {
  private readonly logger = new Logger(DotcompanyPhotoImporter.name);
  /** Injetável para testes. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  private readonly importing = new Map<string, Promise<PhotoImportResult>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly lookups: DotcompanyLookupService,
    private readonly metadataBuilder: DotcompanyMetadataBuilder,
    private readonly uploads: UploadsService,
    private readonly gallery: GalleryService,
  ) {}

  /**
   * Importa as fotos de vários EANs já encontrados (concorrência limitada).
   * A foto DotCompany NÃO vira preferida de cliente: a preferência é só do que o
   * cliente escolhe. O prazo de quem chamou não cancela download nem importação:
   * `signal` só impede começar novos itens.
   */
  async importMany(
    items: Array<{ ean: string; lookup: DotcompanyLookup }>,
    options: {
      kind: ConsumerKind;
      concurrency?: number;
      signal?: AbortSignal;
    },
  ): Promise<Map<string, PhotoImportResult>> {
    const results = new Map<string, PhotoImportResult>();
    const pending: Array<{ ean: string; lookup: DotcompanyLookup; product: DotcompanyProduct }> =
      [];

    for (const item of items) {
      const existing = await this.existingImageId(item.lookup);
      if (existing) {
        results.set(item.ean, {
          ean: item.ean,
          status: 'already_exists',
          galleryImageId: existing,
        });
        continue;
      }
      const product = item.lookup.raw?.produto ?? null;
      if (!product) {
        results.set(item.ean, {
          ean: item.ean,
          status: 'no_image',
          galleryImageId: null,
          reason: 'sem dados do produto',
        });
        continue;
      }
      if (!product.imagem_url) {
        results.set(item.ean, {
          ean: item.ean,
          status: 'no_image',
          galleryImageId: null,
          reason: 'DotCompany sem foto',
        });
        continue;
      }
      pending.push({ ean: item.ean, lookup: item.lookup, product });
    }

    if (pending.length === 0) return results;

    // Metadata de todos de uma vez: o parser de nomes trabalha em lote.
    const metadatas = await this.metadataBuilder.build(
      pending.map((p) => ({ ean: p.ean, product: p.product })),
      this.lookups.now(),
    );
    const metadataByEan = new Map(pending.map((p, i) => [p.ean, metadatas[i]]));

    const queue = [...pending];
    const workers = Array.from(
      { length: Math.max(1, Math.min(options.concurrency ?? 4, queue.length)) },
      async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (options.signal?.aborted) {
            results.set(next.ean, {
              ean: next.ean,
              status: 'error',
              galleryImageId: null,
              reason: 'prazo esgotado',
            });
            continue;
          }
          results.set(
            next.ean,
            await this.importOne(next.ean, next.lookup, metadataByEan.get(next.ean)!, options),
          );
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  /** Um EAN importado por vez neste processo: encarte e job não baixam a mesma foto em paralelo. */
  private importOne(
    ean: string,
    lookup: DotcompanyLookup,
    metadata: Record<string, unknown> & { ean?: string | null },
    options: { kind: ConsumerKind; signal?: AbortSignal },
  ): Promise<PhotoImportResult> {
    const running = this.importing.get(ean);
    if (running) return running;
    const promise = this.importNow(ean, lookup, metadata, options).finally(() =>
      this.importing.delete(ean),
    );
    this.importing.set(ean, promise);
    return promise;
  }

  private async importNow(
    ean: string,
    lookup: DotcompanyLookup,
    metadata: Record<string, unknown> & { ean?: string | null },
    options: { kind: ConsumerKind; signal?: AbortSignal },
  ): Promise<PhotoImportResult> {
    let url = lookup.raw?.produto?.imagem_url ?? null;
    try {
      let buffer: Buffer;
      try {
        buffer = await this.download(url!, options.signal);
      } catch (err) {
        if (!(err instanceof ExpiredImageUrlError)) throw err;
        // URL vencida: reconsulta o EAN (com ETag) para pegar uma URL nova.
        const refreshed = await this.lookups.refreshOne(ean, {
          kind: options.kind,
          signal: options.signal,
        });
        const newUrl = refreshed.lookup?.raw?.produto?.imagem_url ?? null;
        if (refreshed.status !== 'updated' || !newUrl || newUrl === url) {
          return {
            ean,
            status: 'error',
            galleryImageId: null,
            reason: `URL da foto expirada (${refreshed.reason ?? refreshed.status})`,
          };
        }
        url = newUrl;
        buffer = await this.download(url, options.signal);
      }

      const png = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
      const filename = `dotcompany-${ean}.png`;
      const uploaded = await this.uploads.uploadFile(
        {
          buffer: png,
          originalname: filename,
          size: png.length,
          mimetype: 'image/png',
          fieldname: 'file',
          encoding: '7bit',
        } as Express.Multer.File,
        'gallery',
      );

      const { image, created } = await this.gallery.registerImportedImage({
        filename,
        url: uploaded.url,
        mimeType: 'image/png',
        size: png.length,
        metadata,
        folderName: DOTCOMPANY_GALLERY_FOLDER,
      });
      if (!created) {
        // Outro processo importou o mesmo EAN no meio do caminho: descarta o arquivo duplicado.
        await this.uploads.deleteFile(`gallery/${uploaded.id}`);
      }
      await this.lookups.setGalleryImage(ean, image.id);
      return { ean, status: created ? 'imported' : 'already_exists', galleryImageId: image.id };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`Falha ao importar foto DotCompany do EAN ${ean}: ${msg}`);
      return { ean, status: 'error', galleryImageId: null, reason: msg };
    }
  }

  /** A foto DotCompany registrada para o EAN, se ainda existir na galeria. */
  private async existingImageId(lookup: DotcompanyLookup): Promise<string | null> {
    if (lookup.galleryImageId) {
      const rows = await this.dataSource.query(`SELECT id FROM gallery_images WHERE id = $1`, [
        lookup.galleryImageId,
      ]);
      if (rows.length) return lookup.galleryImageId;
      // A imagem foi apagada da galeria: importa de novo.
      await this.lookups.setGalleryImage(lookup.ean, null);
    }
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM gallery_images
        WHERE metadata->>'ean' = $1
          AND metadata->>'eanSource' = 'dotcompany' AND metadata->>'eanVerifiedBy' = 'exact'
        LIMIT 1`,
      [lookup.ean],
    );
    if (rows[0]) {
      await this.lookups.setGalleryImage(lookup.ean, rows[0].id);
      return rows[0].id;
    }
    return null;
  }

  private async download(url: string, outer?: AbortSignal): Promise<Buffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`timeout de ${DOWNLOAD_TIMEOUT_MS}ms`)),
      DOWNLOAD_TIMEOUT_MS,
    );
    const onAbort = () => ctrl.abort(outer?.reason ?? new Error('aborted'));
    if (outer?.aborted) onAbort();
    else outer?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchFollowingAllowedRedirects(url, ctrl.signal);
      if ([401, 403, 404, 410].includes(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        throw new ExpiredImageUrlError(`download da foto → ${res.status}`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`download da foto → ${res.status}`);
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('image/')) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`conteúdo não é imagem (${type || 'sem content-type'})`);
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_IMAGE_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`imagem maior que ${MAX_IMAGE_BYTES} bytes`);
      }
      const buffer = await this.readLimited(res);
      if (buffer.length === 0) throw new Error('imagem vazia');
      return buffer;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** Segue redirects à mão (máx. 3), validando esquema e host a cada salto. */
  private async fetchFollowingAllowedRedirects(
    startUrl: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      if (!isAllowedImageUrl(url)) {
        throw new Error(`URL da foto fora da lista permitida (${safeHost(url)})`);
      }
      const res = await this.fetchImpl(url, { signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect sem Location (${res.status})`);
      if (hop >= MAX_REDIRECTS) throw new Error(`redirects demais (mais de ${MAX_REDIRECTS})`);
      url = new URL(location, url).toString();
    }
  }

  /** Lê o corpo por stream e aborta ao passar de 5 MB, sem carregar o excedente. */
  private async readLimited(res: Response): Promise<Buffer> {
    const reader = res.body?.getReader();
    if (!reader) {
      const all = Buffer.from(await res.arrayBuffer());
      if (all.length > MAX_IMAGE_BYTES)
        throw new Error(`imagem maior que ${MAX_IMAGE_BYTES} bytes`);
      return all;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`imagem maior que ${MAX_IMAGE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'URL inválida';
  }
}
