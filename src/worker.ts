import { NestFactory } from '@nestjs/core';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { pinUploadsDirEnv } from './common/config/uploads-dir';
import { installProcessErrorHandlers } from './shared/process/process-error-handlers';

/**
 * Entry point do worker de mídia (TDD ADR-02): mesmo codebase, processo PM2
 * separado (`flyer-media-worker`), sem servidor HTTP. WORKER_ONLY=true ativa
 * os consumers de fila no AnimationsModule e desativa o LISTEN do SSE.
 *
 * Handlers de `uncaughtException`/`unhandledRejection` (change
 * corrigir-render-remotion-epipe): a morte do compositor/Chromium do Remotion
 * não derruba o worker; erro fatal desconhecido encerra de forma controlada
 * para o PM2 reiniciar. Política em `shared/process/process-error-handlers.ts`.
 */
let app: INestApplicationContext | null = null;

function installHandlers(): void {
  const logger = new Logger('MediaWorker');
  installProcessErrorHandlers(process, {
    logger: { error: (message, stack) => logger.error(message, stack) },
    shutdown: async () => {
      await app?.close();
    },
    exit: (code) => process.exit(code),
  });
}

async function bootstrap() {
  installHandlers();
  new Logger('Bootstrap').log(`Uploads em ${pinUploadsDirEnv()}`);
  process.env.WORKER_ONLY = 'true';
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  new Logger('MediaWorker').log('flyer-media-worker iniciado (consumers ativos)');
}

bootstrap().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  new Logger('Bootstrap').error(`Falha ao iniciar o worker: ${error.message}`, error.stack);
  process.exit(1);
});
