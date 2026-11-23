import { useE2eHarness } from '../../shared/testing/e2e-harness';
import { describeIfE2eDb } from '../../shared/testing/e2e-test-db';
import { fetchUploadsFile } from '../../shared/testing/uploads-static.testutil';
import { FontsController } from './fonts.controller';
import { FontsService } from './fonts.service';

const FONT_BYTES = Buffer.from([0, 1, 0, 0, 0, 12, 0, 128, 0, 3, 0, 96]);

/**
 * e2e das fontes enviadas (change 34-add-flyer-pro-google-fonts, U5.13) sobre o harness da 05: guard JWT, pipe, filtro,
 * `multipart` e o estático `/uploads/` do `main.ts` (`serveUploads`), no banco `_e2e` e numa pasta de uploads
 * temporária. Apagar a fonte tira a linha e mantém o arquivo servido, porque os encartes do Encarte Pro guardam o
 * endereço dele. Id malformado e campos faltando ficam fora (A-14).
 */
describeIfE2eDb('Fontes enviadas (e2e)', () => {
  const h = useE2eHarness({
    controllers: [FontsController],
    providers: [FontsService],
    serveUploads: true,
  });

  /** Envia `teste.ttf` (família "Teste", peso 700, estilo normal) e devolve a fonte criada. */
  async function uploadFont() {
    const response = await h
      .authed(h.http().post('/v1/fonts'))
      .field('family', 'Teste')
      .field('weight', '700')
      .field('style', 'normal')
      .attach('file', FONT_BYTES, 'teste.ttf');
    expect(response.status).toBe(201);
    const font = response.body.data as { id: string; fileUrl: string };
    h.onCleanup(() => h.dataSource.query(`DELETE FROM fonts WHERE id = $1`, [font.id]));
    return font;
  }

  /** `GET /uploads/fonts/<arquivo>` como o navegador do front: outra origem e nenhum token. */
  const fetchFile = (fileUrl: string) =>
    fetchUploadsFile(h.app.app.getHttpServer(), new URL(fileUrl).pathname);

  const listedIds = async (): Promise<string[]> => {
    const response = await h.get('/fonts');
    expect(response.status).toBe(200);
    return response.body.data.map((font: { id: string }) => font.id);
  };

  it('envia, apaga e continua servindo o arquivo; apagar de novo é 404', async () => {
    const font = await uploadFont();
    expect(font.fileUrl).toMatch(/\/uploads\/fonts\/[^/]+\.ttf$/);
    expect(await listedIds()).toContain(font.id);

    const removed = await h.delete(`/fonts/${font.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      success: true,
      data: { message: 'Fonte removida com sucesso' },
    });
    expect(await listedIds()).not.toContain(font.id);

    const file = await fetchFile(font.fileUrl);
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, FONT_BYTES)).toBe(0);
    expect(file.headers['access-control-allow-origin']).toBe('*');

    const again = await h.delete(`/fonts/${font.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('FONT_NOT_FOUND');
    expect((await fetchFile(font.fileUrl)).status).toBe(200);
  });

  it('sem token: DELETE e GET /v1/fonts dão 401, a fonte fica na lista e o arquivo segue 200', async () => {
    const font = await uploadFont();

    const removed = await h.http().delete(`/v1/fonts/${font.id}`);
    const listed = await h.http().get('/v1/fonts');
    expect(removed.status).toBe(401);
    expect(removed.body.error.code).toBe('UNAUTHORIZED');
    expect(listed.status).toBe(401);
    expect(listed.body.error.code).toBe('UNAUTHORIZED');

    expect(await listedIds()).toContain(font.id);
    expect((await fetchFile(font.fileUrl)).status).toBe(200);
  });
});
