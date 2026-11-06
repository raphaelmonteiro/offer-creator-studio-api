import { DataSource } from 'typeorm';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateScene } from '../entities/template-scene.entity';
import {
  insertMessage,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';
import { SceneReadService } from './scene-read.service';

describeIfSceneDb('SceneReadService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let reads: SceneReadService;
  const created: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    reads = new SceneReadService(dataSource);
  });
  afterAll(async () => {
    await deleteTestScenes(dataSource, created);
    await dataSource.destroy();
  });

  const newScene = async (name: string) => {
    const scene = await insertScene(dataSource, { name });
    created.push(scene.id);
    return scene;
  };

  /** Mensagens numeradas, em ordem, cada uma 1 s depois da anterior. */
  async function addMessages(sceneId: string, count: number): Promise<TemplateSceneMessage[]> {
    const messages: TemplateSceneMessage[] = [];
    const base = Date.now() - count * 1000;
    for (let i = 1; i <= count; i += 1) {
      const message = await insertMessage(dataSource, sceneId, {
        role: i % 2 ? 'user' : 'assistant',
        content: `m${String(i).padStart(3, '0')}`,
      });
      await dataSource.query(`UPDATE template_scene_messages SET "createdAt" = $2 WHERE id = $1`, [
        message.id,
        new Date(base + i * 1000),
      ]);
      messages.push(message);
    }
    return messages;
  }

  describe('Versões mostradas são as que têm imagem', () => {
    it('Conversa sem imagem no meio: o painel vê "Versão 1" e "Versão 2", sem as respostas só de texto', async () => {
      const scene = await newScene('Painel sem imagem no meio');
      const first = await insertReadyVersion(dataSource, scene, 1);
      await insertVersion(dataSource, scene.id, { number: 2, status: 'rejected' });
      await insertVersion(dataSource, scene.id, { number: 3, status: 'failed' });
      const fourth = await insertReadyVersion(dataSource, scene, 4, { operation: 'redraw' });
      scene.currentVersionId = fourth.version.id;
      await dataSource.manager.save(scene);

      const detail = await reads.loadDetail(scene.id);

      expect(detail.versions.items.map((v) => [v.number, v.displayNumber])).toEqual([
        [4, 2],
        [1, 1],
      ]);
      expect(detail.versions.total).toBe(2);
      expect(detail.currentVersion).toMatchObject({ id: fourth.version.id, displayNumber: 2 });
      expect(first.version.id).toBe(detail.versions.items[1].id);
    });

    it('Número não depende da página: 60 versões com imagem, a segunda página continua a sequência da cena', async () => {
      const scene = await newScene('Painel 60');
      const operations = ['generate', 'redraw', 'manual', 'set_layer', 'restore'] as const;
      let number = 0;
      for (let i = 0; i < 60; i += 1) {
        number += 1;
        await insertReadyVersion(dataSource, scene, number, { operation: operations[i % 5] });
        number += 1;
        await insertVersion(dataSource, scene.id, { number, status: 'rejected' });
      }
      const pageOne = await reads.loadDetail(scene.id, 1);
      const pageTwo = await reads.loadDetail(scene.id, 2);

      expect(pageOne.versions).toMatchObject({ total: 60, page: 1, totalPages: 2 });
      expect(pageOne.versions.items).toHaveLength(50);
      expect(pageOne.versions.items[0].displayNumber).toBe(60);
      expect(pageOne.versions.items[49].displayNumber).toBe(11);
      expect(pageTwo.versions.items.map((v) => v.displayNumber)).toEqual([
        10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
      ]);
    });

    it('a versão em leitura aparece como ativa, no step reading, sem número exibido nem janela', async () => {
      const scene = await newScene('Ativa lendo');
      await insertVersion(dataSource, scene.id, { number: 1, status: 'queued', step: 'reading' });
      const detail = await reads.loadDetail(scene.id);
      expect(detail.activeVersion).toMatchObject({
        status: 'queued',
        step: 'reading',
        displayNumber: null,
        windowEndsAt: null,
      });
      expect(detail.versions.items).toEqual([]);
    });

    it('na janela, a versão ativa traz windowEndsAt lido de metrics', async () => {
      const scene = await newScene('Ativa na janela');
      const endsAt = new Date(Date.now() + 5000).toISOString();
      await insertVersion(dataSource, scene.id, {
        number: 1,
        status: 'queued',
        step: null,
        metrics: { windowEndsAt: endsAt },
      });
      expect((await reads.loadDetail(scene.id)).activeVersion?.windowEndsAt).toBe(endsAt);
    });
  });

  describe('Histórico completo na tela', () => {
    it('Carregar mais antigas: o detalhe traz as 50 últimas, e o cursor traz as 30 anteriores, sem repetir nem perder', async () => {
      const scene = await newScene('Histórico 80');
      const all = await addMessages(scene.id, 80);

      const detail = await reads.loadDetail(scene.id);
      expect(detail.messages).toHaveLength(50);
      expect(detail.messages[0].content).toBe('m031');
      expect(detail.messages[49].content).toBe('m080');

      const older = await reads.loadMessages(scene.id, { before: detail.messages[0].id });
      expect(older.hasMore).toBe(false);
      expect(older.items.map((m) => m.content)).toEqual(all.slice(0, 30).map((m) => m.content));
      expect(older.items[0]).toEqual(expect.objectContaining({ id: all[0].id, role: 'user' }));
    });

    it('páginas menores: hasMore sobe e desce, e a união é a conversa inteira, na ordem', async () => {
      const scene = await newScene('Histórico paginado');
      await addMessages(scene.id, 25);
      const pages: string[][] = [];
      let before: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await reads.loadMessages(scene.id, { before, limit: 10 });
        pages.unshift(page.items.map((m) => m.content));
        before = page.items[0].id;
        hasMore = page.hasMore;
      }
      expect(pages.map((p) => p.length)).toEqual([5, 10, 10]);
      expect(pages.flat()).toEqual(
        Array.from({ length: 25 }, (_, i) => `m${String(i + 1).padStart(3, '0')}`),
      );
    });

    it('sem cursor, devolve as mais novas até o limite', async () => {
      const scene = await newScene('Histórico sem cursor');
      await addMessages(scene.id, 12);
      const page = await reads.loadMessages(scene.id, { limit: 5 });
      expect(page.items.map((m) => m.content)).toEqual(['m008', 'm009', 'm010', 'm011', 'm012']);
      expect(page.hasMore).toBe(true);
    });

    it('Mensagens gravadas na mesma transação: o limite cai entre duas do mesmo instante, nenhuma repete nem some, e a do usuário vem antes', async () => {
      const scene = await newScene('Histórico empate');
      const at = new Date(Date.now() - 60_000);
      const make = async (role: 'user' | 'assistant', content: string, when: Date) => {
        const message = await insertMessage(dataSource, scene.id, { role, content });
        await dataSource.query(
          `UPDATE template_scene_messages SET "createdAt" = $2 WHERE id = $1`,
          [message.id, when],
        );
        return message;
      };
      await make('user', 'antes', new Date(at.getTime() - 1000));
      await make('user', 'pergunta A', at);
      await make('assistant', 'resposta A', at);
      await make('user', 'pergunta B', new Date(at.getTime() + 1000));
      await make('assistant', 'resposta B', new Date(at.getTime() + 1000));

      const seen: string[] = [];
      let before: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await reads.loadMessages(scene.id, { before, limit: 1 });
        seen.unshift(page.items[0].content);
        before = page.items[0].id;
        hasMore = page.hasMore;
      }
      expect(seen).toEqual(['antes', 'pergunta A', 'resposta A', 'pergunta B', 'resposta B']);
      const detail = await reads.loadDetail(scene.id);
      expect(detail.messages.map((m) => m.content)).toEqual(seen);
    });

    it('Cursor inválido: mensagem de outra cena é 400, e nada vaza', async () => {
      const a = await newScene('Cursor A');
      const b = await newScene('Cursor B');
      const [foreign] = await addMessages(b.id, 1);
      await addMessages(a.id, 3);
      expect(await errorOf(reads.loadMessages(a.id, { before: foreign.id }))).toEqual({
        status: 400,
        code: 'BAD_REQUEST',
      });
      expect(
        await errorOf(reads.loadMessages(a.id, { before: '00000000-0000-4000-8000-000000000000' })),
      ).toEqual({ status: 400, code: 'BAD_REQUEST' });
    });

    it('Cena de outro id: inexistente ou excluída é 404', async () => {
      expect(await errorOf(reads.loadMessages('00000000-0000-4000-8000-000000000000', {}))).toEqual(
        {
          status: 404,
          code: 'SCENE_NOT_FOUND',
        },
      );
      const scene = await newScene('Excluída');
      await dataSource.manager.softDelete(TemplateScene, { id: scene.id });
      expect(await errorOf(reads.loadMessages(scene.id, {}))).toEqual({
        status: 404,
        code: 'SCENE_NOT_FOUND',
      });
    });
  });
});
