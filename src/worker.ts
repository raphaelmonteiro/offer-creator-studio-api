import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Entry point do worker de mídia (TDD ADR-02): mesmo codebase, processo PM2
 * separado (`flyer-media-worker`), sem servidor HTTP. WORKER_ONLY=true ativa
 * os consumers de fila no AnimationsModule e desativa o LISTEN do SSE.
 */
async function bootstrap() {
  process.env.WORKER_ONLY = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  new Logger('MediaWorker').log('flyer-media-worker iniciado (consumers ativos)');
}

bootstrap();
