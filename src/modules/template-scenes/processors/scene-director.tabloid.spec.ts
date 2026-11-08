import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { MockSceneDirectorClient } from '../providers/mock-scene-director.client';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import {
  DERIVE_INNER_ANNOUNCEMENT,
  DERIVE_INNER_REPLY,
  headerLimitNote,
  INNER_EXISTS_REPLY,
  INNER_MISSING_REPLY,
  NO_HEADER_ON_INNER_REPLY,
  OUTER_FIRST_REPLY,
  HEADER_ONLY_TABLOID_REPLY,
} from '../scene-texts';
import { SceneDirectorContextService } from '../services/scene-director-context';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorImage, directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { directorAnswer } from '../testing/scene-director-harness';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('Diretor no jornal de 4 páginas (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();

  async function chat(sceneId: string, content: string, extra: Record<string, unknown> = {}) {
    const sent = await h.post(sceneId, content, extra);
    await h
      .directorProcessor(new MockSceneDirectorClient() as never)
      .process({ sceneId, versionId: sent.versionId });
    return { sent, version: await h.versionOf(sent.versionId) };
  }

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
  /** A resposta mais recente do assistente na versão (o anúncio antes da imagem, a resposta depois). */
  const assistantOf = async (versionId: string) =>
    (
      await h.dataSource.manager.findOneOrFail(TemplateSceneMessage, {
        where: { versionId, role: 'assistant' },
        order: { createdAt: 'DESC' },
      })
    ).content;
  const faceOf = (sceneId: string, index: number) =>
    h.dataSource.manager.findOneByOrFail(TemplateSceneFace, { sceneId, index });

  /** Roda o job de imagem da versão com o provedor falso e devolve o prompt enviado. */
  async function runImage(sceneId: string, versionId: string, call: 'generate' | 'edit') {
    const fake = h.fakeProvider(async () => h.okResult(0.13));
    await h.processorWith(fake.provider).process(h.job(sceneId, versionId));
    return { fake, prompt: fake[call].mock.calls[0]?.[0]?.prompt as string };
  }

  describe('Fazer a interna', () => {
    it('pelo chat: o mesmo do botão, com uma chamada de edição e a janela de 5 s', async () => {
      const { scene, outer } = await h.tabloidScene({ outer: true });

      const { sent, version } = await chat(scene.id, 'agora faz as páginas de dentro');

      expect(version).toMatchObject({
        operation: 'derive_face',
        faceIndex: 1,
        status: 'queued',
        derivedFromVersionId: outer?.id,
      });
      expect(imageJobs()).toHaveLength(1);
      expect(imageJobs()[0][2]).toMatchObject({ startAfterSeconds: 5 });
      expect(await assistantOf(sent.versionId)).toBe(DERIVE_INNER_ANNOUNCEMENT);
      const { fake, prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(fake.edit).toHaveBeenCalledTimes(1);
      expect(fake.generate).not.toHaveBeenCalled();
      expect(prompt).toContain('Do NOT draw a gutter');
      expect(prompt).not.toContain('pedido');
      expect(await assistantOf(sent.versionId)).toBe(DERIVE_INNER_REPLY);
      const ready = await h.versionOf(sent.versionId);
      expect(ready).toMatchObject({ status: 'ready', derivedFromVersionId: outer?.id });
      expect(ready.elements).toEqual([]);
    });

    it('Externa sem imagem pelo chat: responde sem chamar a imagem', async () => {
      const { scene } = await h.tabloidScene();
      const { sent, version } = await chat(scene.id, 'faz a interna');
      expect(version.status).toBe('rejected');
      expect(await assistantOf(sent.versionId)).toBe(OUTER_FIRST_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('Interna nova com a Interna pronta: resposta fixa, sem chamada', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const { sent } = await chat(scene.id, 'faz a interna de novo', { face: 'inner' });
      expect(await assistantOf(sent.versionId)).toBe(INNER_EXISTS_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('Pedido na Interna vazia: resposta fixa, e o pedido fica em aberto ligado à Interna', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const { sent } = await chat(scene.id, 'coloca balões nos cantos', { face: 'inner' });
      expect(await assistantOf(sent.versionId)).toBe(INNER_MISSING_REPLY);
      expect(imageJobs()).toHaveLength(0);
      expect((await h.sceneOf(scene.id)).brief).toEqual([
        expect.objectContaining({ status: 'open', faceKey: 'inner' }),
      ]);
    });
  });

  describe('Ajustes com as regras do jornal', () => {
    const editPlan = (
      region: { zone: 'header' | 'body' | 'footer'; side: 'left' | 'right' | null },
      change = 'Add golden confetti',
    ): PlanOverrides =>
      directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        image: directorImage({ change, region }),
      });

    it('Ajuste na Externa: região da capa em meia largura e a frase de preservação da Externa', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const { sent } = await chatWith(
        scene.id,
        'coloca confetes dourados na capa',
        editPlan({ zone: 'body', side: 'right' }),
        { face: 'outer' },
      );
      const { fake, prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(fake.edit).toHaveBeenCalledTimes(1);
      expect(prompt).toContain('front cover (right half, x > 1754 px), below the header');
      expect(prompt).toContain('This is the OUTER side of a 4-page folded flyer');
      expect(prompt).toContain('above y = 372 px');
    });

    it('Rodapé pedido na capa: o prompt limita a mudança à faixa da contracapa', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const { sent } = await chatWith(
        scene.id,
        'coloca uma faixa no rodapé da direita',
        editPlan({ zone: 'footer', side: 'right' }, 'Add a plain ribbon'),
        { face: 'outer' },
      );
      const plan = (await h.versionOf(sent.versionId)).metrics.plan as DirectorPlan;
      expect(plan.image?.region).toEqual({ zone: 'footer', side: 'left' });
      const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(prompt).toContain(
        'only inside the footer band of the back cover: x from 0 to 1574 px, y ≥ 2232 px',
      );
    });

    it('Cabeçalho pedido na Interna: executa no miolo e a frase diz que não há cabeçalho', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const { sent } = await chatWith(
        scene.id,
        'coloca um título no topo',
        editPlan({ zone: 'header', side: null }, 'Add a soft glow'),
        { face: 'inner' },
      );
      const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(prompt).toContain('only in the free product area of the spread');
      expect(prompt).toContain('it has no header and no footer');
    });

    it('Ajuste na Interna: a frase da Interna sem calha', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const { sent } = await chatWith(
        scene.id,
        'deixa o fundo mais claro',
        directorPlan({
          turn_kind: 'pedido_ajuste_geral',
          will_change_image: true,
          what_to_change: 'Make the background lighter',
        }),
        { face: 'inner' },
      );
      const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(prompt).toContain('This is the INNER spread of a 4-page folded flyer');
      expect(prompt).toContain('Do NOT draw a gutter, book-spine shadow');
      expect(prompt).toContain('Do not add any text, letters, numbers or logos.');
    });

    it('Texto pedido na Interna: entra pelo texto exato e a parte "sem texto" sai', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const { sent } = await chatWith(
        scene.id,
        'escreve "OFERTAS DA SEMANA" no alto da página 3',
        directorPlan({
          turn_kind: 'pedido_item',
          will_change_image: true,
          what_to_change: 'Add the requested title',
          exact_text: ['OFERTAS DA SEMANA'],
        }),
        { face: 'inner' },
      );
      const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(prompt).toContain('OFERTAS DA SEMANA');
      expect(prompt).not.toContain('Do not add any text, letters');
    });
  });

  describe('Primeira imagem da Externa', () => {
    it('usa o prompt do jornal em 3328x2480 e a Interna continua vazia', async () => {
      const { scene } = await h.tabloidScene();
      const { sent } = await chat(scene.id, 'jornal de aniversário, festivo', { face: 'outer' });
      const { fake, prompt } = await runImage(scene.id, sent.versionId, 'generate');
      expect(fake.generate.mock.calls[0][0].size).toBe('3328x2480');
      expect(prompt).toContain('the OUTER side of a 4-page supermarket newspaper flyer');
      expect(prompt).toContain('y from 0 to 372 px');
      expect((await h.versionOf(sent.versionId)).status).toBe('ready');
      expect((await faceOf(scene.id, 1)).currentVersionId).toBeNull();
    });
  });

  describe('Altura do cabeçalho pela conversa', () => {
    it('Cabeçalho maior: edição com o cabeçalho até y 496, zonas na versão e na face quando pronta', async () => {
      const { scene } = await h.tabloidScene({ outer: true });

      const { sent, version } = await chat(scene.id, 'deixa o cabeçalho maior', { face: 'outer' });

      expect(version).toMatchObject({ operation: 'redraw', status: 'queued' });
      expect(version.zones?.header.h).toBeCloseTo(0.2, 10);
      expect(await assistantOf(sent.versionId)).toContain(
        'Vou deixar o cabeçalho da capa com 8 cm.',
      );
      // a face só adota a altura quando a versão fica pronta
      expect((await faceOf(scene.id, 0)).zones.header.h).toBeCloseTo(0.15, 10);
      const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
      expect(prompt).toContain(
        'Resize the cover header so that it ends at y = 496 px (it now ends at y = 372 px)',
      );
      expect(prompt).toContain('y < 496 px');
      expect(prompt).toContain('above y = 496 px');
      expect(await assistantOf(sent.versionId)).toContain(
        'Pronto, o cabeçalho da capa está com 8 cm.',
      );
      expect((await faceOf(scene.id, 0)).zones.header.h).toBeCloseTo(0.2, 10);
    });

    it('Tamanho dito pelo cliente na primeira mensagem: uma só geração, com o cabeçalho de 0 a 620', async () => {
      const { scene } = await h.tabloidScene();
      const { sent, version } = await chat(
        scene.id,
        'jornal de aniversário com cabeçalho de 10 cm',
        {
          face: 'outer',
        },
      );
      expect(version.zones?.header.h).toBeCloseTo(0.25, 10);
      const { fake, prompt } = await runImage(scene.id, sent.versionId, 'generate');
      expect(fake.generate).toHaveBeenCalledTimes(1);
      expect(prompt).toContain('y from 0 to 620 px');
      expect((await faceOf(scene.id, 0)).zones.header.h).toBeCloseTo(0.25, 10);
    });

    it('Acima do teto: vai a 12 cm e o anúncio diz o máximo', async () => {
      const { scene } = await h.tabloidScene({ outer: true, headerCm: 10 });
      const { sent, version } = await chat(scene.id, 'cabeçalho com 15 cm', { face: 'outer' });
      expect(version.zones?.header.h).toBeCloseTo(0.3, 10);
      expect(await assistantOf(sent.versionId)).toContain('o máximo é 12 cm');
    });

    it('Já no limite: nenhuma chamada de imagem e a resposta fixa', async () => {
      const { scene } = await h.tabloidScene({ outer: true, headerCm: 12 });
      const { sent, version } = await chat(scene.id, 'cabeçalho maior', { face: 'outer' });
      expect(version.status).toBe('rejected');
      expect(await assistantOf(sent.versionId)).toBe('O cabeçalho já está no máximo, 12 cm.');
      expect(imageJobs()).toHaveLength(0);
    });

    it('Cabeçalho pedido na Interna: resposta fixa, sem chamada', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const { sent } = await chat(scene.id, 'cabeçalho maior', { face: 'inner' });
      expect(await assistantOf(sent.versionId)).toBe(NO_HEADER_ON_INNER_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('Outras cenas sem mudança: o tamanho do cabeçalho só vale no jornal', async () => {
      const { scene } = await h.readyScene();
      const { sent } = await chatWith(
        scene.id,
        'cabeçalho maior',
        directorPlan({
          turn_kind: 'tamanho_cabecalho',
          header_size: { cm: null, direction: 'maior' },
        }),
      );
      expect(await assistantOf(sent.versionId)).toBe(HEADER_ONLY_TABLOID_REPLY);
      expect(imageJobs()).toHaveLength(0);
    });

    it('o limite aplicado na imagem nova tem a nota do limite', () => {
      expect(headerLimitNote(12, 'max')).toBe(
        'O cabeçalho da capa vai ficar com 12 cm (o máximo é 12 cm).',
      );
    });
  });

  describe('O que o Diretor recebe no jornal', () => {
    it('o bloco do jornal, as zonas em meia largura e o rótulo das faces', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const sent = await h.post(scene.id, 'mais cor', { face: 'outer' });
      const context = await new SceneDirectorContextService(h.dataSource, h.files).build(
        await h.sceneOf(scene.id),
        await h.versionOf(sent.versionId),
      );
      expect(context.text).toContain('Jornal de 4 páginas, folha deitada dobrada no meio.');
      expect(context.text).toContain('Face deste pedido: Externa (com imagem)');
      expect(context.text).toContain(
        'A capa não tem rodapé; a faixa do rodapé fica na contracapa.',
      );
      expect(context.text).toContain('Altura atual do cabeçalho da capa: 6 cm (de 3 a 12 cm).');
      expect(context.text).toContain(
        'cabeçalho da capa, só na metade direita (x ≥ 1780 px, 6 cm, y < 372 px)',
      );
      expect(context.text).toContain('Faixa da dobra (x de 1574 a 1754 px)');
      expect(context.text).toContain('Versões da Externa (número exibido):');
      expect(context.face).toMatchObject({ layout: 'tabloid', key: 'outer', hasImage: true });
    });
  });
});
