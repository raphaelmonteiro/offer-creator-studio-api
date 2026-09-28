import { DataSource } from 'typeorm';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { EanReference } from './entities/ean-reference.entity';

/**
 * Banco para os testes de integração do vínculo EAN. Só roda com
 * EAN_IT_DB_NAME apontando para um banco DESCARTÁVEL já migrado:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest src/modules/ai/ean
 */
export const EAN_IT_ENABLED = Boolean(process.env.EAN_IT_DB_NAME);

export function criarDataSourceDeTeste(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.EAN_IT_DB_HOST ?? 'localhost',
    port: Number(process.env.EAN_IT_DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'stepup_user',
    password: process.env.DB_PASSWORD ?? 'secret123',
    database: process.env.EAN_IT_DB_NAME,
    entities: [EanMatchJob, EanMatchItem, EanReference],
    synchronize: false,
  });
}

/** Insere uma imagem na galeria de teste e devolve o id. */
export async function inserirImagem(
  ds: DataSource,
  filename: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const [row]: Array<{ id: string }> = await ds.query(
    `INSERT INTO gallery_images (filename, url, "mimeType", size, metadata)
     VALUES ($1, $2, 'image/png', 1, $3::jsonb) RETURNING id`,
    [filename, `http://test/uploads/gallery/${filename}`, JSON.stringify(metadata)],
  );
  return row.id;
}
