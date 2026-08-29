import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { DataSource, MoreThan } from 'typeorm';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AnimationEventsService,
  MC_EVENTS_CHANNEL,
} from '../../shared/events/animation-events.service';
import { McEnabledGuard } from './mc-enabled.guard';
import { McEvent } from './entities/mc-event.entity';

const KEEPALIVE_MS = 25_000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * SSE dedicado do módulo de comerciais (canal pg_notify 'mc_events'): stream
 * por usuário com keep-alive `: ping` a cada 25s e replay via Last-Event-ID
 * consultando mc_events (o `id` bigserial é o cursor — índice (userId, id)).
 * Mesmo desenho do SSE do animations, reimplementado aqui porque o boundary
 * de lint proíbe importar daquele módulo. Exceção documentada ao envelope
 * { success, data } — SSE é um stream.
 */
@ApiTags('commercials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, McEnabledGuard)
@Controller('commercials/events')
export class McEventsController {
  constructor(
    private readonly events: AnimationEventsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  async stream(
    @CurrentUser() user: { id: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    // Replay de eventos perdidos (reconexão com Last-Event-ID)
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId && /^\d+$/.test(String(lastEventId))) {
      const missed = await this.dataSource.getRepository(McEvent).find({
        where: {
          userId: user.id,
          id: MoreThan(String(lastEventId)),
          createdAt: MoreThan(new Date(Date.now() - REPLAY_WINDOW_MS)),
        },
        order: { id: 'ASC' },
        take: 100,
      });
      for (const event of missed) {
        res.write(
          `id: ${event.id}\ndata: ${JSON.stringify({
            kind: `mc_${event.refKind}`,
            refKind: event.refKind,
            refId: event.refId,
            event: event.kind,
            status: event.toStatus,
            at: event.createdAt,
          })}\n\n`,
        );
      }
    }

    const unsubscribe = this.events.subscribe(
      user.id,
      (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      MC_EVENTS_CHANNEL,
    );
    const keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    });
  }
}
