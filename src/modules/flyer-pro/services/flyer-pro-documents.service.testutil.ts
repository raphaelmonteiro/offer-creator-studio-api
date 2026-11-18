import type { DataSource, EntityManager, Repository } from 'typeorm';
import type {
  FlyerProFormat,
  FlyerProTemplateSnapshot,
  FlyerProTemplateStatus,
} from '../domain/flyer-pro.types';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProDocumentsService } from './flyer-pro-documents.service';
import type { FlyerProJobsService } from './flyer-pro-jobs.service';
import type { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

/** Ajudantes dos unitários do serviço do encarte (só testes): repositórios, `manager` e montador simulados. */

export const STATUS: FlyerProTemplateStatus = {
  available: true,
  usable: true,
  missingFaces: [],
  stale: false,
  staleKind: null,
};

export const CURSOR = '2026-11-14T13:05:40.412377Z';

export function snapshotOf(format: FlyerProFormat = '27x40'): FlyerProTemplateSnapshot {
  return {
    v: 1,
    sceneId: 'scene-1',
    name: '5- folheto 27x40',
    format,
    fold: format === '27x40' ? 'simple' : 'double',
    layout: format === '27x40' ? 'front_back' : 'tabloid',
    faces: [],
    sceneRevision: 5,
    capturedAt: '2026-11-14T13:02:11.000Z',
  };
}

/** Uma linha de encarte como o banco a devolve; o que o teste não informa leva o estado de recém-criado. */
export function documentRow(over: Partial<FlyerProDocument> = {}): FlyerProDocument {
  return {
    id: 'd1',
    name: 'Ofertas Piccin semana 47',
    clientId: 'c1',
    sceneId: 'scene-1',
    format: '27x40',
    pageCount: 1,
    pagesFrozen: false,
    step: 'products',
    ui: {},
    templateSnapshot: snapshotOf(),
    frame: {},
    structure: {},
    card: {},
    assembly: {},
    exportPrefs: {},
    layoutSnapshot: null,
    layoutDigest: null,
    renderDigest: null,
    schemaVersion: 1,
    engineVersion: 1,
    revision: 0,
    lastMutationId: null,
    creationKey: 'key-1',
    createdByUserId: 'u1',
    updatedByUserId: 'u1',
    createdAt: new Date('2026-11-14T13:02:11.000Z'),
    updatedAt: new Date('2026-11-14T13:02:11.000Z'),
    deletedAt: null,
    ...over,
  };
}

export function itemRow(over: Partial<FlyerProItem> = {}): FlyerProItem {
  return {
    id: 'i1',
    documentId: 'd1',
    position: 0,
    name: 'ABACATE',
    sourceName: null,
    price: { kind: 'simple', cents: 699 },
    unit: 'kg',
    category: null,
    categorySource: null,
    categoryReview: null,
    isAlcoholic: false,
    ean: null,
    galleryImageId: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    imageOrigin: null,
    imageStatus: 'none',
    imageReview: null,
    spellReview: null,
    imported: null,
    importId: null,
    createdAt: new Date('2026-11-14T13:04:02.118Z'),
    updatedAt: new Date('2026-11-14T13:05:40.412Z'),
    ...over,
  };
}

type Work = (manager: unknown) => Promise<unknown>;

/** O serviço sobre mocks: `manager` (a transação), `dataSource`, o repositório e o montador da cópia. */
export function makeService() {
  const manager = {
    findOne: jest.fn().mockResolvedValue(documentRow()),
    find: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([{ cursor: CURSOR }]),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'd1' }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn((levelOrWork: string | Work, maybeWork?: Work) =>
      (typeof levelOrWork === 'string' ? maybeWork : levelOrWork)(manager),
    ),
    query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const documents = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };
  const jobs = { currentView: jest.fn().mockResolvedValue(null) };
  const snapshots = {
    build: jest.fn().mockResolvedValue(snapshotOf()),
    statusOf: jest.fn().mockResolvedValue(STATUS),
  };
  const service = new FlyerProDocumentsService(
    dataSource as unknown as DataSource,
    documents as unknown as Repository<FlyerProDocument>,
    snapshots as unknown as FlyerProTemplateSnapshotService,
    jobs as unknown as FlyerProJobsService,
  );
  return {
    service,
    manager: manager as unknown as EntityManager & typeof manager,
    dataSource,
    documents,
    snapshots,
    jobs,
  };
}
