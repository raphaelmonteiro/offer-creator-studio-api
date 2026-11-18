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
import type { SaveViewInput } from '../views/flyer-pro-save.view';
import {
  lockDocument,
  readStamp,
  saveColumns,
  writeConference,
  writeDocument,
} from './flyer-pro-save.statements';
import { FlyerProItemsService } from './flyer-pro-items.service';
import { FlyerProSetupService } from './flyer-pro-setup.service';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/** O que distingue as respostas entre si: reenvio ou não, aplicada ou descartada. */
type Outcome = Pick<SaveViewInput, 'replayed' | 'applied' | 'items' | 'deletedItemIds'>;

/**
 * N4: a única rota que grava o estado do encarte. Forma e tamanhos antes do banco; depois, numa transação com a linha
 * travada: reenvio, versões, revisão, regravação de conferência e, no `PATCH` normal, o carimbo e a gravação inteira.
 * Qualquer recusa depois da trava desfaz tudo (a transação aborta).
 */
@Injectable()
export class FlyerProSaveService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly setup: FlyerProSetupService,
    private readonly snapshots: FlyerProTemplateSnapshotService,
    private readonly items: FlyerProItemsService,
  ) {}

  async save(userId: string, id: string, body: SaveFlyerProDocumentDto): Promise<FlyerProSaveView> {
    assertSaveBody(body);
    return this.dataSource.transaction((manager) => this.run(manager, userId, id, body));
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
    if (document.lastMutationId === dto.mutationId) {
      const items = await this.items.currentOf(manager, document.id, dto.items?.upsert);
      return this.respond(manager, document, dto, { replayed: true, applied: true, items });
    }
    assertAppNotOutdated(document, dto);
    const conference = isConferenceBody(dto);
    if (document.revision !== dto.expectedRevision) {
      if (!conference) throw revisionConflictOf(document);
      return this.respond(manager, document, dto, { replayed: false, applied: false });
    }
    if (!conference) return null;
    await writeConference(manager, document.id, dto);
    return this.respond(manager, document, dto, { replayed: false, applied: true });
  }

  /**
   * A resposta pela view. Os campos da cópia da arte (e o `templateStatus`, calculado na hora sobre a cópia do
   * encarte) só vêm quando o corpo trocou a cena ou pediu "Atualizar arte", também no reenvio.
   */
  private async respond(
    manager: EntityManager,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
    outcome: Outcome,
  ): Promise<FlyerProSaveView> {
    const fields = saveResponseFields(dto.setup);
    const templateStatus = fields.template
      ? await this.snapshots.statusOf(document.templateSnapshot, manager)
      : undefined;
    return toSaveView({ document, ...outcome, fields, templateStatus });
  }

  /** `PATCH` normal: carimbo depois da trava, uma gravação só do encarte e a resposta pela view. */
  private async write(
    manager: EntityManager,
    userId: string,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
  ): Promise<FlyerProSaveView> {
    const stamp = await readStamp(manager);
    const setupColumns = dto.setup ? await this.setup.apply(manager, document, dto.setup) : {};
    const touched = dto.items
      ? await this.items.apply(manager, document.id, dto.items, { stamp, userId })
      : undefined;
    const columns = saveColumns(document, dto, userId, setupColumns);
    const updatedAt = await writeDocument(manager, document.id, columns, stamp);
    const saved = { ...document, ...columns, updatedAt };
    return this.respond(manager, saved, dto, { replayed: false, applied: true, ...touched });
  }
}
