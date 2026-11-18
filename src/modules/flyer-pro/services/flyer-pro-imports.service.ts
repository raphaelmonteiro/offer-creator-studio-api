import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { importIssues } from '../domain/flyer-pro-import-rules';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';
import { flyerProImportInvalid } from '../domain/flyer-pro.errors';
import type { DocumentColumns } from './flyer-pro-document-update';
import { assertImportOfDocument, insertImport } from './flyer-pro-import.statements';

/**
 * O campo `import` do `PATCH` (N4) e o histórico das importações (N13). O passo do `PATCH` roda dentro da transação do
 * salvar, depois do Setup e antes dos itens, e na ordem do contrato: as contagens (422), o registro e, se o `id` já
 * existia, o conflito com outro encarte (409). Devolve as colunas do encarte a gravar junto; nada do encarte é gravado
 * aqui, então uma recusa deixa o corpo inteiro de fora.
 */
@Injectable()
export class FlyerProImportsService {
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
