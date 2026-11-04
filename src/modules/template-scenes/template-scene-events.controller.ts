import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AnimationEventsService } from '../../shared/events/animation-events.service';
import { SceneIdPipe } from './template-scenes.controller';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/** Heartbeat do SSE (PV-3) e espera de reconexão sugerida ao navegador. */
export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_RETRY_MS = 5000;

/**
 * SSE da cena (canal `template_scene_events`): qualquer usuário logado acompanha uma cena, sem
 * replay. O estado fica no banco: o front refaz `GET /:id` a cada evento e ao reconectar. Exceção
 * documentada ao envelope `{ success, data }` (SSE é um stream).
 */
@ApiTags('template-scenes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TemplateSceneEnabledGuard)
@Controller('template-scenes/:id/events')
export class TemplateSceneEventsController {
  constructor(
    private readonly events: AnimationEventsService,
    private readonly scenes: TemplateScenesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Eventos da cena em tempo real (SSE)' })
  async stream(
    @Param('id', SceneIdPipe) sceneId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.scenes.assertExists(sceneId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const unsubscribe = this.events.subscribeScene(sceneId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
