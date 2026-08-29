import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter } from 'events';
import { Client } from 'pg';
import { EVENTS_CHANNEL } from '../state/task-transition.service';

/** Canal pg_notify dedicado do módulo de comerciais (SSE próprio em /commercials/events). */
export const MC_EVENTS_CHANNEL = 'mc_events';

/** Todos os canais escutados pela conexão LISTEN única (barato: 1 LISTEN a mais). */
const LISTEN_CHANNELS = [EVENTS_CHANNEL, MC_EVENTS_CHANNEL] as const;

export interface AnimationEvent {
  userId: string;
  /** 'task' | 'render' no canal de animações; 'mc_project' | 'mc_kit' etc. no mc_events. */
  kind: string;
  taskId?: string;
  renderId?: string;
  status: string;
  progressPct?: number;
  stepLabel?: string | null;
  at: string;
  [key: string]: unknown;
}

/**
 * Lado API do barramento de eventos (TDD ADR-03): conexão pg dedicada com
 * LISTEN nos canais de animações E de comerciais; fan-out em memória por
 * (canal, userId) para os streams SSE — parametrizado por canal para que o
 * stream de /animations/events não receba eventos mc_* e vice-versa
 * (payloads preservados, muda apenas o canal de transporte).
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
    if (process.env.WORKER_ONLY === 'true') return;
    // Sobe se QUALQUER módulo consumidor estiver ativo (animations por default;
    // commercials via MC_ENABLED) — antes o gate era só do animations e
    // desligá-lo mataria o SSE dos comerciais junto.
    const animationsOn = process.env.ANIMATIONS_ENABLED !== 'false';
    const mcOn = process.env.MC_ENABLED === 'true';
    if (!animationsOn && !mcOn) return;
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
      for (const channel of LISTEN_CHANNELS) {
        await this.client.query(`LISTEN ${channel}`);
      }
      this.client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          const event = JSON.parse(msg.payload) as AnimationEvent;
          this.emitter.emit(`${msg.channel}:user:${event.userId}`, event);
        } catch {
          this.logger.warn('Payload de notificação inválido');
        }
      });
      this.client.on('error', (err) => this.logger.error(`LISTEN: ${err.message}`));
      this.logger.log(`LISTEN ativo em: ${LISTEN_CHANNELS.join(', ')}`);
    } catch (err) {
      this.logger.error(`Falha ao iniciar LISTEN: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.end().catch(() => undefined);
  }

  /** Assina eventos de um usuário num canal (default: animation_events — compat). */
  subscribe(
    userId: string,
    listener: (event: AnimationEvent) => void,
    channel: string = EVENTS_CHANNEL,
  ): () => void {
    const key = `${channel}:user:${userId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
