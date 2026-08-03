import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Vínculo N:N entre clientes e imagens da galeria — tabela
 * `client_preferred_images`, criada no bootstrap SQL.
 *
 * O cliente funciona como **tag de curadoria**: uma imagem pode servir a N
 * clientes sem ser duplicada e sem sair da pasta onde mora. É lido pelo
 * matching (Feature 12, prioriza as fotos do cliente) e escrito pela marcação
 * na galeria (Feature 13).
 *
 * Usa SQL cru via DataSource, no mesmo estilo do GalleryEmbeddingService,
 * porque `gallery_images` é `{ synchronize: false }` e esta tabela é gerenciada
 * por SQL — não por entidades TypeORM.
 */
@Injectable()
export class ClientPreferredImagesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Feature 13 — define a lista completa de clientes de UMA imagem (substitui).
   * Roda em transação: remove o que saiu, insere o que entrou.
   */
  async setClientsForImage(imageId: string, clientIds: string[]): Promise<{ clientIds: string[] }> {
    await this.assertImageExists(imageId);
    const unique = [...new Set(clientIds)];

    await this.dataSource.transaction(async (manager) => {
      if (unique.length === 0) {
        await manager.query(`DELETE FROM client_preferred_images WHERE image_id = $1`, [imageId]);
        return;
      }
      await manager.query(
        `DELETE FROM client_preferred_images
          WHERE image_id = $1 AND client_id <> ALL($2::uuid[])`,
        [imageId, unique],
      );
      await manager.query(
        `INSERT INTO client_preferred_images (client_id, image_id)
         SELECT c.id, $1 FROM clients c WHERE c.id = ANY($2::uuid[])
         ON CONFLICT (client_id, image_id) DO NOTHING`,
        [imageId, unique],
      );
    });

    return { clientIds: unique };
  }

  /**
   * Feature 13 — marcação em lote (o que torna viável curar centenas de fotos).
   * - `add`: vincula sem remover nada (idempotente)
   * - `remove`: desvincula apenas os pares enviados
   * - `replace`: as imagens enviadas passam a ter exatamente esses clientes
   *
   * O INSERT filtra por `clients` existentes, então ids inválidos são ignorados
   * em vez de estourar FK no meio de um lote grande.
   */
  async bulkAssign(
    imageIds: string[],
    clientIds: string[],
    mode: 'add' | 'remove' | 'replace',
  ): Promise<{ affectedImages: number }> {
    const images = [...new Set(imageIds)];
    const clients = [...new Set(clientIds)];
    if (images.length === 0) return { affectedImages: 0 };

    await this.dataSource.transaction(async (manager) => {
      if (mode === 'remove') {
        if (clients.length === 0) return;
        await manager.query(
          `DELETE FROM client_preferred_images
            WHERE image_id = ANY($1::uuid[]) AND client_id = ANY($2::uuid[])`,
          [images, clients],
        );
        return;
      }

      if (mode === 'replace') {
        if (clients.length === 0) {
          await manager.query(
            `DELETE FROM client_preferred_images WHERE image_id = ANY($1::uuid[])`,
            [images],
          );
          return;
        }
        await manager.query(
          `DELETE FROM client_preferred_images
            WHERE image_id = ANY($1::uuid[]) AND client_id <> ALL($2::uuid[])`,
          [images, clients],
        );
      }

      if (clients.length === 0) return;
      await manager.query(
        `INSERT INTO client_preferred_images (client_id, image_id)
         SELECT c.id, i.id
           FROM clients c
           CROSS JOIN gallery_images i
          WHERE c.id = ANY($1::uuid[]) AND i.id = ANY($2::uuid[])
         ON CONFLICT (client_id, image_id) DO NOTHING`,
        [clients, images],
      );
    });

    return { affectedImages: images.length };
  }

  /**
   * Feature 13 — clientes de um conjunto de imagens, em UMA query.
   * Usado pela listagem da galeria para exibir as marcações sem N+1.
   */
  async listClientsForImages(
    imageIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const result = new Map<string, Array<{ id: string; name: string }>>();
    if (imageIds.length === 0) return result;

    const rows: Array<{ imageId: string; id: string; name: string }> = await this.dataSource.query(
      `SELECT cpi.image_id AS "imageId", c.id, c.name
         FROM client_preferred_images cpi
         JOIN clients c ON c.id = cpi.client_id
        WHERE cpi.image_id = ANY($1::uuid[])
        ORDER BY c.name ASC`,
      [imageIds],
    );

    for (const row of rows) {
      const list = result.get(row.imageId) ?? [];
      list.push({ id: row.id, name: row.name });
      result.set(row.imageId, list);
    }
    return result;
  }

  private async assertImageExists(imageId: string): Promise<void> {
    const [row] = await this.dataSource.query(`SELECT 1 FROM gallery_images WHERE id = $1`, [
      imageId,
    ]);
    if (!row) {
      throw new NotFoundException({
        code: 'GALLERY_IMAGE_NOT_FOUND',
        message: 'Imagem da galeria não encontrada',
      });
    }
  }
}
