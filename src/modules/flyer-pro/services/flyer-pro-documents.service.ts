import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import type { PaginationResult } from '../../../common/utils/pagination.util';
import { CREATE_REQUIRED_FIELDS, isCreationKeyConflict } from '../domain/flyer-pro-document-rules';
import { missingFields } from '../domain/flyer-pro-presence';
import { findFlyerProFormat, sceneFormatIdOf } from '../domain/flyer-pro-formats';
import { flyerProMissingFields, flyerProNotFound } from '../domain/flyer-pro.errors';
import type { CreateFlyerProDocumentDto } from '../dto/create-flyer-pro-document.dto';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';
import type {
  FlyerProDocumentListItemView,
  FlyerProDocumentView,
} from '../views/flyer-pro-document.view';
import { toDocumentView } from '../views/flyer-pro-document.view';
import { assertClientExists } from './flyer-pro-client';
import { FlyerProDocumentsListInput, listDocuments } from './flyer-pro-documents-list';
import { readWith } from './flyer-pro-read';
import { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/** O que `POST /v1/flyer-pro/documents` devolve: o encarte e se foi criado agora (201) ou já existia (200). */
export interface FlyerProCreateResult {
  document: FlyerProDocumentView & { replayed: boolean };
  created: boolean;
}

/** O maior `updatedAt` dos itens, ou o `createdAt` do encarte sem itens, em texto com microssegundos (o `Date` só tem ms). */
const ITEMS_CURSOR_SQL = `SELECT to_char(
    COALESCE(
      (SELECT max("updatedAt") FROM flyer_pro_items WHERE "documentId" = $1),
      (SELECT "createdAt" FROM flyer_pro_documents WHERE id = $1)
    ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor`;

/**
 * O encarte do Encarte Pro: criar (N1, idempotente pela `creationKey`), listar (N2), abrir (N3) e excluir (N6). Quem
 * grava alterações é a change 09. Escopo global, com o autor registrado (PU-01).
 */
@Injectable()
export class FlyerProDocumentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FlyerProDocument) private readonly documents: Repository<FlyerProDocument>,
    private readonly snapshots: FlyerProTemplateSnapshotService,
  ) {}

  /** N3. Não grava nada: encarte, itens, cursor e `templateStatus` saem do mesmo instante do banco (A-12). */
  async open(id: string): Promise<FlyerProDocumentView> {
    const view = await this.read(id);
    if (!view) throw flyerProNotFound();
    return view;
  }

  list(query: FlyerProDocumentsListInput): Promise<PaginationResult<FlyerProDocumentListItemView>> {
    return listDocuments(this.dataSource, query);
  }

  /**
   * N6: só grava `deletedAt`, e só se ainda é nulo. Sem linha mudada (inexistente, já excluído, ou o outro de dois
   * pedidos simultâneos), 404. Não mexe em `updatedAt`, autor, `revision` nem itens (A-8).
   */
  async remove(id: string): Promise<{ deleted: true }> {
    const { affected } = await this.documents.update(
      { id, deletedAt: IsNull() },
      { deletedAt: () => 'now()' },
    );
    if (!affected) throw flyerProNotFound();
    return { deleted: true };
  }

  /**
   * N1, na ordem da A-6: forma, chave (repetição ou encarte excluído), cliente, template (a montagem e a inserção na
   * mesma transação) e, depois do commit, a leitura do N3. Recusa não grava nem gasta a chave.
   */
  async create(dto: CreateFlyerProDocumentDto, userId: string): Promise<FlyerProCreateResult> {
    const missing = missingFields(dto, CREATE_REQUIRED_FIELDS);
    if (missing.length > 0) throw flyerProMissingFields(missing);
    const known = await this.replayOf(dto.creationKey);
    if (known) return known;
    await assertClientExists(this.dataSource, dto.clientId);
    try {
      const id = await this.dataSource.transaction((manager) => this.insert(manager, dto, userId));
      return await this.created(id);
    } catch (error) {
      if (!isCreationKeyConflict(error)) throw error;
      return this.replayAfterConflict(dto.creationKey);
    }
  }

  /** O N3 do encarte (nulo se não existe ou foi excluído), lido num instantâneo só. */
  private read(id: string): Promise<FlyerProDocumentView | null> {
    return readWith(this.dataSource, undefined, async (manager) => {
      const document = await manager.findOne(FlyerProDocument, { where: { id } });
      if (!document) return null;
      const items = await manager.find(FlyerProItem, {
        where: { documentId: id },
        order: { position: 'ASC', id: 'ASC' },
      });
      const [{ cursor }] = await manager.query(ITEMS_CURSOR_SQL, [id]);
      const templateStatus = await this.snapshots.statusOf(document.templateSnapshot, manager);
      return toDocumentView({ document, items, itemsCursor: cursor, templateStatus });
    });
  }

  /** A repetição de uma chave já usada: 200 com o estado atual, ou 404 se o encarte foi excluído. Nulo se a chave é nova. */
  private async replayOf(creationKey: string): Promise<FlyerProCreateResult | null> {
    const found = await this.documents.findOne({ where: { creationKey }, withDeleted: true });
    if (!found) return null;
    if (found.deletedAt) throw flyerProNotFound();
    return this.replayed(found.id);
  }

  /** O `23505` aborta a transação em que ocorre: a releitura pela chave é feita fora dela. */
  private async replayAfterConflict(creationKey: string): Promise<FlyerProCreateResult> {
    const winner = await this.documents.findOne({ where: { creationKey } });
    if (!winner) throw flyerProNotFound();
    return this.replayed(winner.id);
  }

  private async replayed(id: string): Promise<FlyerProCreateResult> {
    return { document: { ...(await this.open(id)), replayed: true }, created: false };
  }

  private async created(id: string): Promise<FlyerProCreateResult> {
    return { document: { ...(await this.open(id)), replayed: false }, created: true };
  }

  /** A cópia do template e a linha do encarte, na mesma transação; o formato e as páginas vêm da cópia (PU-20). */
  private async insert(
    manager: EntityManager,
    dto: CreateFlyerProDocumentDto,
    userId: string,
  ): Promise<string> {
    const snapshot = await this.snapshots.build(dto.sceneId, manager);
    const { identifiers } = await manager.insert(FlyerProDocument, {
      name: dto.name,
      clientId: dto.clientId,
      sceneId: dto.sceneId,
      format: snapshot.format,
      pageCount: findFlyerProFormat(sceneFormatIdOf(snapshot.format)).defaultPageCount,
      pagesFrozen: false,
      step: 'products',
      templateSnapshot: snapshot,
      schemaVersion: dto.schemaVersion,
      engineVersion: dto.engineVersion,
      revision: 0,
      creationKey: dto.creationKey,
      createdByUserId: userId,
      updatedByUserId: userId,
    });
    return identifiers[0].id as string;
  }
}
