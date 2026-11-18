import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { assertCursorBody } from '../domain/flyer-pro-cursor-rules';
import { FLYER_PRO_FREEZING_STEPS } from '../domain/flyer-pro-steps';
import { flyerProNotFound } from '../domain/flyer-pro.errors';
import type { UpdateFlyerProCursorDto } from '../dto/update-flyer-pro-cursor.dto';

/** O que o cursor devolve: a etapa gravada e o valor de `pagesFrozen` depois dela. */
export interface FlyerProCursorView {
  step: string;
  pagesFrozen: boolean;
}

/**
 * Um `UPDATE` só: grava a etapa e o `ui` (nulo ou ausente mantém o atual) e liga `pagesFrozen` na Montagem, no Pré-flight
 * e no Exportar, nunca a desliga. Nenhuma outra coluna entra: `revision`, `updatedAt`, `updatedByUserId` e
 * `lastMutationId` ficam como estão, e o `UpdateQueryBuilder` (que acrescentaria `updatedAt`) não é usado.
 */
const CURSOR_SQL = `UPDATE "flyer_pro_documents"
   SET "step" = $2::varchar,
       "ui" = COALESCE($3::jsonb, "ui"),
       "pagesFrozen" = "pagesFrozen" OR ($2::varchar = ANY($4::varchar[]))
 WHERE "id" = $1 AND "deletedAt" IS NULL
RETURNING "step", "pagesFrozen"`;

/** N5: etapa atual e estado de tela, sem revisão e sem 409 (a última aba a gravar decide onde o encarte reabre). */
@Injectable()
export class FlyerProCursorService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async set(id: string, dto: UpdateFlyerProCursorDto): Promise<FlyerProCursorView> {
    assertCursorBody(dto);
    const ui = dto.ui === undefined || dto.ui === null ? null : JSON.stringify(dto.ui);
    // No Postgres o `query` de `UPDATE` devolve `[linhas, quantidade]`.
    const [rows] = await this.dataSource.query(CURSOR_SQL, [
      id,
      dto.step,
      ui,
      FLYER_PRO_FREEZING_STEPS,
    ]);
    if (rows.length === 0) throw flyerProNotFound();
    return { step: rows[0].step, pagesFrozen: rows[0].pagesFrozen };
  }
}
