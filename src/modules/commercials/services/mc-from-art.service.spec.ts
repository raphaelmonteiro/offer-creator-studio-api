import { HttpException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { FlyerBuilderV2Document } from '../../flyer-builder-v2/entities/flyer-builder-v2-document.entity';
import { Flyer } from '../../flyers/entities/flyer.entity';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { Product } from '../../products/entities/product.entity';
import { CommercialsService } from '../commercials.service';
import {
  ART_CATALOG_A,
  ART_CATALOG_B,
  FLYER_V2_DOCUMENT,
  LEGACY_FLYER_CONFIGURATION,
  MULTIPAGE_FLYER_CONFIGURATION,
  SOCIAL_V2_DOCUMENT,
} from '../domain/__fixtures__/mc-art-sources.fixtures';
import { computeSnapshotHash, extractOffers } from '../domain/mc-art-offers';
import { CreateProjectDto } from '../dto/create-project.dto';
import { CreateProjectFromArtDto } from '../dto/from-art.dto';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McLogoLocatorResult } from '../domain/mc-logo-face';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McArtService } from './mc-art.service';
import { McFromArtService } from './mc-from-art.service';
import { McKitViewService } from './mc-kit-view.service';
import { McLogoLocatorService } from './mc-logo-locator.service';
import { McStorageService } from './mc-storage.service';

type Row = Record<string, unknown> & { id?: string };

const FLYER_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';
const KIT_ID = '55555555-5555-4555-8555-555555555555';
const KIT_2_ID = '66666666-6666-4666-8666-666666666666';

const ASSET = {
  id: ASSET_ID,
  userId: 'u1',
  kind: 'video_art',
  fileUrl: '/uploads/commercials/art/u1/a.png',
  width: 1080,
  height: 1350,
  metadata: { aspectRatio: '4:5' },
};

const KIT = {
  id: KIT_ID,
  userId: 'u1',
  mascotId: 'm-1',
  status: McKitStatus.APPROVED,
  version: 3,
  approvedAt: new Date('2026-10-01'),
  createdAt: new Date('2026-09-30'),
};

/** Mascote `logo` do kit (D5): o logo enviado é a referência da detecção (recorte quando há). */
const LOGO_MASCOT = {
  id: 'm-1',
  userId: 'u1',
  kind: 'logo',
  sourceImageUrl: '/uploads/mascots/u1/logo.png',
  cutoutUrl: '/uploads/mascots/u1/logo-cutout.png',
};

const LOGO_BOX = { x: 0.05, y: 0.86, w: 0.22, h: 0.09 };

const detection = (over: Partial<McLogoLocatorResult> = {}): McLogoLocatorResult => ({
  found: true,
  bbox: { ...LOGO_BOX },
  confidence: 0.92,
  model: 'gemini-3.8-flash',
  at: '2026-10-12T10:00:00.000Z',
  ...over,
});

const responseOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
  throw new Error('esperava rejeição');
};

describe('McFromArtService — ponte arte → projeto (tarefas 5.3–5.6)', () => {
  const env = { ...process.env };
  let repos: Map<unknown, Record<string, jest.Mock>>;
  let dataSource: { getRepository: jest.Mock };
  let commercials: { createProject: jest.Mock };
  let art: { findOwned: jest.Mock };
  let kitView: { toView: jest.Mock };
  let locator: { locate: jest.Mock };
  let storage: { absoluteFromUrl: jest.Mock };
  let service: McFromArtService;

  const flyerRow = (configuration: unknown, extra: Partial<Flyer> = {}) => ({
    id: FLYER_ID,
    name: 'Encarte de outubro',
    clientId: CLIENT_ID,
    kind: 'flyer',
    configuration,
    ...extra,
  });
  const docRow = (document: unknown, extra: Partial<FlyerBuilderV2Document> = {}) => ({
    id: DOC_ID,
    name: (document as { name?: string }).name ?? 'Documento',
    clientId: CLIENT_ID,
    document,
    ...extra,
  });

  beforeEach(() => {
    process.env.MC_FORMATS = 'talking_art,offer_carousel';
    process.env.MC_PIPELINE_V2 = 'all';

    repos = new Map<unknown, Record<string, jest.Mock>>([
      [Flyer, { findOne: jest.fn().mockResolvedValue(null) }],
      [FlyerBuilderV2Document, { findOne: jest.fn().mockResolvedValue(null) }],
      [Product, { find: jest.fn().mockResolvedValue([]) }],
      [Client, { findOne: jest.fn().mockResolvedValue({ id: CLIENT_ID, logoUrl: null }) }],
      [
        Mascot,
        {
          find: jest.fn().mockResolvedValue([{ id: 'm-1' }]),
          findOne: jest.fn().mockResolvedValue(LOGO_MASCOT),
        },
      ],
      [
        McCharacterKit,
        {
          find: jest.fn().mockResolvedValue([KIT]),
          findOne: jest.fn().mockResolvedValue({ ...KIT, source: 'logo' }),
        },
      ],
      [
        McProject,
        {
          findOne: jest.fn().mockResolvedValue(null),
          findOneBy: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        },
      ],
    ]);
    dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        const repo = repos.get(entity);
        if (!repo) {
          throw new Error(`repo não mockado: ${String((entity as { name?: string })?.name)}`);
        }
        return repo;
      }),
    };
    commercials = {
      createProject: jest.fn((userId: string, dto: CreateProjectDto) =>
        Promise.resolve({ id: 'p-new', userId, ...dto, status: 'scripting' }),
      ),
    };
    art = { findOwned: jest.fn().mockResolvedValue(ASSET) };
    kitView = {
      toView: jest.fn((kit: Row) => Promise.resolve({ ...kit, references: [], tile: null })),
    };
    locator = { locate: jest.fn().mockResolvedValue(detection()) };
    storage = { absoluteFromUrl: jest.fn((url: string) => `/srv${url}`) };
    service = new McFromArtService(
      dataSource as unknown as DataSource,
      commercials as unknown as CommercialsService,
      art as unknown as McArtService,
      kitView as unknown as McKitViewService,
      locator as unknown as McLogoLocatorService,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const dto = (over: Partial<CreateProjectFromArtDto> = {}): CreateProjectFromArtDto =>
    ({
      artAssetId: ASSET_ID,
      sourceKind: 'flyer',
      sourceId: FLYER_ID,
      format: 'talking_art',
      ...over,
    }) as CreateProjectFromArtDto;

  const createdDto = (): CreateProjectDto => commercials.createProject.mock.calls[0][1];
  const createdProducts = () => (createdDto().products ?? []) as unknown as Row[];

  // ───────────────────────────── gates ─────────────────────────────

  it('formato fora de MC_FORMATS → 422 FORMAT_NOT_ENABLED antes de ler qualquer coisa', async () => {
    process.env.MC_FORMATS = '';
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: { code: 'FORMAT_NOT_ENABLED', details: { format: 'talking_art' } },
    });
    expect(art.findOwned).not.toHaveBeenCalled();
    expect(dataSource.getRepository).not.toHaveBeenCalled();
    expect(commercials.createProject).not.toHaveBeenCalled();
  });

  it('MC_PIPELINE_V2=off → 422 PIPELINE_V2_REQUIRED (F1/F2 só rodam no executor v2)', async () => {
    process.env.MC_PIPELINE_V2 = 'off';
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: { code: 'PIPELINE_V2_REQUIRED' },
    });
    expect(art.findOwned).not.toHaveBeenCalled();
  });

  it('recusas de createProject (kill-switch, preflight RENDER_UNAVAILABLE, kit) propagam', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    commercials.createProject.mockRejectedValueOnce(
      new HttpException({ code: 'RENDER_UNAVAILABLE' }, 422),
    );
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: { code: 'RENDER_UNAVAILABLE' },
    });
  });

  it('asset da arte: 404/403 do findOwned propagam sem ler a origem', async () => {
    art.findOwned.mockRejectedValueOnce(new HttpException({ code: 'X' }, 403));
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({ status: 403 });
    expect(art.findOwned).toHaveBeenCalledWith('u1', ASSET_ID);
    expect(repos.get(Flyer)!.findOne).not.toHaveBeenCalled();
  });

  // ───────────────────────────── criação por origem ─────────────────────────────

  it('encarte legado (flyers.configuration): delega a createProject com ofertas, arte, aspecto e snapshotHash', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));

    const project = await service.createFromArt(
      'u1',
      dto({ tier: 'premium', channel: 'whatsapp' }),
    );

    expect(repos.get(Flyer)!.findOne).toHaveBeenCalledWith({ where: { id: FLYER_ID } });
    const offers = extractOffers(LEGACY_FLYER_CONFIGURATION, 0);
    expect(commercials.createProject).toHaveBeenCalledTimes(1);
    expect(commercials.createProject.mock.calls[0][0]).toBe('u1');
    expect(createdDto()).toMatchObject({
      kitId: KIT_ID, // kit sugerido pelo cliente da arte (sem kitId no DTO)
      title: 'Encarte de outubro — vídeo',
      format: 'talking_art',
      tier: 'premium',
      channel: 'whatsapp',
      aspectRatio: '4:5', // inferido do asset (D12)
      targetDurationS: 15,
      backgroundArtAssetId: ASSET_ID,
      logoBox: undefined,
      sourceArt: {
        kind: 'flyer',
        id: FLYER_ID,
        pageIndex: 0,
        snapshotHash: computeSnapshotHash(offers, ASSET_ID),
      },
    });
    expect(createdDto().briefing).toContain('Arroz Tio João 5kg por R$ 24,90');
    // Snapshot dos produtos: catalogId, imagem e preço anterior preservados (o id estável vem do createProject)
    expect(createdProducts()).toEqual([
      {
        catalogId: ART_CATALOG_A,
        unit: 'un',
        imageUrl: '/uploads/products/arroz.png',
        name: 'Arroz Tio João 5kg',
        price: '24,90',
        originalPrice: '29,90',
        badge: 'OFERTA', // `badgeText` da arte congelado (card do F2, tarefa 6.6)
      },
      expect.objectContaining({ catalogId: ART_CATALOG_B, name: 'Feijão Carioca 1kg' }),
    ]);
    expect(project).toMatchObject({ id: 'p-new', format: 'talking_art' });
  });

  it('trilha: desligada por padrão; ligada só por escolha explícita (achado 5 da 3.7)', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    await service.createFromArt('u1', dto());
    expect(createdDto().musicEnabled).toBe(false);
    commercials.createProject.mockClear();
    await service.createFromArt('u1', dto({ musicEnabled: true }));
    expect(createdDto().musicEnabled).toBe(true);
  });

  it('título, briefing e duração do DTO prevalecem sobre os defaults', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    await service.createFromArt(
      'u1',
      dto({
        title: 'Semana do arroz',
        briefing: 'Fale só do arroz, com humor.',
        targetDurationS: 9,
      }),
    );
    expect(createdDto()).toMatchObject({
      title: 'Semana do arroz',
      briefing: 'Fale só do arroz, com humor.',
      targetDurationS: 9,
    });
  });

  it('arte social: `social` resolve o documento V2 (documentKind social) e lê `productData` dos elementos', async () => {
    repos.get(FlyerBuilderV2Document)!.findOne.mockResolvedValue(docRow(SOCIAL_V2_DOCUMENT));

    await service.createFromArt(
      'u1',
      dto({
        sourceKind: 'social',
        sourceId: DOC_ID,
        logoBox: { x: 0.05, y: 0.02, w: 0.2, h: 0.1 },
      }),
    );

    expect(repos.get(FlyerBuilderV2Document)!.findOne).toHaveBeenCalledWith({
      where: { id: DOC_ID },
    });
    expect(repos.get(Flyer)!.findOne).not.toHaveBeenCalled();
    expect(createdDto()).toMatchObject({
      title: 'Ofertas de sábado — vídeo',
      logoBox: { x: 0.05, y: 0.02, w: 0.2, h: 0.1 },
      sourceArt: {
        kind: 'social',
        id: DOC_ID,
        pageIndex: 0,
        snapshotHash: computeSnapshotHash(extractOffers(SOCIAL_V2_DOCUMENT, 0), ASSET_ID),
      },
    });
    expect(createdProducts().map((p) => p.name)).toEqual(['Leite Integral 1L', 'Queijo Mussarela']);
  });

  it('`social` sem documento V2 cai na linha de `flyers` com kind=social; nada → 404 SOURCE_NOT_FOUND', async () => {
    repos
      .get(Flyer)!
      .findOne.mockResolvedValue(
        flyerRow(LEGACY_FLYER_CONFIGURATION, { kind: 'social', name: 'Social antiga' }),
      );
    await service.createFromArt('u1', dto({ sourceKind: 'social', sourceId: FLYER_ID }));
    expect(createdDto()).toMatchObject({ title: 'Social antiga — vídeo' });

    // encarte comum NÃO responde por `social`
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    expect(
      await responseOf(
        service.createFromArt('u1', dto({ sourceKind: 'social', sourceId: FLYER_ID })),
      ),
    ).toMatchObject({ status: 404, body: { code: 'SOURCE_NOT_FOUND' } });

    repos.get(Flyer)!.findOne.mockResolvedValue(null);
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 404,
      body: { code: 'SOURCE_NOT_FOUND', details: { sourceKind: 'flyer', sourceId: FLYER_ID } },
    });
    expect(commercials.createProject).toHaveBeenCalledTimes(1);
  });

  it('documento V2 multipágina: ofertas da página escolhida; página inexistente → 422 PAGE_NOT_FOUND', async () => {
    repos.get(FlyerBuilderV2Document)!.findOne.mockResolvedValue(docRow(FLYER_V2_DOCUMENT));

    await service.createFromArt(
      'u1',
      dto({ sourceKind: 'v2_document', sourceId: DOC_ID, pageIndex: 1 }),
    );
    // 7 ofertas na página; sem seleção, todas vão (o createProject aplica o teto de 6 do selo)
    expect(createdProducts().map((p) => p.name)).toEqual([
      'Oferta A',
      'Oferta B',
      'Oferta C',
      'Oferta D',
      'Oferta E',
      'Oferta F',
      'Oferta G',
    ]);
    expect(createdDto().sourceArt).toMatchObject({ kind: 'v2_document', pageIndex: 1 });

    expect(
      await responseOf(
        service.createFromArt(
          'u1',
          dto({ sourceKind: 'v2_document', sourceId: DOC_ID, pageIndex: 5 }),
        ),
      ),
    ).toMatchObject({
      status: 422,
      body: { code: 'PAGE_NOT_FOUND', details: { pageIndex: 5, pageCount: 2 } },
    });
  });

  it('encarte legado multipágina (flyers.configuration com pages[]) lê `pages[i].configuration.products`', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(MULTIPAGE_FLYER_CONFIGURATION));
    await service.createFromArt('u1', dto({ pageIndex: 1 }));
    expect(createdProducts().map((p) => p.name)).toEqual(['Café Pilão 500g']);
  });

  // ───────────────────────────── seleção (5.4) ─────────────────────────────

  describe('offer_carousel — seleção ordenada com imagem obrigatória', () => {
    beforeEach(() => {
      repos.get(FlyerBuilderV2Document)!.findOne.mockResolvedValue(docRow(FLYER_V2_DOCUMENT));
    });
    const carousel = (offers: Array<{ id: string; imageUrl?: string | null }>) =>
      dto({
        sourceKind: 'v2_document',
        sourceId: DOC_ID,
        pageIndex: 1,
        format: 'offer_carousel',
        offers,
      });

    it('ordem enviada preservada; imagem faltante resolvida pelo catálogo (catalogId) ou pela galeria (imageUrl)', async () => {
      repos
        .get(Product)!
        .find.mockResolvedValue([
          { id: ART_CATALOG_B, imageUrl: 'http://cdn/uploads/products/c-catalogo.png' },
        ]);
      await service.createFromArt(
        'u1',
        carousel([
          { id: 'of-e' },
          { id: 'of-c' },
          { id: 'of-a' },
          { id: 'of-d', imageUrl: '/uploads/gallery/d.png' },
        ]),
      );
      expect(repos.get(Product)!.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
      );
      expect(createdProducts().map((p) => [p.name, p.imageUrl, p.catalogId])).toEqual([
        ['Oferta E', '/uploads/products/e.png', null],
        ['Oferta C', 'http://cdn/uploads/products/c-catalogo.png', ART_CATALOG_B],
        ['Oferta A', '/uploads/products/a.png', ART_CATALOG_A],
        ['Oferta D', '/uploads/gallery/d.png', null],
      ]);
      expect(createdDto()).toMatchObject({ format: 'offer_carousel', targetDurationS: 25 });
    });

    it('oferta sem imagem (sem catálogo nem galeria) → 422 OFFER_IMAGE_REQUIRED com as pendentes', async () => {
      expect(
        await responseOf(
          service.createFromArt('u1', carousel([{ id: 'of-a' }, { id: 'of-c' }, { id: 'of-d' }])),
        ),
      ).toMatchObject({
        status: 422,
        body: {
          code: 'OFFER_IMAGE_REQUIRED',
          details: {
            offers: [
              { id: 'of-c', name: 'Oferta C', catalogId: ART_CATALOG_B },
              { id: 'of-d', name: 'Oferta D', catalogId: null },
            ],
          },
        },
      });
      expect(commercials.createProject).not.toHaveBeenCalled();
    });

    it('id fora da página → 422 OFFER_NOT_FOUND', async () => {
      expect(
        await responseOf(
          service.createFromArt('u1', carousel([{ id: 'of-a' }, { id: 'of-b' }, { id: 'nope' }])),
        ),
      ).toMatchObject({
        status: 422,
        body: { code: 'OFFER_NOT_FOUND', details: { offerIds: ['nope'] } },
      });
    });
  });

  it('talking_art: até 3 ofertas citadas viram o snapshot; sem imagem obrigatória', async () => {
    repos.get(FlyerBuilderV2Document)!.findOne.mockResolvedValue(docRow(FLYER_V2_DOCUMENT));
    await service.createFromArt(
      'u1',
      dto({
        sourceKind: 'v2_document',
        sourceId: DOC_ID,
        pageIndex: 1,
        offers: [{ id: 'of-g' }, { id: 'of-c' }],
      }),
    );
    expect(createdProducts().map((p) => p.name)).toEqual(['Oferta G', 'Oferta C']);
    expect(createdProducts()[1].imageUrl).toBeNull(); // F1 não exige imagem
  });

  // ───────────────────────────── kit (5.6) ─────────────────────────────

  it('sem kit aprovado do cliente → 422 KIT_REQUIRED com canCreateFromLogo pelo logo do cliente', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    repos.get(McCharacterKit)!.find.mockResolvedValue([]);
    repos
      .get(Client)!
      .findOne.mockResolvedValue({ id: CLIENT_ID, logoUrl: '/uploads/logos/m.png' });
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: {
        code: 'KIT_REQUIRED',
        details: {
          clientId: CLIENT_ID,
          canCreateFromLogo: true,
          clientLogoUrl: '/uploads/logos/m.png',
        },
      },
    });

    repos.get(Client)!.findOne.mockResolvedValue({ id: CLIENT_ID, logoUrl: null });
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: { code: 'KIT_REQUIRED', details: { clientId: CLIENT_ID, canCreateFromLogo: false } },
    });

    // arte sem cliente: não há como sugerir — o front precisa mandar kitId
    repos
      .get(Flyer)!
      .findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION, { clientId: null }));
    expect(await responseOf(service.createFromArt('u1', dto()))).toMatchObject({
      status: 422,
      body: { code: 'KIT_REQUIRED', details: { clientId: null, canCreateFromLogo: false } },
    });
    expect(commercials.createProject).not.toHaveBeenCalled();
  });

  it('kitId explícito é repassado sem consultar a sugestão (ownership/aprovação são do createProject)', async () => {
    repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    await service.createFromArt('u1', dto({ kitId: KIT_2_ID }));
    expect(createdDto().kitId).toBe(KIT_2_ID);
    expect(repos.get(McCharacterKit)!.find).not.toHaveBeenCalled();
    expect(repos.get(Client)!.findOne).not.toHaveBeenCalled();
  });

  describe('suggestKit — kits aprovados do cliente, último usado primeiro', () => {
    it('0 kits: kit null, sem alternativas, canCreateFromLogo pelo logoUrl', async () => {
      repos.get(McCharacterKit)!.find.mockResolvedValue([]);
      repos
        .get(Client)!
        .findOne.mockResolvedValue({ id: CLIENT_ID, logoUrl: '/uploads/logos/m.png' });
      expect(await service.suggestKit('u1', CLIENT_ID)).toEqual({
        clientId: CLIENT_ID,
        kit: null,
        alternatives: [],
        lastUsedKitId: null,
        canCreateFromLogo: true,
        clientLogoUrl: '/uploads/logos/m.png',
      });
      expect(repos.get(Mascot)!.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', clientId: CLIENT_ID } }),
      );
      expect(repos.get(McProject)!.findOne).not.toHaveBeenCalled();
    });

    it('cliente sem mascote nem logo registrado: nenhuma consulta de kit', async () => {
      repos.get(Mascot)!.find.mockResolvedValue([]);
      const suggestion = await service.suggestKit('u1', CLIENT_ID);
      expect(suggestion.kit).toBeNull();
      expect(suggestion.canCreateFromLogo).toBe(false);
      expect(repos.get(McCharacterKit)!.find).not.toHaveBeenCalled();
    });

    it('1 kit aprovado: é o sugerido (kits buscados por mascotes do cliente, status approved)', async () => {
      const suggestion = await service.suggestKit('u1', CLIENT_ID);
      expect(suggestion.kit).toMatchObject({ id: KIT_ID, references: [] });
      expect(suggestion.alternatives).toEqual([]);
      expect(suggestion.lastUsedKitId).toBeNull();
      expect(repos.get(McCharacterKit)!.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u1', status: McKitStatus.APPROVED }),
        }),
      );
    });

    it('2 kits: o último usado (projeto mais recente com kit do cliente) vem primeiro; o outro é alternativa', async () => {
      const kit2 = { ...KIT, id: KIT_2_ID, approvedAt: new Date('2026-10-05') };
      repos.get(McCharacterKit)!.find.mockResolvedValue([kit2, KIT]); // mais recente primeiro
      repos.get(McProject)!.findOne.mockResolvedValue({ id: 'p-old', kitId: KIT_ID });
      const suggestion = await service.suggestKit('u1', CLIENT_ID);
      expect(suggestion.kit?.id).toBe(KIT_ID);
      expect(suggestion.alternatives.map((k) => k.id)).toEqual([KIT_2_ID]);
      expect(suggestion.lastUsedKitId).toBe(KIT_ID);
      expect(repos.get(McProject)!.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u1' }),
          order: { createdAt: 'DESC' },
        }),
      );
      // sem projeto anterior: ordem de aprovação
      repos.get(McProject)!.findOne.mockResolvedValue(null);
      expect((await service.suggestKit('u1', CLIENT_ID)).kit?.id).toBe(KIT_2_ID);
    });

    it('cliente inexistente → 404 CLIENT_NOT_FOUND', async () => {
      repos.get(Client)!.findOne.mockResolvedValue(null);
      expect(await responseOf(service.suggestKit('u1', CLIENT_ID))).toMatchObject({
        status: 404,
        body: { code: 'CLIENT_NOT_FOUND' },
      });
    });
  });

  // ───────────────────────────── arte alterada (5.5) ─────────────────────────────

  describe('sourceArtStatus — "arte de origem alterada"', () => {
    const offers = extractOffers(LEGACY_FLYER_CONFIGURATION, 0);
    const project = {
      sourceArt: {
        kind: 'flyer' as const,
        id: FLYER_ID,
        pageIndex: 0,
        snapshotHash: computeSnapshotHash(offers, ASSET_ID),
      },
      backgroundArtAssetId: ASSET_ID,
    };

    it('origem igual → false; projeto sem ponte → false sem consultar o banco', async () => {
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
      expect(await service.sourceArtStatus(project)).toEqual({
        sourceArt: project.sourceArt,
        sourceArtChanged: false,
        sourceArtMissing: false,
      });
      expect(
        await service.sourceArtStatus({ sourceArt: null, backgroundArtAssetId: null }),
      ).toEqual({ sourceArt: null, sourceArtChanged: false, sourceArtMissing: false });
      expect(repos.get(Flyer)!.findOne).toHaveBeenCalledTimes(1);
    });

    it('preço editado no encarte depois do vídeo → true (o projeto mantém o snapshot)', async () => {
      const edited = JSON.parse(JSON.stringify(LEGACY_FLYER_CONFIGURATION));
      edited.products[0].price = 22.9;
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(edited));
      expect(await service.sourceArtStatus(project)).toMatchObject({
        sourceArtChanged: true,
        sourceArtMissing: false,
      });
    });

    it('origem apagada → changed + missing; página que sumiu → changed', async () => {
      repos.get(Flyer)!.findOne.mockResolvedValue(null);
      expect(await service.sourceArtStatus(project)).toMatchObject({
        sourceArtChanged: true,
        sourceArtMissing: true,
      });
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(MULTIPAGE_FLYER_CONFIGURATION));
      expect(
        await service.sourceArtStatus({
          ...project,
          sourceArt: { ...project.sourceArt, pageIndex: 4 },
        }),
      ).toMatchObject({ sourceArtChanged: true, sourceArtMissing: false });
    });

    it('withSourceArtStatus decora a visão do projeto (GET /projects/:id)', async () => {
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
      const view = await service.withSourceArtStatus({ id: 'p1', scenes: [], ...project } as never);
      expect(view).toMatchObject({ id: 'p1', scenes: [], sourceArtChanged: false });
    });
  });

  it('listOffers devolve as ofertas da página com ids, cliente e nº de páginas (para a UI de seleção)', async () => {
    repos.get(FlyerBuilderV2Document)!.findOne.mockResolvedValue(docRow(FLYER_V2_DOCUMENT));
    const view = await service.listOffers('v2_document', DOC_ID, 1);
    expect(view).toMatchObject({
      sourceKind: 'v2_document',
      sourceId: DOC_ID,
      name: 'Encarte quinzenal',
      clientId: CLIENT_ID,
      pageIndex: 1,
      pageCount: 2,
    });
    expect(view.offers.map((o) => o.id)).toEqual([
      'of-a',
      'of-b',
      'of-c',
      'of-d',
      'of-e',
      'of-f',
      'of-g',
    ]);
  });
  // ─────────────────────── caixa do logo (D9b, tarefa 4.6) ───────────────────────

  describe('caixa do logo na criação — camadas layout → detecção → marcação', () => {
    beforeEach(() => {
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
    });

    it('(a) caixa do layout enviada pela ponte é usada como está, confirmada, SEM detecção', async () => {
      await service.createFromArt(
        'u1',
        dto({ logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 }, logoFace: true }),
      );
      expect(locator.locate).not.toHaveBeenCalled();
      expect(createdDto().logoBox).toEqual({
        x: 0.1,
        y: 0.8,
        w: 0.2,
        h: 0.1,
        logoBoxSource: 'layout',
        logoBoxConfidence: null,
        logoBoxConfirmed: true,
        surroundColor: null, // arte fora do disco neste teste: amostragem nunca bloqueia
      });
    });

    it('sem `logoFace` e sem caixa: nenhuma detecção, projeto sem caixa', async () => {
      await service.createFromArt('u1', dto());
      expect(locator.locate).not.toHaveBeenCalled();
      expect(createdDto().logoBox).toBeUndefined();
    });

    it('(b) `logoFace` sem caixa: detecta UMA vez (arte + logo do kit) e grava a proposta ≥ 0,7 não confirmada', async () => {
      await service.createFromArt('u1', dto({ logoFace: true }));
      expect(locator.locate).toHaveBeenCalledTimes(1);
      expect(locator.locate).toHaveBeenCalledWith(
        '/srv/uploads/commercials/art/u1/a.png',
        '/srv/uploads/mascots/u1/logo-cutout.png',
      );
      expect(repos.get(McCharacterKit)!.findOne).toHaveBeenCalledWith({
        where: { id: KIT_ID, userId: 'u1' },
      });
      expect(createdDto().logoBox).toEqual({
        ...LOGO_BOX,
        logoBoxSource: 'detected',
        logoBoxConfidence: 0.92,
        logoBoxConfirmed: false,
        surroundColor: null,
      });
    });

    it('(c) detecção < 0,7, visão fora do ar ou kit de mascote: cria sem caixa (o usuário marca depois)', async () => {
      locator.locate.mockResolvedValueOnce(detection({ confidence: 0.5 }));
      await service.createFromArt('u1', dto({ logoFace: true }));
      expect(commercials.createProject.mock.calls[0][1].logoBox).toBeUndefined();

      locator.locate.mockResolvedValueOnce(
        detection({ found: false, bbox: null, confidence: 0, error: 'HTTP 503' }),
      );
      await service.createFromArt('u1', dto({ logoFace: true }));
      expect(commercials.createProject.mock.calls[1][1].logoBox).toBeUndefined();

      repos.get(McCharacterKit)!.findOne.mockResolvedValueOnce({ ...KIT, source: 'mascot' });
      await service.createFromArt('u1', dto({ logoFace: true }));
      expect(commercials.createProject.mock.calls[2][1].logoBox).toBeUndefined();
      expect(locator.locate).toHaveBeenCalledTimes(2); // o kit de mascote nem chega a detectar
    });

    it('logo do kit sem arquivo: pula a detecção sem derrubar a criação', async () => {
      repos
        .get(Mascot)!
        .findOne.mockResolvedValueOnce({ ...LOGO_MASCOT, cutoutUrl: null, sourceImageUrl: '' });
      await service.createFromArt('u1', dto({ logoFace: true }));
      expect(locator.locate).not.toHaveBeenCalled();
      expect(commercials.createProject).toHaveBeenCalledTimes(1);
    });
  });

  describe('detectLogoBox / setLogoBox — POST .../logo-box/detect e PUT .../logo-box', () => {
    const PROJECT_ID = '77777777-7777-4777-8777-777777777777';
    let project: Record<string, unknown>;

    beforeEach(() => {
      project = {
        id: PROJECT_ID,
        userId: 'u1',
        kitId: KIT_ID,
        status: McProjectStatus.STORYBOARD_REVIEW,
        format: 'talking_art',
        backgroundArtAssetId: ASSET_ID,
        logoBox: null,
      };
      repos.get(McProject)!.findOneBy.mockImplementation(() => Promise.resolve({ ...project }));
    });

    const updateCall = () => repos.get(McProject)!.update.mock.calls[0];

    it('detecção ≥ 0,7: grava a proposta (CAS por status) e devolve a ação de confirmar', async () => {
      const view = await service.detectLogoBox('u1', PROJECT_ID);
      expect(locator.locate).toHaveBeenCalledWith(
        '/srv/uploads/commercials/art/u1/a.png',
        '/srv/uploads/mascots/u1/logo-cutout.png',
      );
      expect(art.findOwned).toHaveBeenCalledWith('u1', ASSET_ID);
      const proposal = {
        ...LOGO_BOX,
        logoBoxSource: 'detected',
        logoBoxConfidence: 0.92,
        logoBoxConfirmed: false,
        surroundColor: null,
      };
      const [criteria, patch] = updateCall();
      expect(criteria).toMatchObject({ id: PROJECT_ID, userId: 'u1' });
      expect(criteria.status.value).toEqual(['storyboard_review', 'visual_review']);
      expect(patch).toEqual({ logoBox: proposal });
      expect(view).toEqual({
        projectId: PROJECT_ID,
        logoBox: proposal,
        source: 'detected',
        confidence: 0.92,
        confirmed: false,
        actions: ['confirm_logo_box', 'mark_logo_box'],
        detection: detection(),
      });
    });

    it('detecção < 0,7: pede a marcação e devolve a caixa fraca como dica (sem gravá-la)', async () => {
      locator.locate.mockResolvedValue(detection({ confidence: 0.4 }));
      const view = await service.detectLogoBox('u1', PROJECT_ID);
      expect(updateCall()[1]).toEqual({ logoBox: null });
      expect(view).toMatchObject({
        logoBox: null,
        source: 'none',
        confidence: 0.4,
        confirmed: false,
        actions: ['mark_logo_box', 'use_window'],
        detection: { bbox: LOGO_BOX, confidence: 0.4 },
      });
    });

    it('"não localizado" nunca apaga caixa confirmada (layout/usuário); proposta não confirmada é descartada', async () => {
      locator.locate.mockResolvedValue(detection({ found: false, bbox: null, confidence: 0 }));
      const userBox = {
        x: 0.3,
        y: 0.02,
        w: 0.25,
        h: 0.08,
        logoBoxSource: 'user',
        logoBoxConfidence: null,
        logoBoxConfirmed: true,
      };
      project.logoBox = userBox;
      const kept = await service.detectLogoBox('u1', PROJECT_ID);
      expect(kept).toMatchObject({
        logoBox: userBox,
        source: 'user',
        confirmed: true,
        actions: [],
      });

      project.logoBox = {
        ...LOGO_BOX,
        logoBoxSource: 'detected',
        logoBoxConfidence: 0.8,
        logoBoxConfirmed: false,
      };
      const dropped = await service.detectLogoBox('u1', PROJECT_ID);
      expect(dropped).toMatchObject({ logoBox: null, source: 'none' });
      expect(repos.get(McProject)!.update.mock.calls[1][1]).toEqual({ logoBox: null });
    });

    it('visão fora do ar: 200 com "não localizado" e o erro em `detection` (nunca 5xx)', async () => {
      locator.locate.mockResolvedValue(
        detection({ found: false, bbox: null, confidence: 0, error: 'HTTP 503' }),
      );
      const view = await service.detectLogoBox('u1', PROJECT_ID);
      expect(view).toMatchObject({ source: 'none', detection: { error: 'HTTP 503' } });
    });

    it('fora da revisão → 422 PROJECT_NOT_EDITABLE sem detectar; dono errado 403; inexistente 404', async () => {
      project.status = McProjectStatus.GENERATING;
      expect(await responseOf(service.detectLogoBox('u1', PROJECT_ID))).toMatchObject({
        status: 422,
        body: {
          code: 'PROJECT_NOT_EDITABLE',
          details: { status: 'generating', allowed: ['storyboard_review', 'visual_review'] },
        },
      });
      expect(
        await responseOf(service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 })),
      ).toMatchObject({ status: 422, body: { code: 'PROJECT_NOT_EDITABLE' } });
      expect(locator.locate).not.toHaveBeenCalled();
      expect(repos.get(McProject)!.update).not.toHaveBeenCalled();

      project.status = McProjectStatus.VISUAL_REVIEW;
      project.userId = 'outro';
      expect((await responseOf(service.detectLogoBox('u1', PROJECT_ID))).status).toBe(403);
      repos.get(McProject)!.findOneBy.mockResolvedValueOnce(null);
      expect(await responseOf(service.detectLogoBox('u1', PROJECT_ID))).toMatchObject({
        status: 404,
        body: { code: 'PROJECT_NOT_FOUND' },
      });
    });

    it('projeto sem arte → 422 LOGO_BOX_ART_MISSING; kit de mascote → 422 KIT_NOT_LOGO', async () => {
      project.backgroundArtAssetId = null;
      expect(await responseOf(service.detectLogoBox('u1', PROJECT_ID))).toMatchObject({
        status: 422,
        body: { code: 'LOGO_BOX_ART_MISSING' },
      });
      project.backgroundArtAssetId = ASSET_ID;
      repos.get(McCharacterKit)!.findOne.mockResolvedValueOnce({ ...KIT, source: 'mascot' });
      expect(await responseOf(service.detectLogoBox('u1', PROJECT_ID))).toMatchObject({
        status: 422,
        body: { code: 'KIT_NOT_LOGO', details: { actions: ['mark_logo_box', 'use_window'] } },
      });
      expect(locator.locate).not.toHaveBeenCalled();
    });

    it('status mudou entre a leitura e a escrita (CAS perdido) → 422 PROJECT_NOT_EDITABLE', async () => {
      repos.get(McProject)!.update.mockResolvedValueOnce({ affected: 0 });
      expect(await responseOf(service.detectLogoBox('u1', PROJECT_ID))).toMatchObject({
        status: 422,
        body: { code: 'PROJECT_NOT_EDITABLE' },
      });
    });

    it('PUT: marcação do usuário vira `user` confirmada; repetir a proposta confirma a detecção', async () => {
      const marked = await service.setLogoBox('u1', PROJECT_ID, {
        x: 0.3,
        y: 0.02,
        w: 0.25,
        h: 0.08,
      });
      expect(updateCall()[1]).toEqual({
        logoBox: {
          x: 0.3,
          y: 0.02,
          w: 0.25,
          h: 0.08,
          logoBoxSource: 'user',
          logoBoxConfidence: null,
          logoBoxConfirmed: true,
          surroundColor: null,
        },
      });
      expect(marked).toMatchObject({
        source: 'user',
        confirmed: true,
        actions: [],
        detection: null,
      });

      project.logoBox = {
        ...LOGO_BOX,
        logoBoxSource: 'detected',
        logoBoxConfidence: 0.92,
        logoBoxConfirmed: false,
      };
      project.status = McProjectStatus.VISUAL_REVIEW;
      const confirmed = await service.setLogoBox('u1', PROJECT_ID, { ...LOGO_BOX });
      expect(confirmed).toMatchObject({
        logoBox: {
          ...LOGO_BOX,
          logoBoxSource: 'detected',
          logoBoxConfidence: 0.92,
          logoBoxConfirmed: true,
        },
        source: 'detected',
        confirmed: true,
      });
      expect(locator.locate).not.toHaveBeenCalled();
    });

    it('PUT: caixa fora da arte → 422 LOGO_BOX_OUT_OF_BOUNDS; pequena → LOGO_BOX_TOO_SMALL; sem arte → LOGO_BOX_ART_MISSING', async () => {
      expect(
        await responseOf(service.setLogoBox('u1', PROJECT_ID, { x: 0.9, y: 0.5, w: 0.2, h: 0.1 })),
      ).toMatchObject({
        status: 422,
        body: { code: 'LOGO_BOX_OUT_OF_BOUNDS', details: { right: 1.1 } },
      });
      expect(
        await responseOf(
          service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: 0.2, h: 0.005 }),
        ),
      ).toMatchObject({ status: 422, body: { code: 'LOGO_BOX_TOO_SMALL' } });
      expect(
        await responseOf(service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: NaN, h: 0.1 })),
      ).toMatchObject({ status: 422, body: { code: 'LOGO_BOX_INVALID' } });
      project.backgroundArtAssetId = null;
      expect(
        await responseOf(service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 })),
      ).toMatchObject({ status: 422, body: { code: 'LOGO_BOX_ART_MISSING' } });
      expect(repos.get(McProject)!.update).not.toHaveBeenCalled();
    });
  });

  describe('rosto do logo — cor da arte em volta da caixa (surroundColor)', () => {
    const PROJECT_ID = '88888888-8888-4888-8888-888888888888';
    let dir: string;
    let project: Record<string, unknown>;

    /**
     * Arte 200×100: fundo #C62828 (cabeçalho), placa branca em (20,10)-(80,70)
     * onde está o logo, e um bloco azul longe dela (não entra no anel).
     */
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-from-art-ring-'));
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
        '<rect width="200" height="100" fill="#C62828"/>' +
        '<rect x="20" y="10" width="60" height="60" fill="#FFFFFF"/>' +
        '<rect x="150" y="60" width="40" height="30" fill="#1565C0"/>' +
        '</svg>';
      await sharp(Buffer.from(svg)).png().toFile(path.join(dir, 'a.png'));
      storage.absoluteFromUrl.mockImplementation(() => path.join(dir, 'a.png'));
      repos.get(Flyer)!.findOne.mockResolvedValue(flyerRow(LEGACY_FLYER_CONFIGURATION));
      project = {
        id: PROJECT_ID,
        userId: 'u1',
        kitId: KIT_ID,
        status: McProjectStatus.STORYBOARD_REVIEW,
        format: 'talking_art',
        backgroundArtAssetId: ASSET_ID,
        logoBox: null,
      };
      repos.get(McProject)!.findOneBy.mockImplementation(() => Promise.resolve({ ...project }));
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('caixa do layout no F1: grava a cor da arte EM VOLTA da caixa (não a placa de dentro)', async () => {
      await service.createFromArt(
        'u1',
        dto({ logoBox: { x: 0.1, y: 0.1, w: 0.3, h: 0.6 }, logoFace: true }),
      );
      expect(createdDto().logoBox).toMatchObject({
        logoBoxSource: 'layout',
        logoBoxConfirmed: true,
        surroundColor: '#C62828',
      });
    });

    it('PUT logo-box: mover a caixa amostra de novo (a cor acompanha a caixa)', async () => {
      await service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: 0.3, h: 0.6 });
      expect(repos.get(McProject)!.update.mock.calls[0][1].logoBox.surroundColor).toBe('#C62828');
      // caixa DENTRO do bloco azul: o anel em volta passa a ser azul
      await service.setLogoBox('u1', PROJECT_ID, { x: 0.78, y: 0.66, w: 0.14, h: 0.18 });
      expect(repos.get(McProject)!.update.mock.calls[1][1].logoBox.surroundColor).toBe('#1565C0');
    });

    it('detecção gravada também leva a cor; arte ilegível → surroundColor null sem derrubar', async () => {
      await service.detectLogoBox('u1', PROJECT_ID);
      expect(repos.get(McProject)!.update.mock.calls[0][1].logoBox).toMatchObject({
        logoBoxSource: 'detected',
        surroundColor: '#C62828',
      });
      await fs.writeFile(path.join(dir, 'a.png'), 'não é png');
      await service.setLogoBox('u1', PROJECT_ID, { x: 0.1, y: 0.1, w: 0.3, h: 0.6 });
      expect(repos.get(McProject)!.update.mock.calls[1][1].logoBox.surroundColor).toBeNull();
    });
  });
});
