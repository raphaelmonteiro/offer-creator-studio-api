import { EntityManager } from 'typeorm';
import { BriefItem } from '../domain/scene-brief';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { turnMessageOf } from './scene-messages';
import { closeTurnBrief } from './scene-turn-brief';

const OLD: BriefItem = {
  id: 'p1',
  text: 'um rio',
  status: 'open',
  sourceMessageId: 'm0',
  updatedAt: '2026-11-06T12:00:00.000Z',
};
const scene = () => ({ brief: [{ ...OLD }] }) as unknown as TemplateScene;
const version = { id: 'v1', metrics: {} } as unknown as TemplateSceneVersion;
const managerOf = (id: string | null) => {
  const findOne = jest.fn().mockResolvedValue(id ? { id } : null);
  return { manager: { findOne } as unknown as EntityManager, findOne };
};

describe('turnMessageOf e closeTurnBrief (R83)', () => {
  it('a mensagem do turno é a primeira do cliente na versão', async () => {
    const { manager, findOne } = managerOf('m1');
    await expect(turnMessageOf(manager, version)).resolves.toEqual({ id: 'm1' });
    expect(findOne.mock.calls[0][1]).toMatchObject({
      where: { versionId: 'v1', role: 'user' },
      order: { createdAt: 'ASC' },
    });
  });

  it('sem messageId, consulta a mensagem do turno e supera o item de outra mensagem', async () => {
    const { manager, findOne } = managerOf('m1');
    const s = scene();
    await closeTurnBrief(manager, s, version);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(s.brief?.[0].status).toBe('superseded');
  });

  it('com messageId, não consulta de novo e dá o mesmo resultado', async () => {
    const { manager, findOne } = managerOf('m1');
    const s = scene();
    await closeTurnBrief(manager, s, version, { messageId: 'm1' });
    expect(findOne).not.toHaveBeenCalled();
    expect(s.brief?.[0].status).toBe('superseded');
  });
});
