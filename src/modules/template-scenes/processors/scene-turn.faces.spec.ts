import * as sharp from 'sharp';
import { directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { directorAnswer } from '../testing/scene-director-harness';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf, fakeQueue, textElement } from '../testing/scene-test-helpers';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneLogoService } from '../services/scene-logo.service';
import { SceneReadService } from '../services/scene-read.service';
import { SceneVersionsService } from '../services/scene-versions.service';
import { versionMissingReply } from '../scene-texts';

const itemPlan = (change: string, zone: 'footer' | 'whole' = 'whole'): PlanOverrides => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: `Vou colocar ${change} na imagem.`,
  what_to_change: change,
  requests: [],
  ...(zone === 'whole'
    ? {}
    : {
        image: {
          composition: '',
          style: '',
          change,
          region: { zone, side: null },
          preserve: [],
          exact_text: [],
        },
      }),
});

describeIfSceneDb('Pedido por face: Frente e Verso (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();

  const versionsService = () =>
    new SceneVersionsService(
      h.dataSource,
      new SceneLockService(h.dataSource),
      new SceneReadService(h.dataSource),
      fakeQueue().service,
    );
  const faceRows = async (sceneId: string) =>
    h.dataSource.manager.find(TemplateSceneFace, { where: { sceneId }, order: { index: 'ASC' } });

  /** POST real na face e o Diretor com o plano dado (cliente controlado). */
  async function ask(
    sceneId: string,
    content: string,
    plan: PlanOverrides,
    extra: Record<string, unknown> = {},
  ) {
    const sent = await h.post(sceneId, content, extra);
    const { client } = h.directorClient(async () => directorAnswer(plan));
    await h.directorProcessor(client).process({ sceneId, versionId: sent.versionId });
    return { sent, version: await h.versionOf(sent.versionId) };
  }

  /** O job de imagem do turno com o provedor controlado; devolve o provedor para ver o que ele recebeu. */
  async function runImage(sceneId: string, versionId: string) {
    const fake = h.fakeProvider(async () => h.okResult(0.13));
    await h.processorWith(fake.provider).process({ sceneId, versionId });
    return fake;
  }

  describe('Pedido na aba Verso', () => {
    it('a versão e a mensagem são do verso, a edição parte do verso e a frente não muda', async () => {
      const { scene, front, back } = await h.frontBackScene({ front: true, back: true });

      const { sent, version } = await ask(
        scene.id,
        'coloca bandeirinhas discretas no topo',
        itemPlan('discreet bunting at the top'),
        { face: 'back' },
      );

      expect(version).toMatchObject({
        faceIndex: 1,
        parentVersionId: back?.id,
        operation: 'redraw',
        status: 'queued',
      });
      const messages = await h.messagesOf(scene.id);
      expect(
        messages.filter((m) => m.versionId === sent.versionId).map((m) => m.faceIndex),
      ).toEqual([1, 1]);

      const fake = await runImage(scene.id, sent.versionId);

      const done = await h.versionOf(sent.versionId);
      expect(done).toMatchObject({ status: 'ready', faceIndex: 1 });
      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.currentVersionId).toBe(front?.id);
      expect(backFace.currentVersionId).toBe(sent.versionId);
      // a frente não foi enviada ao modelo: só a master do verso
      const backMaster = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: back?.masterAssetId as string,
      });
      expect(fake.edit).toHaveBeenCalledTimes(1);
      expect(
        (fake.edit.mock.calls[0][0].image as Buffer).equals(await h.files.read(backMaster.url)),
      ).toBe(true);
    });

    it('Versão nova no verso não muda o espelho: currentVersionId da cena continua o da Frente', async () => {
      const { scene, front } = await h.frontBackScene({ front: true, back: true });
      const { sent } = await ask(scene.id, 'mais calor no fundo', itemPlan('warmer background'), {
        face: 'back',
      });

      await runImage(scene.id, sent.versionId);

      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(front?.id);
    });

    it('Frase de preservação no verso: o prompt leva a frase e a imagem do verso', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });
      const { sent } = await ask(scene.id, 'deixa o fundo mais quente', itemPlan('warmer tones'), {
        face: 'back',
      });

      const fake = await runImage(scene.id, sent.versionId);

      const prompt = fake.edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(
        'This is the BACK side of the sheet: it has no header and no title.',
      );
      expect(prompt).toContain('Keep the top 2 cm (y from 0 to about');
      expect(prompt).toContain('Do not add any text, letters, numbers or logos.');
    });

    it('com texto pedido pelo cliente, a frase do verso não proíbe texto', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });
      const { sent } = await ask(
        scene.id,
        'escreve "Ofertas" no verso',
        {
          ...itemPlan('a sign'),
          reply: 'Vou colocar uma placa com a frase “Ofertas” na imagem.',
          image: {
            composition: '',
            style: '',
            change: 'a wooden sign with the requested text',
            region: { zone: 'whole', side: null },
            preserve: [],
            exact_text: ['Ofertas'],
          },
        },
        { face: 'back' },
      );

      const fake = await runImage(scene.id, sent.versionId);

      const prompt = fake.edit.mock.calls[0][0].prompt;
      expect(prompt).toContain('This is the BACK side of the sheet');
      expect(prompt).not.toContain('Do not add any text, letters, numbers or logos.');
    });
  });

  describe('Pedido na aba Frente', () => {
    it('a versão é da frente, o verso não muda e a frente não leva a frase do verso', async () => {
      const { scene, back } = await h.frontBackScene({ front: true, back: true });

      const { sent } = await ask(scene.id, 'troca a mesa por ardósia', itemPlan('a slate table'));
      const fake = await runImage(scene.id, sent.versionId);

      const done = await h.versionOf(sent.versionId);
      expect(done).toMatchObject({ faceIndex: 0, status: 'ready' });
      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.currentVersionId).toBe(sent.versionId);
      expect(backFace.currentVersionId).toBe(back?.id);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(sent.versionId);
      expect(fake.edit.mock.calls[0][0].prompt).not.toContain('BACK side');
    });

    it('Rodapé pedido na frente: o código executa no miolo e nenhuma faixa de rodapé é pedida', async () => {
      const { scene } = await h.frontBackScene({ front: true });

      const { sent, version } = await ask(
        scene.id,
        'coloca uma placa no rodapé',
        itemPlan('a wooden sign resting at the bottom', 'footer'),
      );

      expect(
        (version.metrics.plan as { image: { region: { zone: string } } }).image.region.zone,
      ).toBe('body');
      const fake = await runImage(scene.id, sent.versionId);
      const prompt = fake.edit.mock.calls[0][0].prompt;
      expect(prompt).toContain('central product area');
      expect(prompt).not.toContain('footer band');
      expect(prompt).toContain('between y = 87 px and y = 584 px of 584 px');
    });
  });

  describe('Face que a cena não tem', () => {
    it('cena de uma face com face back: 422 FACE_NOT_FOUND e nada é gravado', async () => {
      const { scene } = await h.readyScene();
      const before = await h.messagesOf(scene.id);

      const result = await errorOf(h.post(scene.id, 'oi', { face: 'back' }));

      expect(result).toEqual({ status: 422, code: 'FACE_NOT_FOUND' });
      expect(await h.messagesOf(scene.id)).toHaveLength(before.length);
      const count = await h.dataSource.manager.countBy(TemplateSceneVersion, { sceneId: scene.id });
      expect(count).toBe(1);
    });

    it('a face única aceita `front` (a tela manda a Frente por padrão)', async () => {
      const { scene } = await h.readyScene();
      const sent = await h.post(scene.id, 'mais verde', { face: 'front' });
      expect((await h.versionOf(sent.versionId)).faceIndex).toBe(0);
    });
  });

  describe('Camada no verso', () => {
    it('o ajuste de camadas com face back cria a versão manual do verso, e a frente continua igual', async () => {
      const { scene, front, back } = await h.frontBackScene({ front: true, back: true });
      const stored = await h.sceneOf(scene.id);

      await versionsService().patchElements(
        scene.id,
        { expectedRevision: stored.revision, elements: [textElement('t1')], face: 'back' },
        null,
      );

      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.currentVersionId).toBe(front?.id);
      const manual = await h.versionOf(backFace.currentVersionId as string);
      expect(manual).toMatchObject({
        faceIndex: 1,
        operation: 'manual',
        isOpenManual: true,
        parentVersionId: back?.id,
        masterAssetId: back?.masterAssetId,
      });
      expect(manual.elements.map((e) => e.id)).toEqual(['t1']);
      expect((await h.versionOf(front?.id as string)).elements).toEqual([]);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(front?.id);
    });

    it('a manual aberta é por face: um pedido na frente não fecha a do verso (PV-5)', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });
      const stored = await h.sceneOf(scene.id);
      await versionsService().patchElements(
        scene.id,
        { expectedRevision: stored.revision, elements: [textElement('t1')], face: 'back' },
        null,
      );

      await h.post(scene.id, 'mais verde na frente', { face: 'front' });

      const open = await h.dataSource.manager.findBy(TemplateSceneVersion, {
        sceneId: scene.id,
        isOpenManual: true,
      });
      expect(open.map((v) => v.faceIndex)).toEqual([1]);

      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { sceneId: scene.id, status: 'queued' },
        { status: 'rejected' },
      );
      await h.post(scene.id, 'mais verde no verso', { face: 'back' });
      expect(
        await h.dataSource.manager.countBy(TemplateSceneVersion, {
          sceneId: scene.id,
          isOpenManual: true,
        }),
      ).toBe(0);
    });

    it('a logo enviada na aba Verso fica ligada à versão mais recente do verso', async () => {
      const { scene, back } = await h.frontBackScene({ front: true, back: true });
      const png = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#c33' },
      })
        .png()
        .toBuffer();
      const logos = new SceneLogoService(h.dataSource, h.files);

      const uploaded = await logos.upload(
        scene.id,
        { buffer: png, mimetype: 'image/png', size: png.length },
        'back',
      );

      const asset = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: uploaded.assetId,
      });
      expect(asset.versionId).toBe(back?.id);
      const bad = await errorOf(
        logos.upload(scene.id, { buffer: png, mimetype: 'image/png', size: png.length }, 'lateral'),
      );
      expect(bad).toEqual({ status: 400, code: 'BAD_REQUEST' });
    });

    it('logo na face sem versão: 422 NO_CURRENT_VERSION (o verso ainda não existe)', async () => {
      const { scene } = await h.frontBackScene({ front: true });
      const png = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#c33' },
      })
        .png()
        .toBuffer();
      const logos = new SceneLogoService(h.dataSource, h.files);

      const result = await errorOf(
        logos.upload(scene.id, { buffer: png, mimetype: 'image/png', size: png.length }, 'back'),
      );

      expect(result).toEqual({ status: 422, code: 'NO_CURRENT_VERSION' });
    });
  });

  describe('Revisão compartilhada', () => {
    it('o ajuste de camada na frente e a mensagem no verso com a revisão antiga: 409 REVISION_CONFLICT', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });
      const seen = (await h.sceneOf(scene.id)).revision;
      await versionsService().patchElements(
        scene.id,
        { expectedRevision: seen, elements: [textElement('t1')], face: 'front' },
        null,
      );

      const result = await errorOf(
        h
          .turns()
          .sendMessage(
            scene.id,
            { content: 'bandeirinhas', expectedRevision: seen, face: 'back' } as never,
            null,
          ),
      );

      expect(result).toEqual({ status: 409, code: 'REVISION_CONFLICT' });
    });

    it('a trava é da cena: com a frente em curso, a mensagem no verso é 409 SCENE_BUSY', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });
      await h.post(scene.id, 'mais verde', { face: 'front' });

      const result = await errorOf(h.post(scene.id, 'bandeirinhas', { face: 'back' }));

      expect(result).toEqual({ status: 409, code: 'SCENE_BUSY' });
    });
  });

  describe('Versões, voltar e restaurar por face', () => {
    async function twoBackVersionsAndNewerFront() {
      const { scene, front, back } = await h.frontBackScene({ front: true, back: true });
      const back2 = await h.readyOnFace(scene, {
        index: 1,
        number: 3,
        parentVersionId: back?.id,
      });
      const front2 = await h.readyOnFace(scene, {
        index: 0,
        number: 4,
        parentVersionId: front?.id,
      });
      return { scene, front, front2, back, back2 };
    }

    it('Voltar no verso: surge uma versão do verso com a imagem da versão 1 dele, a frente fica e nada é pago', async () => {
      const { scene, front2, back } = await twoBackVersionsAndNewerFront();

      const { version } = await ask(
        scene.id,
        'volta como estava antes',
        directorPlan({ turn_kind: 'desfazer', reply: 'Vou voltar.', undo_target: 'previous' }),
        { face: 'back' },
      );

      expect(version).toMatchObject({
        faceIndex: 1,
        operation: 'restore',
        status: 'ready',
        parentVersionId: back?.id,
        masterAssetId: back?.masterAssetId,
      });
      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.currentVersionId).toBe(front2.id);
      expect(backFace.currentVersionId).toBe(version.id);
      const messages = await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { versionId: version.id, role: 'assistant' },
      });
      expect(messages[0].content).toBe('Voltei para a imagem da versão 1. Ela agora é a versão 3.');
      expect(messages[0].faceIndex).toBe(1);
    });

    it('Versão citada que só existe na outra face: o chat cita as disponíveis do verso e nada é criado', async () => {
      const { scene, front } = await h.frontBackScene({ front: true, back: true });
      let parent = front?.id;
      for (let number = 3; number <= 7; number++) {
        parent = (await h.readyOnFace(scene, { index: 0, number, parentVersionId: parent })).id;
      }
      await h.readyOnFace(scene, { index: 1, number: 8, parentVersionId: null });
      const before = await h.dataSource.manager.countBy(TemplateSceneVersion, {
        sceneId: scene.id,
        status: 'ready',
      });

      const { version } = await ask(
        scene.id,
        'volta para a versão 4',
        directorPlan({ turn_kind: 'desfazer', reply: 'Vou voltar.', undo_target: 4 }),
        { face: 'back' },
      );

      expect(version.status).toBe('rejected');
      const reply = (
        await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
          versionId: version.id,
          role: 'assistant',
        })
      ).content;
      expect(reply).toBe(versionMissingReply(4, [1, 2]));
      expect(
        await h.dataSource.manager.countBy(TemplateSceneVersion, {
          sceneId: scene.id,
          status: 'ready',
        }),
      ).toBe(before);
    });

    it('Restaurar pela API: a versão nova é do verso e a frente e o espelho não mudam', async () => {
      const { scene, front2, back } = await twoBackVersionsAndNewerFront();

      await versionsService().restore(scene.id, back?.id as string, null);

      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.currentVersionId).toBe(front2.id);
      const restored = await h.versionOf(backFace.currentVersionId as string);
      expect(restored).toMatchObject({
        faceIndex: 1,
        operation: 'restore',
        parentVersionId: back?.id,
      });
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(front2.id);
    });
  });

  describe('A cena de uma face segue como antes', () => {
    it('mensagem sem face: versão e mensagem na face 0, e o espelho acompanha a versão nova', async () => {
      const { scene } = await h.readyScene();
      const { sent } = await ask(scene.id, 'mais flores', itemPlan('more flowers'));
      await runImage(scene.id, sent.versionId);

      const [face] = await faceRows(scene.id);
      expect(face.currentVersionId).toBe(sent.versionId);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(sent.versionId);
      expect((await h.versionOf(sent.versionId)).faceIndex).toBe(0);
    });
  });
});
