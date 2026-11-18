import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { paginate, PaginationResult } from '../../../common/utils/pagination.util';
import { exportIssues, normalizeExportEntry } from '../domain/flyer-pro-export.rules';
import { missingFields } from '../domain/flyer-pro-presence';
import {
  flyerProExportIdConflict,
  flyerProExportInvalid,
  flyerProMissingFields,
  flyerProNotFound,
} from '../domain/flyer-pro.errors';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProExportEntry } from '../domain/flyer-pro.types';
import type { CreateFlyerProExportDto } from '../dto/create-flyer-pro-export.dto';
import {
  FlyerProExportRow,
  FlyerProExportView,
  toExportView,
} from '../views/flyer-pro-export.view';
import {
  countExports,
  findExportRow,
  insertExportIfAbsent,
  pageOfExports,
} from './flyer-pro-export.statements';
import { assertLiveDocument, readLiveRevision, readWith } from './flyer-pro-read';

/** Os campos que o pipe não confere num corpo `{}` e que o N8 exige (ausente ou nulo é 400). */
const REQUIRED_FIELDS = [
  'id',
  'format',
  'options',
  'documentRevision',
  'engineVersion',
  'renderDigest',
  'fileName',
] as const;

/** A resposta do registro: `created` decide o 201 ou o 200 no controller; `replayed` vai no corpo. */
export interface FlyerProExportRegistration {
  view: FlyerProExportView & { replayed: boolean };
  created: boolean;
}

/** A página do histórico (N9), já validada. */
export interface FlyerProExportsListInput {
  page?: number;
  limit?: number;
}

/**
 * Um `id` que já existia: do mesmo encarte é repetição (200 com a linha gravada, sem comparar o corpo); de outro
 * encarte, vivo ou excluído logicamente, é 409.
 */
function replayOf(row: FlyerProExportRow, documentId: string): FlyerProExportRegistration {
  if (row.documentId !== documentId) throw flyerProExportIdConflict(row.id);
  return { view: { ...toExportView(row), replayed: true }, created: false };
}

/**
 * O registro (N8) e o histórico (N9) das exportações do encarte. Nada do encarte é gravado aqui: `revision`,
 * `updatedAt`, `updatedByUserId` e `lastMutationId` ficam como estavam (A-14).
 */
@Injectable()
export class FlyerProExportsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * N8, na ordem do contrato: os obrigatórios (400, o pipe pula o corpo `{}`), o `null` dos três opcionais como
   * ausente (D-3, num ponto só, antes de qualquer outra leitura do corpo), o encarte vivo (404), o `id` já gravado (200
   * no mesmo encarte, 409 em outro) e, por último, as regras de negócio (422): a repetição vem antes das regras porque
   * não compara o corpo. Primeira gravação 201, repetição 200.
   */
  async register(
    documentId: string,
    dto: CreateFlyerProExportDto,
    userId: string,
  ): Promise<FlyerProExportRegistration> {
    const missing = missingFields(dto, REQUIRED_FIELDS);
    if (missing.length > 0) throw flyerProMissingFields(missing);
    const entry = normalizeExportEntry(dto);
    return this.dataSource.transaction((manager) =>
      this.registerIn(manager, documentId, userId, entry),
    );
  }

  /**
   * N9: as exportações do encarte vivo (404 `FLYER_PRO_NOT_FOUND` se não existe, foi excluído ou o id não é UUID), da
   * mais recente para a mais antiga, paginadas. Não grava nada; o encarte, o total e a página saem do mesmo instante do
   * banco (transação `REPEATABLE READ`).
   */
  list(
    documentId: string,
    query: FlyerProExportsListInput,
  ): Promise<PaginationResult<FlyerProExportView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? FLYER_PRO_LIMITS.listDefaultLimit;
    return readWith(this.dataSource, undefined, async (manager) => {
      await assertLiveDocument(manager, documentId);
      const total = await countExports(manager, documentId);
      const rows =
        total === 0
          ? []
          : await pageOfExports(manager, documentId, { limit, offset: (page - 1) * limit });
      return paginate(rows.map(toExportView), total, { page, limit });
    });
  }

  /**
   * O corpo do registro dentro da transação (`READ COMMITTED`: o `ON CONFLICT DO NOTHING` espera o registro simultâneo
   * do mesmo `id` terminar, e a releitura enxerga a linha dele). Sem a linha depois da inserção, ela saiu no meio
   * (expurgo do encarte): 404.
   */
  private async registerIn(
    manager: EntityManager,
    documentId: string,
    userId: string,
    entry: FlyerProExportEntry,
  ): Promise<FlyerProExportRegistration> {
    const revision = await readLiveRevision(manager, documentId);
    const existing = await findExportRow(manager, entry.id);
    if (existing) return replayOf(existing, documentId);
    const issues = exportIssues(entry, revision);
    if (issues.length > 0) throw flyerProExportInvalid(issues);
    const inserted = await insertExportIfAbsent(manager, documentId, userId, entry);
    const row = await findExportRow(manager, entry.id);
    if (!row) throw flyerProNotFound();
    if (!inserted) return replayOf(row, documentId);
    return { view: { ...toExportView(row), replayed: false }, created: true };
  }
}
