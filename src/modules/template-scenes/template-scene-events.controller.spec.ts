import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { AnimationEventsService } from '../../shared/events/animation-events.service';
import { sceneNotFound } from './scene.errors';
import { TemplateScenesService } from './services/template-scenes.service';
import {
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  TemplateSceneEventsController,
} from './template-scene-events.controller';

describe('TemplateSceneEventsController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(assertExists: () => Promise<void> = async () => undefined) {
    const unsubscribe = jest.fn();
    let listener: (event: unknown) => void = () => undefined;
    const events = {
      subscribeScene: jest.fn((_id: string, fn: (event: unknown) => void) => {
        listener = fn;
        return unsubscribe;
      }),
    };
    const scenes = { assertExists: jest.fn(assertExists) };
    const req = new EventEmitter() as unknown as Request;
    const written: string[] = [];
    const res = {
      writeHead: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
    } as unknown as Response;
    const controller = new TemplateSceneEventsController(
      events as unknown as AnimationEventsService,
      scenes as unknown as TemplateScenesService,
    );
    return {
      controller,
      events,
      scenes,
      req,
      res,
      written,
      unsubscribe,
      emit: (e: unknown) => listener(e),
    };
  }

  it('abre o stream SSE com retry de 5 s e assina a cena pelo id', async () => {
    const { controller, events, res, req, written } = setup();
    await controller.stream('scene-1', req, res);

    expect((res.writeHead as jest.Mock).mock.calls[0]).toEqual([
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }),
    ]);
    expect(written[0]).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
    expect(events.subscribeScene).toHaveBeenCalledWith('scene-1', expect.any(Function));
  });

  it('repassa cada evento como linha data: JSON', async () => {
    const { controller, res, req, written, emit } = setup();
    await controller.stream('s', req, res);
    emit({ sceneId: 's', kind: 'version.step', step: 'generating', revision: 4 });
    expect(written[1]).toBe(
      `data: ${JSON.stringify({ sceneId: 's', kind: 'version.step', step: 'generating', revision: 4 })}\n\n`,
    );
  });

  it('manda heartbeat a cada 25 s', async () => {
    const { controller, res, req, written } = setup();
    await controller.stream('s', req, res);
    jest.advanceTimersByTime(SSE_HEARTBEAT_MS * 2);
    expect(written.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(2);
    expect(SSE_HEARTBEAT_MS).toBe(25_000);
  });

  it('ao fechar a conexão cancela a assinatura e o heartbeat', async () => {
    const { controller, res, req, written, unsubscribe } = setup();
    await controller.stream('s', req, res);
    (req as unknown as EventEmitter).emit('close');
    const count = written.length;
    jest.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalled();
    expect(written).toHaveLength(count);
  });

  it('cena inexistente: 404 antes de abrir o stream', async () => {
    const { controller, res, req, events } = setup(async () => {
      throw sceneNotFound();
    });
    await expect(controller.stream('s', req, res)).rejects.toMatchObject({ status: 404 });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(events.subscribeScene).not.toHaveBeenCalled();
  });
});
