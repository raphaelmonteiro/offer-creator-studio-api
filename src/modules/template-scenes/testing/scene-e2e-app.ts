import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { SmartValidationPipe } from '../../../common/pipes/smart-validation.pipe';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { EmailService } from '../../email/email.service';
import { AnimationEventsService } from '../../../shared/events/animation-events.service';
import { TemplateScenesGcRunner } from '../../../shared/gc/template-scenes-gc.runner';
import { UploadsGcService } from '../../../shared/gc/uploads-gc.service';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { SceneTurnProcessor } from '../processors/scene-turn.processor';
import { SceneTurnState } from '../processors/scene-turn-state';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import { SCENE_IMAGE_PROVIDER } from '../providers/scene-image-provider';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneLogoService } from '../services/scene-logo.service';
import { SceneReadService } from '../services/scene-read.service';
import { SceneReconcilerService } from '../services/scene-reconciler.service';
import { SceneTurnService } from '../services/scene-turn.service';
import { SceneVersionsService } from '../services/scene-versions.service';
import { TemplateScenesService } from '../services/template-scenes.service';
import { TemplateSceneEventsController } from '../template-scene-events.controller';
import { TemplateSceneEnabledGuard } from '../template-scene-enabled.guard';
import { TemplateScenesAdminController } from '../template-scenes-admin.controller';
import { TemplateScenesController } from '../template-scenes.controller';

export const E2E_JWT_SECRET = 'segredo-e2e-da-cena';
export const E2E_ADMIN_TOKEN = 'token-admin-e2e';

export interface SceneE2eApp {
  app: INestApplication;
  queue: AnimationQueueService;
  jwt: JwtService;
  /** Fecha o app, a fila e o LISTEN. */
  close(): Promise<void>;
}

/**
 * App Nest do e2e da cena: controllers, services e processor REAIS, banco `chroma_x_e2e`, pg-boss
 * real nesse banco e o provedor `mock` (sem latência). Só o que não pertence à cena é falso: o
 * `EmailService` (que o `AuthService` pede e a cena não usa).
 */
export async function createSceneE2eApp(
  dataSource: DataSource,
  options: { uploadsDir: string; mockSlowMs: number },
): Promise<SceneE2eApp> {
  const opts = dataSource.options as unknown as Record<string, string | number>;
  const config = {
    JWT_SECRET: E2E_JWT_SECRET,
    ADMIN_API_TOKEN: E2E_ADMIN_TOKEN,
    UPLOAD_DEST: options.uploadsDir,
    DB_HOST: opts.host,
    DB_PORT: opts.port,
    DB_USERNAME: opts.username,
    DB_PASSWORD: opts.password,
    DB_DATABASE: opts.database,
    ANIMATIONS_ENABLED: 'false',
    TEMPLATE_SCENE_ENABLED: 'true',
    TEMPLATE_SCENE_IMAGE_PROVIDER: 'mock',
    TEMPLATE_SCENE_MOCK_LATENCY_MS: '0',
    TEMPLATE_SCENE_MOCK_SLOW_MS: String(options.mockSlowMs),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => config] }),
      PassportModule,
      JwtModule.register({ secret: E2E_JWT_SECRET, signOptions: { expiresIn: '1h' } }),
    ],
    controllers: [
      TemplateScenesController,
      TemplateSceneEventsController,
      TemplateScenesAdminController,
    ],
    providers: [
      { provide: DataSource, useValue: dataSource },
      { provide: getRepositoryToken(User), useValue: dataSource.getRepository(User) },
      { provide: EmailService, useValue: {} },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      AuthService,
      JwtStrategy,
      TemplateSceneEnabledGuard,
      SceneLockService,
      SceneReadService,
      SceneFilesService,
      SceneLogoService,
      SceneVersionsService,
      SceneTurnService,
      TemplateScenesService,
      SceneTurnState,
      SceneTurnProcessor,
      SceneReconcilerService,
      TemplateScenesGcRunner,
      UploadsGcService,
      AnimationQueueService,
      AnimationEventsService,
      {
        provide: SCENE_IMAGE_PROVIDER,
        inject: [ConfigService],
        useFactory: (c: ConfigService) => new MockSceneImageProvider(c),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new SmartValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const queue = app.get(AnimationQueueService);
  const processor = app.get(SceneTurnProcessor);
  await queue.subscribe(
    QUEUES.TEMPLATE_SCENE_TURN,
    1,
    (job: { sceneId: string; versionId: string }, jobId: string) => processor.process(job, jobId),
  );
  return {
    app,
    queue,
    jwt: app.get(JwtService),
    close: () => app.close(),
  };
}
