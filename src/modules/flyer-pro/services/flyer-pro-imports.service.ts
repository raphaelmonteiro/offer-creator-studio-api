import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { paginate, PaginationResult } from '../../../common/utils/pagination.util';
import { importIssues } from '../domain/flyer-pro-import-rules';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';
import { flyerProImportInvalid, flyerProNotFound } from '../domain/flyer-pro.errors';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProImportView, toImportView } from '../views/flyer-pro-import.view';
import type { DocumentColumns } from './flyer-pro-document-update';
import {
  assertImportOfDocument,
  countImports,
  insertImport,
  pageOfImports,
} from './flyer-pro-import.statements';
import { readWith } from './flyer-pro-read';

/** A página e o filtro do histórico (N13), já validados. */
export interface FlyerProImportsListInput {
  fileHash?: string;
  page?: number;
  limit?: number;
}

/**
 * O campo `import` do `PATCH` (N4) e o histórico das importações (N13). O passo do `PATCH` roda dentro da transação do
 * salvar, depois do Setup e antes dos itens, e na ordem do contrato: as contagens (422), o registro e, se o `id` já
 * existia, o conflito com outro encarte (409). Devolve as colunas do encarte a gravar junto; nada do encarte é gravado
 * aqui, então uma recusa deixa o corpo inteiro de fora.
 */
@Injectable()
export class FlyerProImportsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * N13: as importações do encarte vivo (404 `FLYER_PRO_NOT_FOUND` se não existe, foi excluído ou o id não é UUID), da
   * mais recente para a mais antiga, paginadas, com filtro opcional por `fileHash`. Não grava nada; o encarte, o total e
   * a página saem do mesmo instante do banco (transação `REPEATABLE READ`).
   */
  list(
    documentId: string,
    query: FlyerProImportsListInput,
  ): Promise<PaginationResult<FlyerProImportView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? FLYER_PRO_LIMITS.listDefaultLimit;
    return readWith(this.dataSource, undefined, async (manager) => {
      const document = await manager.findOne(FlyerProDocument, {
        where: { id: documentId },
        select: { id: true },
      });
      if (!document) throw flyerProNotFound();
      const total = await countImports(manager, documentId, query.fileHash);
      const rows =
        total === 0
          ? []
          : await pageOfImports(
              manager,
              { documentId, fileHash: query.fileHash },
              { limit, offset: (page - 1) * limit },
            );
      return paginate(rows.map(toImportView), total, { page, limit });
    });
  }

  /**
   * Importação nova: grava o registro e, se for "Substituir a lista" (`replace`), manda descongelar as páginas
   * (`pagesFrozen = false`, no mesmo `UPDATE` da revisão). Importação já gravada neste encarte (reenvio com outro
   * `mutationId`): não grava de novo, não muda a gravada e não descongela de novo (A-3, A-6).
   */
  async apply(
    manager: EntityManager,
    documentId: string,
    userId: string,
    entry: FlyerProImportEntry,
  ): Promise<DocumentColumns> {
    const issues = importIssues(entry);
    if (issues.length > 0) throw flyerProImportInvalid(issues);
    if (await insertImport(manager, documentId, userId, entry)) {
      return entry.mode === 'replace' ? { pagesFrozen: false } : {};
    }
    await assertImportOfDocument(manager, documentId, entry.id);
    return {};
  }
}
