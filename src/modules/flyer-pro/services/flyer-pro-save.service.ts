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
import { FlyerProImageLinkService, RegisterPhotoChoices } from './flyer-pro-image-link.service';
import { FlyerProImportsService } from './flyer-pro-imports.service';
import { FlyerProItemsService } from './flyer-pro-items.service';
import { FlyerProJobsService } from './flyer-pro-jobs.service';
import { FlyerProSetupService } from './flyer-pro-setup.service';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/** O que distingue as respostas entre si: reenvio ou não, aplicada ou descartada. */
type Outcome = Pick<
  SaveViewInput,
  'replayed' | 'applied' | 'items' | 'deletedItemIds' | 'enrichment'
>;

/** O que a transação entrega: a entrada da resposta e, só no `PATCH` normal com `items`, o registro das fotos a fazer. */
interface Saved {
  input: SaveViewInput;
  registration?: RegisterPhotoChoices;
}

/**
 * N4: a única rota que grava o estado do encarte. Forma e tamanhos antes do banco; depois, numa transação com a linha
 * travada: reenvio, versões, revisão, regravação de conferência e, no `PATCH` normal, o carimbo e a gravação inteira
 * (Setup, importação, itens, nesta ordem) e, se o corpo pede `enrich`, o passo do job, num savepoint. Qualquer recusa
 * depois da trava desfaz tudo (a transação aborta). Depois do commit, e só no `PATCH` normal, registra na Galeria as
 * fotos escolhidas (U2.7): a falha vira `linkWarnings`, nunca desfaz a gravação.
 */
@Injectable()
export class FlyerProSaveService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly setup: FlyerProSetupService,
    private readonly snapshots: FlyerProTemplateSnapshotService,
    private readonly items: FlyerProItemsService,
    private readonly imports: FlyerProImportsService,
    private readonly jobs: FlyerProJobsService,
    private readonly links: FlyerProImageLinkService,
  ) {}

  async save(userId: string, id: string, body: SaveFlyerProDocumentDto): Promise<FlyerProSaveView> {
    assertSaveBody(body);
    const { input, registration } = await this.dataSource.transaction((manager) =>
      this.run(manager, userId, id, body),
    );
    const linkWarnings = registration ? await this.links.register(registration) : [];
    return toSaveView({ ...input, linkWarnings });
  }

  private async run(
    manager: EntityManager,
    userId: string,
    id: string,
    dto: SaveFlyerProDocumentDto,
  ): Promise<Saved> {
    const document = await lockDocument(manager, id);
    const settled = await this.settle(manager, document, dto);
    return settled ? { input: settled } : this.write(manager, userId, document, dto);
  }

  /**
   * Na ordem do contrato: reenvio (antes de tudo, para o mesmo corpo nunca virar 409), versões, revisão (a regravação
   * de conferência descartada responde 200 `applied: false`, nunca 409) e a regravação de conferência aplicada. Devolve
   * a entrada da resposta, ou `null` quando é um `PATCH` normal na revisão certa.
   */
  private async settle(
    manager: EntityManager,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
  ): Promise<SaveViewInput | null> {
    if (document.lastMutationId === dto.mutationId) {
      const items = await this.items.currentOf(manager, document.id, dto.items?.upsert);
      const enrichment = dto.enrich
        ? await this.jobs.replayAfterSave(manager, document.id)
        : undefined;
      return this.respond(manager, document, dto, {
        replayed: true,
        applied: true,
        items,
        enrichment,
      });
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
   * A entrada da resposta. Os campos da cópia da arte (e o `templateStatus`, calculado na hora sobre a cópia do
   * encarte) só vêm quando o corpo trocou a cena ou pediu "Atualizar arte", também no reenvio.
   */
  private async respond(
    manager: EntityManager,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
    outcome: Outcome,
  ): Promise<SaveViewInput> {
    const fields = saveResponseFields(dto.setup);
    const templateStatus = fields.template
      ? await this.snapshots.statusOf(document.templateSnapshot, manager)
      : undefined;
    return { document, ...outcome, fields, templateStatus };
  }

  /**
   * `PATCH` normal: carimbo depois da trava, Setup, importação, itens, uma gravação só do encarte e a entrada da
   * resposta. As fotos citadas no corpo seguem com os itens como ficaram e o cliente do encarte depois do Setup.
   */
  private async write(
    manager: EntityManager,
    userId: string,
    document: FlyerProDocument,
    dto: SaveFlyerProDocumentDto,
  ): Promise<Saved> {
    const stamp = await readStamp(manager);
    const setupColumns = dto.setup ? await this.setup.apply(manager, document, dto.setup) : {};
    const importColumns = dto.import
      ? await this.imports.apply(manager, document.id, userId, dto.import)
      : {};
    const touched = dto.items
      ? await this.items.apply(manager, document.id, dto.items, { stamp, userId })
      : undefined;
    const columns = saveColumns(document, dto, userId, { ...setupColumns, ...importColumns });
    const updatedAt = await writeDocument(manager, document.id, columns, stamp);
    const saved = { ...document, ...columns, updatedAt };
    const enrichment = dto.enrich
      ? await this.jobs.requestAfterSave(manager, userId, document.id, dto.enrich.steps)
      : undefined;
    const input = await this.respond(manager, saved, dto, {
      replayed: false,
      applied: true,
      items: touched?.items,
      deletedItemIds: touched?.deletedItemIds,
      enrichment,
    });
    const registration = touched && {
      choices: touched.photoChoices,
      items: touched.items,
      clientId: saved.clientId,
    };
    return { input, registration };
  }
}
