import { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { UpdateFlyerProCursorDto } from '../dto/update-flyer-pro-cursor.dto';
import { FlyerProCursorService } from './flyer-pro-cursor.service';

function makeCursor(rows: unknown[] = [{ step: 'assembly', pagesFrozen: true }]) {
  const dataSource = { query: jest.fn().mockResolvedValue([rows, rows.length]) };
  const service = new FlyerProCursorService(dataSource as unknown as DataSource);
  const set = (id: string, body: Record<string, unknown>) =>
    service.set(id, body as unknown as UpdateFlyerProCursorDto);
  return { set, dataSource };
}

async function refusalOf(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (caught: unknown) => caught,
  )) as HttpException;
  expect(error).toBeInstanceOf(HttpException);
  const body = error.getResponse() as { code: string; details?: unknown };
  return { status: error.getStatus(), code: body.code, details: body.details };
}

describe('FlyerProCursorService.set: etapa, estado de tela e páginas congeladas', () => {
  it('um UPDATE só, com a etapa, o ui em JSON e as etapas que congelam, e devolve { step, pagesFrozen }', async () => {
    const { set, dataSource } = makeCursor();
    const ui = { assemblyZoom: 3, selection: { kind: 'section', sectionId: 'cat:Carnes' } };

    await expect(set('d1', { step: 'assembly', ui })).resolves.toEqual({
      step: 'assembly',
      pagesFrozen: true,
    });

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE'), [
      'd1',
      'assembly',
      JSON.stringify(ui),
      ['assembly', 'preflight', 'export'],
    ]);
  });

  it('ui ausente ou nulo vai nulo: o COALESCE mantém o atual', async () => {
    const { set, dataSource } = makeCursor();

    await set('d1', { step: 'card' });
    await set('d1', { step: 'card', ui: null });

    expect(dataSource.query.mock.calls.map(([, params]) => params[2])).toEqual([null, null]);
    expect(dataSource.query.mock.calls[0][0]).toContain('COALESCE($3::jsonb, "ui")');
  });

  it('o SQL liga pagesFrozen sem nunca desligar e não toca revision, updatedAt, autor nem mutação', async () => {
    const { set, dataSource } = makeCursor();

    await set('d1', { step: 'products' });

    const sql: string = dataSource.query.mock.calls[0][0];
    expect(sql).toContain('"pagesFrozen" = "pagesFrozen" OR');
    expect(sql).toContain('"deletedAt" IS NULL');
    for (const column of ['revision', 'updatedAt', 'updatedByUserId', 'lastMutationId']) {
      expect(sql).not.toContain(`"${column}"`);
    }
  });

  it('encarte inexistente ou excluído (nenhuma linha) é 404 FLYER_PRO_NOT_FOUND', async () => {
    const { set } = makeCursor([]);

    await expect(refusalOf(set('d1', { step: 'card' }))).resolves.toMatchObject({
      status: 404,
      code: 'FLYER_PRO_NOT_FOUND',
    });
  });

  it.each([
    ['corpo {}', {}],
    ['step nulo', { step: null }],
  ])('%s é 400 BAD_REQUEST (nunca 500) e nada chega ao banco', async (_name, body) => {
    const { set, dataSource } = makeCursor();

    await expect(refusalOf(set('d1', body))).resolves.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('etapa fora da lista é 400, e as oito etapas passam', async () => {
    const { set, dataSource } = makeCursor();

    await expect(refusalOf(set('d1', { step: 'foo' }))).resolves.toMatchObject({ status: 400 });
    for (const step of [
      'setup',
      'products',
      'frame',
      'structure',
      'card',
      'assembly',
      'preflight',
      'export',
    ]) {
      await set('d1', { step });
    }
    expect(dataSource.query).toHaveBeenCalledTimes(8);
  });

  it('ui de 20 KB é 422 FLYER_PRO_UI_TOO_LARGE com os bytes e o teto, e nada chega ao banco', async () => {
    const { set, dataSource } = makeCursor();
    const ui = { a: 'x'.repeat(20 * 1024) };

    await expect(refusalOf(set('d1', { step: 'assembly', ui }))).resolves.toEqual({
      status: 422,
      code: 'FLYER_PRO_UI_TOO_LARGE',
      details: { bytes: Buffer.byteLength(JSON.stringify(ui)), max: 16_384 },
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('ui de exatamente 16 384 bytes é aceito', async () => {
    const { set, dataSource } = makeCursor();
    const ui = { a: 'x'.repeat(16_384 - '{"a":""}'.length) };

    await set('d1', { step: 'card', ui });

    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });
});
