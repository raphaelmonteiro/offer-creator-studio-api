import { HttpException } from '@nestjs/common';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { SceneElementDto } from '../dto/patch-elements.dto';

/** Status HTTP e `code` do erro lançado pela promessa (falha o teste se ela resolver). */
export async function errorOf(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), code: (http.getResponse() as { code: string }).code };
  }
  throw new Error('esperava um erro');
}

/** Corpo do erro HTTP lançado pela promessa (`code`, `message`, `details`). */
export async function errorBodyOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('esperava um erro');
}

export function textElement(id: string, overrides: Partial<SceneElementDto> = {}): SceneElementDto {
  return Object.assign(new SceneElementDto(), {
    id,
    kind: 'text',
    name: `Texto ${id}`,
    x: 0.5,
    y: 0.1,
    w: 0.4,
    aspect: 3,
    rotation: 0,
    z: 1,
    text: 'Páscoa',
    ...overrides,
  });
}

/** Fila falsa: `publish` registra as chamadas (nome da fila, dados e opções) e devolve um id de job. */
export function fakeQueue() {
  const publish = jest.fn<
    Promise<string | null>,
    [string, Record<string, unknown>, Record<string, unknown>?]
  >(async () => 'job-fake');
  return { publish, service: { publish } as unknown as AnimationQueueService };
}
