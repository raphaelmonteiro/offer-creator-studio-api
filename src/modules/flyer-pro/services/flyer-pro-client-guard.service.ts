import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

const PURGE_DELETED_SQL = `DELETE FROM "flyer_pro_documents" WHERE "clientId" = $1 AND "deletedAt" IS NOT NULL RETURNING "id"`;
const COUNT_LIVE_SQL = `SELECT count(*)::int AS "total" FROM "flyer_pro_documents" WHERE "clientId" = $1 AND "deletedAt" IS NULL`;

/**
 * O que a exclusão de um cliente (`ClientsService.remove`) precisa saber do Encarte Pro: apagar de vez os encartes dele
 * que já estavam excluídos logicamente (os itens saem pela cascata da FK) e contar os que ainda estão vivos. O módulo
 * `clients` chama este serviço; o `flyer-pro` não conhece o `clients` (a FK `RESTRICT` do encarte é o que recusa).
 */
@Injectable()
export class FlyerProClientGuardService {
  private readonly logger = new Logger(FlyerProClientGuardService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Exclusão física, pelo `manager` da transação de quem chama, dos encartes do cliente com `deletedAt` preenchido.
   * Devolve os ids apagados. Se a transação voltar, o expurgo volta junto.
   */
  async purgeDeletedOfClient(manager: EntityManager, clientId: string): Promise<string[]> {
    const [rows]: [Array<{ id: string }>, number] = await manager.query(PURGE_DELETED_SQL, [
      clientId,
    ]);
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      this.logger.log(
        `Expurgo dos encartes Pro excluídos do cliente ${clientId} (${ids.length}): ${ids.join(', ')}`,
      );
    }
    return ids;
  }

  /**
   * Quantos encartes do cliente não estão excluídos. Pelo `DataSource`, fora da transação: depois da recusa por chave
   * estrangeira a transação está abortada e não aceita outra consulta (PV-1).
   */
  async countLiveOfClient(clientId: string): Promise<number> {
    const [{ total }] = await this.dataSource.query(COUNT_LIVE_SQL, [clientId]);
    return total;
  }
}
