import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  assertAppNotOutdated,
  assertSaveBody,
  isConferenceBody,
  revisionConflictOf,
  saveResponseFields,
} from '../domain/flyer-pro-save-rules';
import type { SaveFlyerProDocumentDto } from '../dto/save-flyer-pro-document.dto';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProSaveView, toSaveView } from '../views/flyer-pro-save.view';
import {
  lockDocument,
  readStamp,
  saveColumns,
  writeConference,
  writeDocument,
} from './flyer-pro-save.statements';

const NO_FIELDS = { template: false, pageCount: false };

/**
 * N4: a única rota que grava o estado do encarte. Forma e tamanhos antes do banco; depois, numa transação com a linha
 * travada: reenvio, versões, revisão, regravação de conferência e, no `PATCH` normal, o carimbo e a gravação inteira.
 * Qualquer recusa depois da trava desfaz tudo (a transação aborta).
 */
@Injectable()
export class FlyerProSaveService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async save(userId: string, id: string, dto: SaveFlyerProDocumentDto): Promise<FlyerProSaveView> {
    assertSaveBody(dto);
    return this.dataSource.transaction((manager) => this.run(manager, userId, id, dto));
  }

  private async run(
    manager: EntityManager,
    userId: string,
    id: string,
    dto: SaveFlyerProDocumentDto,
  ): Promise<FlyerProSaveView> {
    const document = await lockDocument(manager, id);
    const settled = await this.settle(manager, document, dto);
    return settled ?? this.write(manager, userId, document, dto);
  }

  /**
   * Na ordem do contrato: reenvio (antes de tudo, para o mesmo corpo nunca virar 409), versões, revisão (a regravação
   * de conferência descartada responde 200 `applied: false`, nunca 409) e a regravação de conferência aplicada. Devolve
   * a resposta, ou `null` quando é um `PATCH` normal na revisão certa.
   */
  private async settle(
    manager: EntityManager,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
  ): Promise<FlyerProSaveView | null> {
    if (document.lastMutationId === dto.mutationId) return this.replayed(document, dto);
    assertAppNotOutdated(document, dto);
    const conference = isConferenceBody(dto);
    if (document.revision !== dto.expectedRevision) {
      if (!conference) throw revisionConflictOf(document);
      return toSaveView({ document, replayed: false, applied: false, fields: NO_FIELDS });
    }
    if (!conference) return null;
    await writeConference(manager, document.id, dto);
    return toSaveView({ document, replayed: false, applied: true, fields: NO_FIELDS });
  }

  /** Reenvio: nada é gravado; a resposta traz o estado atual (`applied: true`, a revisão de agora). */
  private replayed(document: FlyerProDocument, dto: SaveFlyerProDocumentDto): FlyerProSaveView {
    const fields = saveResponseFields(dto.setup);
    return toSaveView({ document, replayed: true, applied: true, fields });
  }

  /** `PATCH` normal: carimbo depois da trava, uma gravação só do encarte e a resposta pela view. */
  private async write(
    manager: EntityManager,
    userId: string,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
  ): Promise<FlyerProSaveView> {
    const stamp = await readStamp(manager);
    const columns = saveColumns(document, dto, userId, {});
    const updatedAt = await writeDocument(manager, document.id, columns, stamp);
    const saved = { ...document, ...columns, updatedAt };
    return toSaveView({ document: saved, replayed: false, applied: true, fields: NO_FIELDS });
  }
}
