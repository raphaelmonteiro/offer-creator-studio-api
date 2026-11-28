/** Apoio do teste de contrato das rotas das cinco features de IA de produto (sem nenhuma chamada real à OpenAI). */

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import * as fs from 'fs';
import { sign } from 'jsonwebtoken';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { SmartValidationPipe } from '../../common/pipes/smart-validation.pipe';
import { GalleryController } from '../gallery/gallery.controller';
import { GalleryPhotoImportService } from '../gallery/gallery-photo-import.service';
import { GalleryService } from '../gallery/gallery.service';
import { ClientPreferredImagesService } from '../gallery/client-preferred-images.service';
import { GalleryImageEanService } from '../gallery/gallery-image-ean.service';
import { GalleryProductLinkService } from '../gallery/gallery-product-link.service';
import { BackgroundRemovalService } from './background-removal.service';
import { EanMatchJobService } from './ean/ean-match-job.service';
import { OffResolutionService } from './ean/off-resolution.service';
import { SpreadsheetEanMatchService } from './ean/spreadsheet-ean-match.service';
import { FilenameMetadataRecoveryService } from './metadata/filename-metadata-recovery.service';
import { FlyerAssemblyPlanService } from './flyer-assembly-plan.service';
import { MascotScriptService } from './mascot-script.service';
import { SocialSectionLayoutService } from './social-section-layout.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { FlyerEanResolutionService } from './ean/dotcompany/flyer-ean-resolution.service';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { ImageMetadataService } from './metadata/image-metadata.service';
import { ProductImageMatchV2Service } from './metadata/product-image-match-v2.service';
import { ProductNameParserService } from './metadata/product-name-parser.service';
import { PixabayService } from './pixabay.service';
import { ProductCategorizationService } from './product-categorization.service';
import { SpellCheckService } from './spell-check.service';
import {
  buildTemplateElementWithImages,
  buildTemplateGenerateWithImages,
  buildTemplateImage,
  buildTemplateLayers,
} from './template-text-services.testutil';
import { fakeConfig, installFakeOpenAi, spyOnLogger } from './utils/openai-chat.testutil';

export const SECRET = 'segredo-de-teste';
export const USAGE = { prompt_tokens: 1000, completion_tokens: 200 };
export const body = (res: request.Response) => res.body as Record<string, unknown>;
export const PRODUCT_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
let uploadDir: string;

class TestJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: { sub: string }) {
    return { id: payload.sub };
  }
}

/** Pasta de uploads descartável, com a foto que a leitura da Galeria carrega do disco. */
export function createUploadDir(): void {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-spec-'));
  fs.mkdirSync(path.join(uploadDir, 'gallery'));
  fs.writeFileSync(path.join(uploadDir, 'gallery', 'arroz.jpg'), Buffer.from('imagem-falsa'));
}

export function removeUploadDir(): void {
  fs.rmSync(uploadDir, { recursive: true, force: true });
}

const TAXONOMY = { promptList: () => '101|Mercearia > Arroz' } as never;
const SAVED_IMAGE = {
  id: 'img-1',
  filename: 'arroz.jpg',
  url: 'http://localhost:3001/uploads/gallery/arroz.jpg',
};

function buildUploads() {
  return {
    uploadFile: jest.fn().mockResolvedValue({
      id: 'arroz-uuid.jpg',
      filename: SAVED_IMAGE.filename,
      url: SAVED_IMAGE.url,
      mimeType: 'image/jpeg',
      size: 12,
    }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
}

type Uploads = ReturnType<typeof buildUploads>;

/** As cinco features reais, cada uma com o cliente da OpenAI trocado por um simulado (`fakes`). */
function buildFeatures(config: ConfigService) {
  const spell = new SpellCheckService(config);
  const categorization = new ProductCategorizationService(config);
  const pixabay = new PixabayService(config);
  const parser = new ProductNameParserService(config, TAXONOMY);
  const vision = new ImageMetadataService(config, TAXONOMY);
  const fakes = {
    spell: installFakeOpenAi(spell),
    categorization: installFakeOpenAi(categorization),
    translate: installFakeOpenAi(pixabay),
    parser: installFakeOpenAi(parser),
    vision: installFakeOpenAi(vision),
  };
  [spell, categorization, pixabay, parser, vision].forEach((service) => spyOnLogger(service));
  return { spell, categorization, pixabay, parser, vision, fakes };
}

/** Busca por embedding e banco simulados: o que o casamento de fotos e a Galeria usam fora da OpenAI. */
function buildStorage() {
  const embedding = {
    embedText: jest.fn().mockResolvedValue([0.1, 0.2]),
    embedTexts: jest.fn(async (texts: string[], _options?: { strict?: boolean }) =>
      texts.map(() => [0.1, 0.2]),
    ),
    searchByMetadataEmbedding: jest.fn().mockResolvedValue([]),
    setMetadataStatus: jest.fn().mockResolvedValue(undefined),
    saveImageMetadata: jest.fn().mockImplementation(async (_id, metadata) => metadata),
    embedAndStoreMetadataForImage: jest.fn().mockResolvedValue(true),
    embedAndStoreForImage: jest.fn().mockResolvedValue(true),
  };
  // Transação da Galeria (registro da escolha): `SELECT … FOR UPDATE` acha a foto sem metadata e o resto grava.
  const manager = {
    query: jest.fn(async (sql: string, _params?: string[]) =>
      /^\s*SELECT/i.test(sql) ? [{ metadata: null }] : [],
    ),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([]),
    transaction: jest.fn(async (work: (m: typeof manager) => unknown) => work(manager)),
    manager,
  };
  return { embedding, dataSource };
}

type Features = ReturnType<typeof buildFeatures>;
type Storage = ReturnType<typeof buildStorage>;

function buildPhotoMatching(config: ConfigService, features: Features, storage: Storage) {
  const matcher = new ProductImageMatchV2Service(
    storage.embedding as never,
    features.parser,
    TAXONOMY,
    config,
  );
  const none = {} as never;
  const eanResolution = new FlyerEanResolutionService(
    storage.dataSource as never,
    matcher,
    none,
    none,
    none,
    none,
    config,
  );
  return { matcher, eanResolution };
}

function buildGallery(features: Features, storage: Storage, uploads: Uploads) {
  const imagesRepo = {
    create: (value: object) => ({ ...value }),
    save: jest.fn(async (value: object) => ({ ...SAVED_IMAGE, ...value })),
    findOne: jest.fn(async () => ({ ...SAVED_IMAGE })),
  };
  const moduleRef = {
    get: (token: string) =>
      token === 'ImageMetadataService' ? features.vision : storage.embedding,
  };
  const gallery = new GalleryService(
    imagesRepo as never,
    {} as never,
    storage.dataSource as never,
    uploads as never,
    moduleRef as never,
    {} as never,
  );
  spyOnLogger(gallery);
  return gallery;
}

/**
 * Os sete serviços das rotas de template, layout social, plano de montagem e roteiro do mascote, cada um com o
 * cliente da OpenAI (e, nos de template, o provedor de imagem e o disco) simulado: `fakes` guarda o `create` do
 * chat de cada um e `logs` o log capturado do plano de montagem (o único que um teste de contrato lê).
 */
function buildRouteServices(config: ConfigService, env: Record<string, string>, storage: Storage) {
  const vars = { OPENAI_API_KEY: 'sk-teste', ...env };
  const generate = buildTemplateGenerateWithImages(vars);
  const element = buildTemplateElementWithImages(vars);
  const image = buildTemplateImage(vars);
  const layers = buildTemplateLayers(vars);
  const social = new SocialSectionLayoutService(config);
  const assembly = new FlyerAssemblyPlanService(config);
  const mascot = new MascotScriptService(config, storage.dataSource as never);
  const assemblyLogs = spyOnLogger(assembly);
  [social, mascot].forEach((service) => spyOnLogger(service));
  return {
    services: { generate, element, image, layers, social, assembly, mascot },
    fakes: {
      generate: generate.create,
      element: element.create,
      image: image.create,
      layers: layers.create,
      social: installFakeOpenAi(social),
      assembly: installFakeOpenAi(assembly),
      mascot: installFakeOpenAi(mascot),
    },
    logs: { assembly: assemblyLogs },
  };
}

/** Controllers reais, guard e interceptor reais; só as dependências de fora das rotas de IA são vazias. */
const UNUSED_PROVIDERS = [
  BackgroundRemovalService,
  FilenameMetadataRecoveryService,
  OffResolutionService,
  SpreadsheetEanMatchService,
  EanMatchJobService,
  ClientPreferredImagesService,
  GalleryImageEanService,
].map((token) => ({ provide: token, useValue: {} }));

/** Prefixo `v1`, filtro de exceção e validação como no `main.ts`. */
async function startApp(moduleFixture: TestingModule): Promise<INestApplication> {
  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new SmartValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useLogger(false);
  await app.init();
  return app;
}

/** Sobe os controllers reais com os serviços reais das cinco features e o provedor (OpenAI) simulado. */
export async function buildApp(env: Record<string, string> = {}) {
  const config = fakeConfig({
    OPENAI_API_KEY: 'sk-teste',
    PIXABAY_API_KEY: 'pk-teste',
    UPLOAD_DEST: uploadDir,
    ...env,
  });
  const uploads = buildUploads();
  const features = buildFeatures(config);
  const storage = buildStorage();
  const gallery = buildGallery(features, storage, uploads);
  // O download do Pixabay registra a foto pela mesma Galeria real (que dispara a leitura simulada).
  const photoImport = new GalleryPhotoImportService(uploads as never, gallery);
  const { matcher, eanResolution } = buildPhotoMatching(config, features, storage);
  const none = {} as never;
  const routes = buildRouteServices(config, env, storage);
  const { generate, element, image, layers, social, assembly, mascot } = routes.services;
  const aiService = new AiService(
    features.pixabay,
    features.spell,
    generate.service,
    element.service,
    image.service,
    layers.service,
    features.categorization,
    assembly,
    photoImport,
  );

  const moduleFixture = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [AiController, GalleryController],
    providers: [
      TestJwtStrategy,
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      { provide: ConfigService, useValue: config },
      { provide: getDataSourceToken(), useValue: storage.dataSource },
      { provide: AiService, useValue: aiService },
      { provide: ImageMetadataService, useValue: features.vision },
      { provide: ProductImageMatchV2Service, useValue: matcher },
      { provide: FlyerEanResolutionService, useValue: eanResolution },
      { provide: SocialSectionLayoutService, useValue: social },
      { provide: MascotScriptService, useValue: mascot },
      { provide: GalleryEmbeddingService, useValue: storage.embedding },
      { provide: GalleryService, useValue: gallery },
      {
        provide: GalleryProductLinkService,
        useValue: new GalleryProductLinkService(storage.dataSource as never, none),
      },
      ...UNUSED_PROVIDERS,
    ],
  }).compile();

  const app = await startApp(moduleFixture);
  return {
    app,
    fakes: { ...features.fakes, ...routes.fakes },
    logs: routes.logs,
    embedding: storage.embedding,
    dataSource: storage.dataSource,
    uploads,
    gallery,
    photoImport,
  };
}

export const bearer = () => `Bearer ${sign({ sub: 'user-1' }, SECRET)}`;

export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condição não atendida a tempo');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
