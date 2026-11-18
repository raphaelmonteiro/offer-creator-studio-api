import type { DataSource, EntityManager } from 'typeorm';
import { flyerProClientNotFound } from '../domain/flyer-pro.errors';

/**
 * 404 `CLIENT_NOT_FOUND` quando o cliente não existe. Lê pelo `manager` da transação de quem chama (o ramo `setup` do
 * `PATCH`) ou pelo `DataSource` (a criação); a regra é a mesma nos dois.
 */
export async function assertClientExists(
  runner: Pick<DataSource | EntityManager, 'query'>,
  clientId: string,
): Promise<void> {
  const rows = await runner.query(`SELECT 1 FROM clients WHERE id = $1::uuid LIMIT 1`, [clientId]);
  if (rows.length === 0) throw flyerProClientNotFound();
}
