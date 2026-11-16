import { JwtService } from '@nestjs/jwt';
import { describeIfE2eDb } from '../../shared/testing/e2e-test-db';
import { useE2eHarness } from '../../shared/testing/e2e-harness';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

/**
 * Fumaça do harness de e2e (change 05-add-backend-e2e-harness): `GET /v1/clients` e `POST /v1/clients` sobre o app com
 * o guard JWT, o pipe, o filtro, o interceptor e o leitor de corpo de produção, no banco `_e2e` com a semente.
 */
describeIfE2eDb('Clientes: fumaça do harness de e2e', () => {
  const h = useE2eHarness({ controllers: [ClientsController], providers: [ClientsService] });

  it('lista com o token da semente: 200, envelope e os dois clientes semeados pelo id', async () => {
    const response = await h.get('/clients');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.pagination).toEqual(
      expect.objectContaining({
        page: 1,
        limit: 20,
        total: expect.any(Number),
        totalPages: expect.any(Number),
      }),
    );
    const ids = response.body.data.map((client: { id: string }) => client.id);
    expect(ids).toEqual(
      expect.arrayContaining([h.seed.clientWithLibrary.id, h.seed.clientLegacyFooter.id]),
    );
  });

  it('sem token: 401 UNAUTHORIZED no envelope de erro', async () => {
    const response = await h.http().get('/v1/clients');
    expect(response.status).toBe(401);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });

  it('token assinado com outro segredo: 401 UNAUTHORIZED', async () => {
    const forged = new JwtService({ secret: 'outro-segredo' }).sign({ sub: h.seed.user.id });
    const response = await h.http().get('/v1/clients').set('Authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('parâmetro desconhecido: 400 BAD_REQUEST (o pipe real)', async () => {
    const response = await h.get('/clients?foo=1');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('corpo de cerca de 1 MB: 201, e não 413 (o limite de produção); o cliente some na limpeza', async () => {
    const elements = Array.from({ length: 4000 }, (_, index) => ({
      id: `el-${index}`,
      type: 'text',
      content: 'x'.repeat(200),
    }));
    const cnpj = `${h.seed.identity.clientWithLibrary.cnpj}-grande`;
    const body = {
      name: 'Cliente de 1 MB',
      cnpj,
      footer: { id: 'grande', width: 540, height: 400, elements },
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(900_000);
    const response = await h.post('/clients', body);
    expect(response.status).toBe(201);
    h.onCleanup(() => h.dataSource.query(`DELETE FROM clients WHERE cnpj = $1`, [cnpj]));
  });
});
