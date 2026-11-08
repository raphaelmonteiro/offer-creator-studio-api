import { createHash } from 'crypto';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { directorInstructions, DIRECTOR_INSTRUCTIONS } from '../domain/scene-director-prompt';
import { buildBackPrompt, faceZones } from '../domain/scene-faces';
import { findSceneFormat, SceneFormatSpec } from '../domain/scene-formats';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { MockSceneDirectorClient } from '../providers/mock-scene-director.client';
import {
  BACK_EXISTS_REPLY,
  BACK_MISSING_REPLY,
  DERIVE_BACK_ANNOUNCEMENT,
  FRONT_FIRST_REPLY,
  SINGLE_FACE_REPLY,
} from '../scene-texts';
import { SceneDirectorContextService } from '../services/scene-director-context';
import { directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { directorAnswer } from '../testing/scene-director-harness';
import { FB_HEIGHT, FB_WIDTH, useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('Diretor: fazer o verso e a face do pedido (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();

  /** POST real e o Diretor de desenvolvimento (por roteiro) lendo a mensagem. */
  async function chat(sceneId: string, content: string, extra: Record<string, unknown> = {}) {
    const sent = await h.post(sceneId, content, extra);
    await h
      .directorProcessor(new MockSceneDirectorClient() as never)
      .process({ sceneId, versionId: sent.versionId });
    return { sent, version: await h.versionOf(sent.versionId) };
  }

  /** O mesmo, com o plano que o teste manda (o Diretor devolve exatamente este plano). */
  async function chatWith(
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

  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
  const assistantOf = async (versionId: string) =>
    h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, { versionId, role: 'assistant' });
  const briefOf = async (sceneId: string) => (await h.sceneOf(sceneId)).brief;

  describe('Fazer o verso pelo chat', () => {
    it('"agora faz o verso" faz o mesmo que o botão, com uma só chamada de imagem', async () => {
      const { scene, front } = await h.frontBackScene({ front: true });

      const { sent, version } = await chat(scene.id, 'agora faz o verso');

      expect(version).toMatchObject({
        operation: 'derive_face',
        faceIndex: 1,
        status: 'queued',
        step: null,
        parentVersionId: null,
        derivedFromVersionId: front?.id,
      });
      expect(imageJobs()).toHaveLength(1);
      expect(imageJobs()[0][1]).toMatchObject({ sceneId: scene.id, versionId: sent.versionId });
      // a janela de 5 s vale pelo chat (o botão não tem janela)
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });
      expect(version.metrics.windowEndsAt).toEqual(expect.any(String));
      expect((await assistantOf(sent.versionId)).content).toBe(DERIVE_BACK_ANNOUNCEMENT);
      const userMessage = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
        versionId: sent.versionId,
        role: 'user',
      });
      expect(userMessage.faceIndex).toBe(1);

      const fake = h.fakeProvider(async () => h.okResult(0.13));
      await h.processorWith(fake.provider).process(h.job(scene.id, sent.versionId));
      expect(fake.edit).toHaveBeenCalledTimes(1);
      expect(fake.generate).not.toHaveBeenCalled();
      expect((await h.versionOf(sent.versionId)).status).toBe('ready');
    });

    it('Mensagem com pedido extra: deriva só com o prompt fixo e deixa o pedido em aberto, ligado ao verso', async () => {
      const { scene } = await h.frontBackScene({ front: true });

      const { sent } = await chat(scene.id, 'faz o verso com bandeirinhas no topo');

      const brief = await briefOf(scene.id);
      expect(brief).toEqual([
        expect.objectContaining({ text: 'bandeirinhas no topo', status: 'open', faceKey: 'back' }),
      ]);
      const fake = h.fakeProvider(async () => h.okResult(0.13));
      await h.processorWith(fake.provider).process(h.job(scene.id, sent.versionId));
      const format = findSceneFormat('folheto-27x40') as SceneFormatSpec;
      const prompt = fake.edit.mock.calls[0][0].prompt;
      expect(prompt).toBe(
        buildBackPrompt({
          format,
          widthPx: FB_WIDTH,
          heightPx: FB_HEIGHT,
          zones: faceZones(format, 'back'),
        }),
      );
      expect(prompt).not.toContain('bandeirinhas');
      // a derivação não supera o pedido em aberto do verso
      expect((await briefOf(scene.id))[0].status).toBe('open');
    });

    it('Frente sem imagem pelo chat: responde sem chamar a imagem', async () => {
      const { scene } = await h.frontBackScene();

      const { sent, version } = await chat(scene.id, 'faz o verso');

      expect(version).toMatchObject({ status: 'rejected', faceIndex: 0 });
      expect((await assistantOf(sent.versionId)).content).toBe(FRONT_FIRST_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('Cena de uma face: o plano fazer_verso vira "uma face só", sem chamar a imagem', async () => {
      const { scene } = await h.readyScene();

      const { sent, version } = await chatWith(
        scene.id,
        'faz o verso',
        directorPlan({ turn_kind: 'fazer_verso', reply: 'Vou fazer o verso.' }),
      );

      expect(version.status).toBe('rejected');
      expect((await assistantOf(sent.versionId)).content).toBe(SINGLE_FACE_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });
  });

  describe('Aba Verso vazia', () => {
    it('outro pedido: nenhuma chamada de imagem, a resposta pede o verso e o pedido fica em aberto no brief', async () => {
      const { scene } = await h.frontBackScene({ front: true });

      const { sent, version } = await chat(scene.id, 'coloca um sol no canto', { face: 'back' });

      expect(version).toMatchObject({ status: 'rejected', faceIndex: 1 });
      expect((await assistantOf(sent.versionId)).content).toBe(BACK_MISSING_REPLY);
      expect(imageJobs()).toHaveLength(0);
      expect(await briefOf(scene.id)).toEqual([
        expect.objectContaining({
          text: 'coloca um sol no canto',
          status: 'open',
          faceKey: 'back',
        }),
      ]);
    });

    it('camada, voltar e imagem nova na aba vazia têm a mesma resposta', async () => {
      const { scene } = await h.frontBackScene({ front: true });
      const first = await chatWith(
        scene.id,
        'volta como estava',
        directorPlan({ turn_kind: 'desfazer', reply: 'Vou voltar.', undo_target: 'previous' }),
        { face: 'back' },
      );
      expect((await assistantOf(first.sent.versionId)).content).toBe(BACK_MISSING_REPLY);
      const second = await chatWith(
        scene.id,
        'gera outra imagem',
        directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          reply: 'Vou criar outra imagem.',
          what_to_put: 'a new picture',
        }),
        { face: 'back' },
      );
      expect((await assistantOf(second.sent.versionId)).content).toBe(BACK_MISSING_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('pergunta na aba vazia segue como em qualquer cena (sem imagem não vira erro)', async () => {
      const { scene } = await h.frontBackScene({ front: true });

      const { version } = await chatWith(
        scene.id,
        'o que dá para fazer aqui?',
        directorPlan({ turn_kind: 'pergunta', reply: 'Dá para fazer o verso.' }),
        { face: 'back' },
      );

      expect(version.status).toBe('rejected');
      expect(imageJobs()).toHaveLength(0);
    });
  });

  describe('Pedido de verso novo com o verso pronto', () => {
    it('"faz o verso de novo": responde sem chamada paga', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });

      const { sent, version } = await chat(scene.id, 'faz o verso de novo', { face: 'back' });

      expect(version.status).toBe('rejected');
      expect((await assistantOf(sent.versionId)).content).toBe(BACK_EXISTS_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('imagem totalmente nova na aba Verso: a mesma resposta', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });

      const { sent } = await chatWith(
        scene.id,
        'quero uma imagem totalmente nova',
        directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          reply: 'Vou criar uma imagem nova.',
          what_to_put: 'a brand new picture',
        }),
        { face: 'back' },
      );

      expect((await assistantOf(sent.versionId)).content).toBe(BACK_EXISTS_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('na aba Frente, "imagem nova" segue como sempre: gera a imagem nova da frente', async () => {
      const { scene } = await h.frontBackScene({ front: true, back: true });

      const { version } = await chatWith(
        scene.id,
        'gera outra imagem',
        directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          reply: 'Vou criar outra imagem.',
          what_to_put: 'a new picture',
        }),
      );

      expect(version).toMatchObject({ operation: 'generate', faceIndex: 0, status: 'queued' });
      expect(imageJobs()).toHaveLength(1);
    });
  });

  describe('O que o Diretor recebe', () => {
    const contextOf = async (sceneId: string, versionId: string) => {
      const scene = await h.sceneOf(sceneId);
      const version = await h.versionOf(versionId);
      return new SceneDirectorContextService(h.dataSource, h.files).build(scene, version);
    };

    it('cena de uma face: o prompt é byte a byte o de antes e o contexto não tem bloco de faces', async () => {
      expect(createHash('sha1').update(DIRECTOR_INSTRUCTIONS).digest('hex')).toBe(
        '2ef2c77bd1dde4c0d36eff5a27059762a851b2d2',
      );
      expect(directorInstructions('single')).toBe(DIRECTOR_INSTRUCTIONS);
      const { scene } = await h.readyScene();
      const sent = await h.post(scene.id, 'mais flores');

      const context = await contextOf(scene.id, sent.versionId);

      expect(context.text).not.toContain('frente e verso');
      expect(context.text).not.toContain('[Frente]');
      expect(context.text).toContain('Versões da cena (número exibido):');
      expect(context.text).toContain(
        'Zonas de image.region: header = 6 cm (11.1% da altura, y < 227 px); body = miolo de produtos (y de 227 a 1897 px); footer = 4 cm de 54 cm (7.4% da altura, y ≥ 1897 px).',
      );
    });

    it('frente e verso: o prompt ganha a classe fazer_verso e o contexto o bloco de faces e as zonas da face', async () => {
      expect(directorInstructions('front_back')).toContain('fazer_verso:');
      expect(directorInstructions('front_back')).toContain('Classes de turn_kind (13)');
      const { scene } = await h.frontBackScene({ front: true, back: true });
      const first = await chat(scene.id, 'mais verde na frente', { face: 'front' });
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: first.sent.versionId },
        { status: 'cancelled' },
      );
      const sent = await h.post(scene.id, 'coloca bandeirinhas', { face: 'back' });

      const context = await contextOf(scene.id, sent.versionId);

      expect(context.text).toContain(
        'Cena de frente e verso. Face deste pedido: Verso (com imagem). A frente tem cabeçalho e não tem rodapé; o verso não tem cabeçalho e tem rodapé. Use turn_kind fazer_verso só quando o cliente pedir para fazer ou criar o verso.',
      );
      expect(context.text).toContain('Versões do Verso (número exibido):');
      expect(context.text).toMatch(
        /Zonas de image\.region: body = miolo de produtos \(y de 0 a \d+ px\); footer = /,
      );
      expect(context.text).not.toContain('header =');
      expect(context.text).toContain('Cliente [Frente');
      expect(context.face).toMatchObject({
        key: 'back',
        hasImage: true,
        frontReady: true,
        backReady: true,
      });
    });

    it('a frente não tem a linha do rodapé nas zonas, e o plano recebe o miolo no lugar', async () => {
      const { scene } = await h.frontBackScene({ front: true });
      const sent = await h.post(scene.id, 'oi', { face: 'front' });

      const context = await contextOf(scene.id, sent.versionId);

      expect(context.text).toMatch(
        /Zonas de image\.region: header = 6 cm \(.*\); body = miolo de produtos \(y de 87 a 584 px\)\./,
      );
      expect(context.text).not.toContain('footer =');
    });
  });
});
