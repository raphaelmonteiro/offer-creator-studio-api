import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  assertFoldNotLocked,
  resolvePageCount,
  sceneToBuild,
} from '../domain/flyer-pro-setup-rules';
import type { FlyerProSetupPatchDto } from '../dto/flyer-pro-setup-patch.dto';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { assertClientExists } from './flyer-pro-client';
import type { DocumentColumns } from './flyer-pro-document-update';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/**
 * O ramo `setup` do `PATCH` (N4), dentro da transação do salvar: nome, cliente, troca de template ou "Atualizar arte" e
 * número de páginas, nesta ordem. Devolve as colunas a gravar; nada é gravado aqui, então uma recusa em qualquer passo
 * deixa o corpo inteiro de fora. `pagesFrozen` nunca muda neste ramo.
 */
@Injectable()
export class FlyerProSetupService {
  constructor(private readonly snapshots: FlyerProTemplateSnapshotService) {}

  async apply(
    manager: EntityManager,
    document: FlyerProDocument,
    setup: FlyerProSetupPatchDto,
  ): Promise<DocumentColumns> {
    const columns = await this.nameAndClient(manager, setup);
    const sceneId = sceneToBuild(document, setup);
    if (sceneId) {
      const snapshot = await this.snapshots.build(sceneId, manager);
      assertFoldNotLocked(document, snapshot.format);
      Object.assign(columns, { sceneId, templateSnapshot: snapshot, format: snapshot.format });
    }
    const format = columns.format ?? document.format;
    const pageCount = resolvePageCount({
      format,
      formatChanged: format !== document.format,
      requested: setup.pageCount,
    });
    return pageCount === undefined ? columns : { ...columns, pageCount };
  }

  /** `name` (já aparado pelo DTO) e `clientId`, este só se o cliente existir (404 `CLIENT_NOT_FOUND`). */
  private async nameAndClient(
    manager: EntityManager,
    setup: FlyerProSetupPatchDto,
  ): Promise<DocumentColumns> {
    const columns: DocumentColumns = {};
    if (setup.name) columns.name = setup.name;
    if (setup.clientId) {
      await assertClientExists(manager, setup.clientId);
      columns.clientId = setup.clientId;
    }
    return columns;
  }
}
