import { editPlan, goodVision, pricedProviderOf } from '../testing/scene-edit-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { CONTINUE_BACKGROUND, REMOVE_INSTRUCTION } from './scene-prompt';

describeIfSceneDb('SceneTurnProcessor: prompts de imagem a partir da intenção (D-19)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());

  /** Roda a edição com o plano dado e devolve o que o provedor de imagem e a visão receberam. */
  async function runEdit(plan: ReturnType<typeof editPlan>, request: string) {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan, request });
    const { provider, edit } = pricedProviderOf(h, 0);
    const vision = goodVision();
    await h.processorWith(provider, {}, vision).process(h.job(scene.id, version.id));
    return {
      prompt: edit.mock.calls[0][0].prompt,
      visionPrompt: vision.compare.mock.calls[0][0].prompt,
    };
  }

  it('Remover com objeto nomeado: o imagePrompt com o objeto e a instrução de continuar o fundo', async () => {
    const message = 'remova os ovos da area marcada';
    const { prompt } = await runEdit(
      editPlan(undefined, {
        remove: true,
        object: 'os ovos',
        instruction: message,
        imagePrompt: 'remover os ovos',
      }),
      message,
    );
    expect(prompt).toContain('Na área marcada: remover os ovos.');
    expect(prompt).toContain(CONTINUE_BACKGROUND);
    expect(prompt).not.toContain(REMOVE_INSTRUCTION);
  });

  it.each(['remove isso', 'tira essa área'])(
    'Remover sem objeto nomeado (%s): a instrução fixa, mesmo com o imagePrompt do modelo',
    async (message) => {
      const { prompt } = await runEdit(
        editPlan(undefined, {
          remove: true,
          object: null,
          instruction: message,
          imagePrompt: 'remover algo qualquer',
        }),
        message,
      );
      expect(prompt).toContain(`Na área marcada: ${REMOVE_INSTRUCTION}.`);
      expect(prompt).not.toContain('algo qualquer');
    },
  );

  it('sem imagePrompt a frase do cliente vai ao modelo: ela nunca se perde', async () => {
    const message = 'ta melhor mas remove da parte de baixo os ovos a direita.';
    const { prompt } = await runEdit(
      editPlan(undefined, { remove: true, object: 'os ovos', instruction: message }),
      message,
    );
    expect(prompt).toContain(`Na área marcada: ${message.replace(/\.$/, '')}.`);
    expect(prompt).toContain(CONTINUE_BACKGROUND);
  });

  it('a visão recebe a mensagem original, não a paráfrase do modelo', async () => {
    const message = 'deixa o sol bem mais alaranjado, tipo pôr do sol';
    const { prompt, visionPrompt } = await runEdit(
      editPlan(undefined, { instruction: message, imagePrompt: 'sol alaranjado' }),
      message,
    );
    expect(prompt).toContain('Na área marcada: sol alaranjado.');
    expect(visionPrompt).toContain(`"${message}"`);
    expect(visionPrompt).not.toContain('"sol alaranjado"');
  });
});
