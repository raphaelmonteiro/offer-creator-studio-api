import { NotFoundException } from '@nestjs/common';
import { baseClient, buildClientsService, footerItem, headerItem } from './clients.testutil';

describe('ClientsService - biblioteca de cabeçalhos (headers)', () => {
  it('cria com headers e devolve os modelos na mesma ordem', async () => {
    const { service } = buildClientsService();
    const created = await service.create({
      ...baseClient('1'),
      headers: [headerItem('h1', 'Cabeçalho 1'), headerItem('h2', 'Cabeçalho 2')],
    });
    expect(created.headers?.map((h) => h.id)).toEqual(['h1', 'h2']);
    expect((await service.findOne(created.id)).headers).toHaveLength(2);
  });

  it('cria sem headers: fica nulo (lido como lista vazia) e rodapés vazios', async () => {
    const { service } = buildClientsService();
    const created = await service.create(baseClient('2'));
    expect(created.headers).toBeNull();
    expect(created.footers).toBeNull();
  });

  it('atualiza só headers sem tocar rodapés, footer legado, contatos e lojas', async () => {
    const { service } = buildClientsService();
    const created = await service.create({
      ...baseClient('3'),
      footer: { legacy: true },
      footers: [footerItem('f1', 'Rodapé'), footerItem('f2', 'Rodapé 2')],
    });
    const updated = await service.update(created.id, { headers: [headerItem('h1', 'Novo')] });
    expect(updated.headers).toHaveLength(1);
    expect(updated.footers?.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(updated.footer).toEqual({ legacy: true });
    expect(updated.name).toBe('Cliente');
  });

  it('headers ausente no PATCH não mexe na biblioteca', async () => {
    const { service } = buildClientsService();
    const created = await service.create({ ...baseClient('4'), headers: [headerItem('h1', 'A')] });
    const updated = await service.update(created.id, { name: 'Outro nome' });
    expect(updated.headers).toHaveLength(1);
    expect(updated.name).toBe('Outro nome');
  });

  it('[] limpa a biblioteca e é idempotente na repetição', async () => {
    const { service } = buildClientsService();
    const created = await service.create({ ...baseClient('5'), headers: [headerItem('h1', 'A')] });
    expect((await service.update(created.id, { headers: [] })).headers).toEqual([]);
    expect((await service.update(created.id, { headers: [] })).headers).toEqual([]);
  });

  it('null limpa a biblioteca', async () => {
    const { service } = buildClientsService();
    const created = await service.create({ ...baseClient('6'), headers: [headerItem('h1', 'A')] });
    expect((await service.update(created.id, { headers: null })).headers).toBeNull();
  });

  it('substitui a biblioteca inteira, sem validar section nem unicidade de id', async () => {
    const { service } = buildClientsService();
    const created = await service.create({ ...baseClient('7'), headers: [headerItem('h1', 'A')] });
    const updated = await service.update(created.id, {
      headers: [
        { id: 'x', name: 'B', section: 'qualquer' },
        { id: 'x', name: 'C' },
      ],
    });
    expect(updated.headers?.map((h) => h.name)).toEqual(['B', 'C']);
  });

  it('cliente antigo (coluna nula, sem o campo) lê sem erro', async () => {
    const { service, repo } = buildClientsService();
    await repo.save({ id: 'old', name: 'Antigo', cnpj: '8', headers: null } as never);
    expect((await service.findOne('old')).headers).toBeNull();
  });

  it('cliente inexistente: 404 e nada gravado', async () => {
    const { service, repo } = buildClientsService();
    await expect(service.update('nao-existe', { headers: [] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.rows.size).toBe(0);
  });
});
