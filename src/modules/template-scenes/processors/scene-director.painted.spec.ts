import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const item = (extra: Partial<DirectorPlan>): Partial<DirectorPlan> => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou fazer a mudança.',
  ...extra,
});

describeIfSceneDb('Pintado com três saídas, pelo caminho do Diretor (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
  const lastReply = async (sceneId: string) =>
    (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content ?? '';

  describe('Dúvida persiste (b)', () => {
    it.each([
      ['a logo da loja sem fundo', { what_to_put: 'a logo da loja sem fundo' }],
      ['titulo Ofertas da Semana', { what_to_put: 'titulo Ofertas da Semana' }],
      ['um coelho no estilo DISNEY', { what_to_put: 'um coelho no estilo DISNEY' }],
      ['coloca uma placa com letras', { what_to_put: 'uma placa com letras' }],
      ['integra a logo na imagem', { what_to_put: 'a logo integrada ao fundo' }],
    ])(
      '"%s": o chat pergunta se quer escrito, sem dizer "não pinto" e sem imagem',
      async (message, plan) => {
        const { scene, version, plan: calls } = await h.runTurn(message, item(plan));
        expect(calls).toHaveBeenCalledTimes(2);
        expect(calls.mock.calls[1][0].text).not.toMatch(/n[ãa]o pinto/i);
        expect(version.status).toBe('rejected');
        const reply = await lastReply(scene.id);
        expect(reply).toContain('Não entendi se você quer isso escrito na imagem');
        expect(reply).toContain('camada exata');
        expect(reply).not.toMatch(/n[ãa]o pinto/i);
        expect(imageJobs()).toHaveLength(0);
      },
    );

    it('a dúvida some na segunda chamada: o plano segue, com o custo das duas', async () => {
      const { version } = await h.runTurn('coloca o titulo', async (_c, attempt) =>
        directorAnswer(
          item({ what_to_change: attempt === 1 ? 'colocar o titulo' : 'colocar flores' }),
        ),
      );
      expect(version.status).toBe('queued');
      expect((version.metrics.director as { calls: unknown[] }).calls).toHaveLength(2);
    });
  });

  describe('Palavra solta não é motivo de recusa (c)', () => {
    it.each([
      'deixar a imagem 30% mais clara',
      'coelhos reais',
      'flores logo abaixo do coelho',
      'aumentar 20% o coelho',
      'um coelho com marcas no pelo',
    ])('"%s" segue sem refazer, sem recusa e sem pergunta', async (text) => {
      const { version, plan } = await h.runTurn('ajusta isso', item({ what_to_change: text }));
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
      expect(imageJobs()).toHaveLength(1);
    });
  });

  describe('Remoção com forma de escrita', () => {
    it.each([
      'tira o preço R$ 9,90',
      'tira o OFERTA',
      'apaga "Feliz Natal"',
      'troca o OFERTA por flores',
    ])('"%s" segue, sem recusa e sem refazer', async (text) => {
      const { version, plan } = await h.runTurn('tira isso', item({ what_to_change: text }));
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
    });
  });

  describe('Recusa inequívoca (a)', () => {
    it('Troca por escrita: "troca o coelho por OFERTA" vira recusa', async () => {
      const { scene, version, plan } = await h.runTurn(
        'troca o coelho por OFERTA',
        item({ what_to_change: 'troca o coelho por OFERTA' }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toContain('Não pinto');
      expect(imageJobs()).toHaveLength(0);
    });

    it.each([
      'uma placa escrita FELIZ PASCOA',
      'uma placa com a frase Feliz Pascoa',
      'faixa com os dizeres OFERTA',
      'selo 50% off',
      'uma placa vazia para escrever FELIZ PASCOA',
      'placa adequada para o preço R$ 9,90',
      'escreve OFERTA sem erro',
      'tira o coelho para escrever FELIZ PASCOA',
    ])('Formas de pedir escrita: "%s" vira recusa, sem imagem', async (text) => {
      const { version } = await h.runTurn('coloca isso', item({ what_to_put: text }));
      expect(version.status).toBe('rejected');
      expect(imageJobs()).toHaveLength(0);
    });
  });

  describe('Mencionar não é pedir escrita', () => {
    it.each([
      'trocar o preço pintado por flores',
      'abrir espaço para os preços',
      'deixar o fundo atrás do título mais claro',
      'deixar sem texto legível',
    ])('"%s" não é recusado nem refeito', async (text) => {
      const { version, plan } = await h.runTurn(text, item({ what_to_change: text }));
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
    });
  });

  describe('Resposta sobre texto escrito (R27)', () => {
    it('o Diretor responde "Está escrito Feliz Páscoa" com written_content, e a resposta não é barrada', async () => {
      const { scene, version } = await h.runTurn('o que está escrito aí?', {
        turn_kind: 'pergunta',
        will_change_image: false,
        reply: 'Está escrito Feliz Páscoa',
        written_content: ['Feliz Páscoa'],
      });
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toBe('Pelo que vejo na imagem: Está escrito Feliz Páscoa');
      expect(imageJobs()).toHaveLength(0);
    });
  });
});
