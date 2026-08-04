import { Controller, Req, Res, UseGuards } from '@nestjs/common';
import { Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { AnimationEventsService } from '../services/animation-events.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan } from 'typeorm';
import { AnimationTaskEvent } from '../entities/animation-task-event.entity';

const KEEPALIVE_MS = 25_000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * SSE de status (TDD ADR-03/§6.6): stream por usuário com keep-alive `: ping`
 * a cada 25s e replay via Last-Event-ID consultando animation_task_events.
 * Exceção documentada ao envelope { success, data } — SSE é um stream.
 */
@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/events')
export class AnimationEventsController {
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
      const missed = await this.dataSource.getRepository(AnimationTaskEvent).find({
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
            kind: event.kind,
            taskId: event.taskId,
            status: event.toStatus,
            at: event.createdAt,
          })}\n\n`,
        );
      }
    }

    const unsubscribe = this.events.subscribe(user.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    });
  }
}
