import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FlyerProJob } from '../entities/flyer-pro-job.entity';

/**
 * Jobs de enriquecimento gravados direto no banco, para os testes do módulo `flyer-pro` (só testes): a única fábrica de
 * linha de job. Remover o encarte fisicamente (`purgeDocumentsOf`) leva os jobs pela cascata.
 */

export type JobSeed = Partial<Omit<FlyerProJob, 'document'>>;

/** Grava um job; o que o teste não informa leva só as fotos, `queued`, `total` 0 e os padrões da tabela. */
export async function insertJob(
  dataSource: DataSource,
  documentId: string,
  seed: JobSeed = {},
): Promise<string> {
  const id = seed.id ?? randomUUID();
  await dataSource.getRepository(FlyerProJob).insert({
    steps: ['image_match'],
    ...seed,
    id,
    documentId,
  });
  return id;
}

/** Os jobs do encarte como o banco os guarda, do mais antigo para o mais novo. */
export function jobsOf(
  dataSource: DataSource,
  documentId: string,
): Promise<Array<Record<string, unknown>>> {
  return dataSource.query(
    `SELECT * FROM flyer_pro_jobs WHERE "documentId" = $1 ORDER BY "createdAt", "id"`,
    [documentId],
  );
}
