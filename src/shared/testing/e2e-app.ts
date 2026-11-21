import { INestApplication, ModuleMetadata, Provider, Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { configureHttpApp } from '../../common/config/http-app.config';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AiModule } from '../../modules/ai/ai.module';
import { FlyerProJobReconcilerService } from '../../modules/flyer-pro/services/flyer-pro-job-reconciler.service';
import { AuthService } from '../../modules/auth/auth.service';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { EmailService } from '../../modules/email/email.service';
import { UploadsService } from '../../modules/uploads/uploads.service';
import { SharedModule } from '../shared.module';
import { E2E_CDN_URL } from './e2e-seed-identity';
import { E2eAiModule, E2eSharedModule } from './e2e-stub-modules';
import { assertE2eDbUrl, E2E_DB_URL, E2E_TEST_ENTITIES } from './e2e-test-db';

export const E2E_JWT_SECRET = 'segredo-e2e-do-flyer-pro';
export const E2E_JWT_REFRESH_SECRET = 'segredo-refresh-e2e-do-flyer-pro';

/** Chaves de provedores pagos do bloco `x-safe-env` do compose: vazias durante a suíte (A-7). */
export const PAID_KEYS = [
  'OPENAI_API_KEY',
  'PIXABAY_API_KEY',
  'REPLICATE_API_TOKEN',
  'RUNWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'FAL_API_KEY',
  'GEMINI_API_KEY',
  'HEYGEN_API_KEY',
  'DOTCOMPANY_API_TOKEN',
];

/** Flags de IA e de runners de boot do mesmo bloco: desligadas durante a suíte. */
export const BOOT_FLAGS = [
  'AI_GALLERY_EMBEDDING_ENABLED',
  'AI_IMAGE_METADATA_ENABLED',
  'AI_NAME_PARSER_ENABLED',
  'AI_PRODUCT_CATEGORIZATION_ENABLED',
  'AI_SPELLCHECK_ENABLED',
  'AI_FLYER_ASSEMBLY_ENABLED',
  'EAN_IMPORT_RUNNER_ENABLED',
  'EAN_FLYER_RESOLVE_ENABLED',
  'EAN_JOB_RUNNER_ENABLED',
];

/**
 * Grava `values` no `process.env` e devolve a função que o põe como estava (chave ausente volta a ausente). O
 * `ConfigService` do Nest dá prioridade ao `process.env` sobre o objeto do `load`, então é aqui que a chave paga do
 * shell deixa de valer.
 */
export function overrideEnv(values: Record<string, string>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export interface E2eAppOptions {
  dataSource: DataSource;
  uploadsDir: string;
  /**
   * Sobe a fila real (pg-boss) no `chroma_x_e2e`, com o job do Encarte Pro ligado, o provedor `mock` e o consumidor do
   * worker (`WORKER_ONLY`) no próprio processo do teste: só os specs do job (A-21). Sem ela, nenhuma fila sobe.
   */
  jobQueue?: boolean;
  /**
   * O provedor do job com `jobQueue`: `mock` (padrão) ou `real`. Com `real` o app monta os serviços de IA de verdade
   * (categorização, ortografia, busca de fotos e embedding), sempre com as chaves vazias e as flags de IA desligadas do
   * harness: nada é pago, e as fases de IA ficam indisponíveis (change 29).
   */
  enrichProvider?: 'mock' | 'real';
  /** O que o spec pede: módulos, controllers e providers (além do guard JWT e dos repositórios das entidades). */
  imports?: ModuleMetadata['imports'];
  controllers?: Type<unknown>[];
  providers?: Provider[];
}

export interface E2eApp {
  app: INestApplication;
  jwt: JwtService;
  config: ConfigService;
  /** Fecha o app e devolve o `process.env` ao que era antes. */
  close(): Promise<void>;
}

/** As três flags que sobem a fila (`AnimationQueueService`): desligadas, a fila não sobe e nenhuma conexão sai do teste. */
const QUEUE_FLAGS = ['ANIMATIONS_ENABLED', 'TEMPLATE_SCENE_ENABLED', 'FLYER_PRO_ENRICH_ENABLED'];

/**
 * A fila e o job dos specs do job: o job ligado com o provedor `mock`, o consumidor e o reconciliador (`WORKER_ONLY`) no
 * próprio processo e a conexão do pg-boss (`DB_*`) apontada para o banco de e2e, conferido pela regra `_e2e` (A-21).
 */
function jobQueueConfig(provider: 'mock' | 'real'): Record<string, string> {
  const url = assertE2eDbUrl(E2E_DB_URL);
  return {
    FLYER_PRO_ENRICH_ENABLED: 'true',
    FLYER_PRO_ENRICH_PROVIDER: provider,
    WORKER_ONLY: 'true',
    DB_HOST: url.hostname,
    DB_PORT: url.port || '5432',
    DB_USERNAME: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
    DB_DATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

function fixedConfig(
  uploadsDir: string,
  queue: { jobQueue: boolean; provider: 'mock' | 'real' },
): Record<string, string> {
  const blanks = Object.fromEntries(PAID_KEYS.map((key) => [key, '']));
  const flags = Object.fromEntries(BOOT_FLAGS.map((key) => [key, 'false']));
  const queueConfig = queue.jobQueue
    ? jobQueueConfig(queue.provider)
    : Object.fromEntries(QUEUE_FLAGS.map((key) => [key, 'false']));
  return {
    JWT_SECRET: E2E_JWT_SECRET,
    JWT_REFRESH_SECRET: E2E_JWT_REFRESH_SECRET,
    UPLOAD_DEST: uploadsDir,
    CDN_URL: E2E_CDN_URL,
    ...blanks,
    ...flags,
    ...queueConfig,
  };
}

/**
 * App Nest do e2e em processo, com a configuração HTTP de produção (`configureHttpApp`: prefixo `/v1`, JSON até
 * 100 MB, filtro e pipe globais), o `ResponseInterceptor` e o guard JWT real (`JwtStrategy` e `AuthService` sobre o
 * `users` do banco de e2e). Não lê o `backend/.env`, só assina fila com `jobQueue` (A-14, A-21) e não faz chamada paga (A-7). Cada
 * entidade de `E2E_TEST_ENTITIES` ganha o repositório; o que mais o spec precisar vem em `providers`.
 */
export async function createE2eApp(options: E2eAppOptions): Promise<E2eApp> {
  const provider = options.enrichProvider ?? 'mock';
  const config = fixedConfig(options.uploadsDir, {
    jobQueue: options.jobQueue ?? false,
    provider,
  });
  const restoreEnv = overrideEnv(config);
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => config] }),
        PassportModule,
        JwtModule.register({ secret: E2E_JWT_SECRET, signOptions: { expiresIn: '1h' } }),
        ...(options.imports ?? []),
      ],
      controllers: options.controllers ?? [],
      providers: [
        { provide: DataSource, useValue: options.dataSource },
        ...E2E_TEST_ENTITIES.map((entity) => ({
          provide: getRepositoryToken(entity),
          useValue: options.dataSource.getRepository(entity),
        })),
        { provide: EmailService, useValue: {} },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        UploadsService,
        AuthService,
        JwtStrategy,
        ...(options.providers ?? []),
      ],
    })
      // O `FlyerProModule` importa estes dois; os reais não montam no banco de e2e (ver `e2e-stub-modules.ts`).
      .overrideModule(SharedModule)
      .useModule(E2eSharedModule)
      .overrideModule(AiModule)
      .useModule(E2eAiModule.forRoot({ real: provider === 'real' }))
      // O reconciliador varre todos os jobs do banco compartilhado, inclusive os que os specs de banco montam em paralelo:
      // ele é provado nesses specs, com o relógio sob controle, e não roda no app dos specs HTTP.
      .overrideProvider(FlyerProJobReconcilerService)
      .useValue({ start: () => undefined, onModuleDestroy: () => undefined })
      .compile();
    // `bodyParser: false`: como o `main.ts`, quem lê o corpo é a configuração compartilhada.
    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpApp(app);
    await app.init();
    return {
      app,
      jwt: app.get(JwtService),
      config: app.get(ConfigService),
      async close() {
        try {
          await app.close();
        } finally {
          restoreEnv();
        }
      },
    };
  } catch (error) {
    restoreEnv();
    throw error;
  }
}
