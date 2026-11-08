import { PlanOverrides } from '../testing/scene-director-fixtures';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { DirectorPlan } from '../domain/scene-director-schema';
import { planRequest } from './scene-prompt';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';

const YEAR_MESSAGE =
  'me gere um template de pascoa para 2027 com ovos de pascoa e um coelho em um cenario bonito';
const WITH_YEAR =
  'ovos de Páscoa e um coelho, com referências visuais à Páscoa e indicação do ano 2027';
const WITHOUT_YEAR = 'ovos de Páscoa e um coelho, com referências visuais à Páscoa';

const open = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });

describeIfSceneDb(
  'Ano, data e número escrito não vão ao modelo de imagem (banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();
    const imageJobs = () =>
      h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
    const planOf = (version: TemplateSceneVersion) => version.metrics.plan as DirectorPlan;
    const lastReply = async (sceneId: string) => {
      const messages = await h.messagesOf(sceneId);
      return messages.filter((m) => m.role === 'assistant').pop()?.content;
    };
    const imagem = (what_to_put: string, extra: PlanOverrides = {}) => ({
      turn_kind: 'imagem_nova' as const,
      will_change_image: true,
      reply: 'Vou criar a imagem.',
      what_to_put,
      ...extra,
    });
    const item = (what_to_change: string, extra: PlanOverrides = {}) => ({
      turn_kind: 'pedido_item' as const,
      will_change_image: true,
      reply: 'Vou fazer a mudança.',
      what_to_change,
      ...extra,
    });

    it('Ano como contexto: o plano sem o ano segue sem refazer, e o pedido com o ano não abre item', async () => {
      const { scene, version, plan } = await h.runTurn(
        YEAR_MESSAGE,
        imagem(WITHOUT_YEAR, { requests: [open('template de pascoa para 2027')] }),
        { noImage: true },
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version).toMatchObject({ status: 'queued', step: null });
      expect(planRequest(planOf(version))).not.toContain('2027');
      expect((await h.sceneOf(scene.id)).brief).toEqual([]);
      expect(imageJobs()).toHaveLength(1);
    });

    it('Modelo erra e o código refaz: o segundo plano segue inteiro, e o custo das duas chamadas fica registrado', async () => {
      const { version, plan } = await h.runTurn(
        YEAR_MESSAGE,
        async (_call, attempt) => directorAnswer(imagem(attempt === 1 ? WITH_YEAR : WITHOUT_YEAR)),
        { noImage: true },
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(plan.mock.calls[1][0].text).toContain('A resposta anterior foi recusada');
      const director = version.metrics.director as {
        calls: Array<{ problem?: string; status: string }>;
      };
      expect(director.calls).toMatchObject([
        { problem: 'number', status: 'failed' },
        { status: 'done' },
      ]);
      expect(planOf(version).image?.change).toBe(WITHOUT_YEAR);
      expect(version.metrics.planPatched).toBeUndefined();
      expect(imageJobs()).toHaveLength(1);
    });

    it('Modelo insiste e o código corta só o trecho: o restante do plano fica intacto e o corte é gravado', async () => {
      const { version, plan } = await h.runTurn(YEAR_MESSAGE, imagem(WITH_YEAR), { noImage: true });
      expect(plan).toHaveBeenCalledTimes(2);
      expect(planOf(version).image?.change).toBe(WITHOUT_YEAR);
      expect(planRequest(planOf(version))).not.toContain('2027');
      expect(version.metrics).toMatchObject({
        planPatched: true,
        numberPatches: [{ field: 'change', before: WITH_YEAR, after: WITHOUT_YEAR }],
      });
      expect(imageJobs()).toHaveLength(1);
    });

    it('Pedido de escrever o ano: o número vai literal em exact_text e é pintado, sem refazer', async () => {
      const { version, plan } = await h.runTurn('coloca 2027 em cima', {
        turn_kind: 'pedido_item',
        will_change_image: true,
        reply: 'Vou colocar o ano 2027 no alto.',
        what_to_change: 'Add the number at the top',
        exact_text: ['2027'],
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
      expect(planOf(version).image?.exact_text).toEqual(['2027']);
      expect(imageJobs()).toHaveLength(1);
    });

    it('Data: "ovos e a data 12/04" nas duas chamadas vira só "ovos"', async () => {
      const { version } = await h.runTurn(
        'coloca ovos para a pascoa 12/04',
        item('', {
          what_to_put: 'ovos e a data 12/04',
        }),
      );
      expect(planOf(version).image?.change).toBe('ovos');
      expect(planRequest(planOf(version))).not.toContain('12/04');
    });

    it('Quantidade e tema não são barrados: o plano segue sem refazer, com os 3 coelhos e o tema', async () => {
      const { version, plan } = await h.runTurn(
        'coloca 3 coelhos com tema de ano novo',
        item('', { what_to_put: '3 coelhos com tema de ano novo' }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(planRequest(planOf(version))).toContain('3 coelhos com tema de ano novo');
      expect(version.metrics.planPatched).toBeUndefined();
    });

    it('Tirar o ano pintado: o pedido não é recusado nem refeito, e o item abre', async () => {
      const { scene, version, plan } = await h.runTurn(
        'tira esse 2027 do ovo',
        item('tirar o 2027 do ovo', { requests: [open('tirar o 2027 do ovo')] }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
      expect(planOf(version).image?.change).toBe('tirar o 2027 do ovo');
      expect((await h.sceneOf(scene.id)).brief.map((entry) => entry.text)).toEqual([
        'tirar o 2027 do ovo',
      ]);
    });

    it('Inventário com o ano: o item sai do plano, sem refazer', async () => {
      const { version, plan } = await h.runTurn(
        'mais flores, mantem os ovos com 2027',
        item('mais flores', { inventory_keep: ['ovos com 2027', 'cesta de ovos'] }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(planOf(version).image?.preserve).toEqual(['cesta de ovos']);
    });

    it('Pedido com ano não fica em aberto: a lista não ganha o item e o plano segue', async () => {
      const { scene, version } = await h.runTurn(
        YEAR_MESSAGE,
        imagem(WITHOUT_YEAR, { requests: [open('indicação do ano 2027'), open('um coelho')] }),
        { noImage: true },
      );
      expect(version.status).toBe('queued');
      expect((await h.sceneOf(scene.id)).brief.map((entry) => entry.text)).toEqual(['um coelho']);
    });

    it('Campo que fica vazio depois do corte vira pergunta, sem imagem', async () => {
      const { scene, version, plan } = await h.runTurn(
        'coloca o ano 2027',
        item('Colocar o ano 2027'),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toBe('O que você quer mudar na imagem?');
      expect(imageJobs()).toHaveLength(0);
    });

    it('Número solto: "99 no canto" em exact_text é pintado, e "3 coelhos" segue (R34)', async () => {
      const painted = await h.runTurn(
        'coloca 99 no canto',
        item('Add the number in the corner', { exact_text: ['99'] }),
      );
      expect(painted.version.status).toBe('queued');
      expect(imageJobs()).toHaveLength(1);

      const kept = await h.runTurn('coloca 3 coelhos', item('', { what_to_put: '3 coelhos' }));
      expect(kept.version.status).toBe('queued');
      expect(imageJobs()).toHaveLength(1);
    });
  },
);
