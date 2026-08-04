import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter } from 'events';
import { Client } from 'pg';

export interface AnimationEvent {
  userId: string;
  kind: 'task' | 'render';
  taskId?: string;
  renderId?: string;
  status: string;
  progressPct?: number;
  stepLabel?: string | null;
  at: string;
}

/**
 * Lado API do barramento de eventos (TDD ADR-03): conexão pg dedicada em
 * LISTEN animation_events; fan-out em memória por userId para os streams SSE.
 */
@Injectable()
export class AnimationEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnimationEventsService.name);
  private readonly emitter = new EventEmitter();
  private client: Client | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    this.emitter.setMaxListeners(500);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.ANIMATIONS_ENABLED === 'false' || process.env.WORKER_ONLY === 'true') return;
    try {
      const opts = this.dataSource.options as unknown as Record<string, unknown>;
      this.client = new Client({
        host: opts.host as string,
        port: opts.port as number,
        user: opts.username as string,
        password: opts.password as string,
        database: opts.database as string,
      });
      await this.client.connect();
      await this.client.query('LISTEN animation_events');
      this.client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          const event = JSON.parse(msg.payload) as AnimationEvent;
          this.emitter.emit(`user:${event.userId}`, event);
        } catch {
          this.logger.warn('Payload de notificação inválido');
        }
      });
      this.client.on('error', (err) => this.logger.error(`LISTEN: ${err.message}`));
      this.logger.log('LISTEN animation_events ativo');
    } catch (err) {
      this.logger.error(`Falha ao iniciar LISTEN: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.end().catch(() => undefined);
  }

  subscribe(userId: string, listener: (event: AnimationEvent) => void): () => void {
    const channel = `user:${userId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
