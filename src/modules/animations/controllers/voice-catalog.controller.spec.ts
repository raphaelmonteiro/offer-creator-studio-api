import { DataSource } from 'typeorm';
import { VoiceCatalogController } from './voice-catalog.controller';

/**
 * GET /animations/voices com o predicado de tenant (D10): o repositório é um
 * mock em memória que avalia o `where` do TypeORM (array = OR entre
 * alternativas; objeto = AND entre chaves) sobre um catálogo fixo, para que
 * os três cenários da spec `video-character-kit` sejam verificados pelo
 * RESULTADO da rota, não só pela forma da consulta.
 */
describe('VoiceCatalogController — vozes visíveis por tenant (D10)', () => {
  const catalog = [
    {
      id: 'c1',
      providerVoiceId: 'pv-c1',
      name: 'Liam — Jovem',
      enabled: true,
      curated: true,
      ownerUserId: null,
      sort: 0,
    },
    {
      id: 'c2',
      providerVoiceId: 'pv-c2',
      name: 'Laura — Animada',
      enabled: true,
      curated: true,
      ownerUserId: null,
      sort: 1,
    },
    {
      id: 'off',
      providerVoiceId: 'pv-off',
      name: 'Fora do ar',
      enabled: false,
      curated: true,
      ownerUserId: null,
      sort: 2,
    },
    {
      id: 'mine',
      providerVoiceId: 'pv-mine',
      name: 'Meu clone',
      enabled: true,
      curated: false,
      ownerUserId: 'u1',
      sort: 100,
    },
    {
      id: 'theirs',
      providerVoiceId: 'pv-theirs',
      name: 'Clone do outro',
      enabled: true,
      curated: false,
      ownerUserId: 'u2',
      sort: 101,
    },
    {
      id: 'orphan',
      providerVoiceId: 'pv-orphan',
      name: 'Voice Library',
      enabled: true,
      curated: false,
      ownerUserId: null,
      sort: 102,
    },
  ];

  const matches = (row: Record<string, unknown>, where: unknown): boolean => {
    const alternatives = Array.isArray(where) ? where : [where];
    return alternatives.some((alt) =>
      Object.entries(alt as Record<string, unknown>).every(([k, v]) => row[k] === v),
    );
  };

  let find: jest.Mock;
  let controller: VoiceCatalogController;

  beforeEach(() => {
    find = jest.fn(async ({ where }: { where: unknown }) =>
      catalog.filter((r) => matches(r, where)),
    );
    const dataSource = { getRepository: jest.fn(() => ({ find })) };
    controller = new VoiceCatalogController(dataSource as unknown as DataSource);
  });

  it('voz curada: todas as curadas habilitadas aparecem para qualquer usuário', async () => {
    const u1 = (await controller.findAll({ id: 'u1' })) as Array<{ id: string }>;
    const u3 = (await controller.findAll({ id: 'u3' })) as Array<{ id: string }>;
    expect(u1.map((v) => v.id)).toEqual(expect.arrayContaining(['c1', 'c2']));
    expect(u3.map((v) => v.id)).toEqual(['c1', 'c2']);
  });

  it('voz de outro tenant: não aparece na lista deste usuário; a dele própria aparece', async () => {
    const ids = ((await controller.findAll({ id: 'u1' })) as Array<{ id: string }>).map(
      (v) => v.id,
    );
    expect(ids).toContain('mine');
    expect(ids).not.toContain('theirs');
  });

  it('voz não curada sem dono: oculta para todos; voz desabilitada idem', async () => {
    for (const userId of ['u1', 'u2', 'u3']) {
      const ids = ((await controller.findAll({ id: userId })) as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(ids).not.toContain('orphan');
      expect(ids).not.toContain('off');
    }
  });

  it('a consulta usa o predicado compartilhado: enabled E (curated OU ownerUserId = usuário), ordenada', async () => {
    await controller.findAll({ id: 'u1' });
    expect(find).toHaveBeenCalledWith({
      where: [
        { enabled: true, curated: true },
        { enabled: true, ownerUserId: 'u1' },
      ],
      order: { sort: 'ASC', name: 'ASC' },
    });
  });

  it('catálogo sem voz visível → vozes padrão (seed ainda não rodou)', async () => {
    find.mockResolvedValueOnce([]);
    const out = (await controller.findAll({ id: 'u9' })) as Array<{ id: string }>;
    expect(out.map((v) => v.id)).toEqual(['default-1', 'default-2', 'default-3']);
  });
});
