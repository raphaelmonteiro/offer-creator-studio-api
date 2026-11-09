import { FIXED_ANNOUNCEMENT } from '../domain/scene-director-phrases';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorImage, directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { tabloidChat } from '../testing/scene-tabloid-chat';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb(
  'Jornal: anúncio sem afirmar a dobra e faixa na capa (D-10, D-11; banco chroma_x_e2e)',
  () => {
    const h = useFacesHarness();
    const { chatWith, assistantOf, runImage } = tabloidChat(h);

    const editPlan = (
      region: { zone: 'header' | 'body' | 'footer'; side: 'left' | 'right' | null },
      change = 'Add golden confetti',
      extra: PlanOverrides = {},
    ): PlanOverrides =>
      directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        image: directorImage({ change, region }),
        ...extra,
      });

    describe('Faixa na capa e anúncio', () => {
      it('Faixa embaixo na capa (D-10): a região é a capa e o prompt a limita à direita da faixa da dobra', async () => {
        const { scene } = await h.tabloidScene({ outer: true });
        const { sent } = await chatWith(
          scene.id,
          'coloca uma faixa no rodapé da direita',
          editPlan({ zone: 'footer', side: 'right' }, 'Add a plain ribbon'),
          { face: 'outer' },
        );
        const plan = (await h.versionOf(sent.versionId)).metrics.plan as DirectorPlan;
        expect(plan.image?.region).toEqual({ zone: 'body', side: 'right' });
        const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
        expect(prompt).toContain('front cover (right half, x > 1754 px), below the header');
      });

      it('Rodapé da loja (sem lado ou na contracapa): o prompt limita a mudança à faixa da contracapa', async () => {
        const { scene } = await h.tabloidScene({ outer: true });
        const { sent } = await chatWith(
          scene.id,
          'coloca uma faixa no rodapé',
          editPlan({ zone: 'footer', side: null }, 'Add a plain ribbon'),
          { face: 'outer' },
        );
        const plan = (await h.versionOf(sent.versionId)).metrics.plan as DirectorPlan;
        expect(plan.image?.region).toEqual({ zone: 'footer', side: 'left' });
        const { prompt } = await runImage(scene.id, sent.versionId, 'edit');
        expect(prompt).toContain(
          'only inside the footer band of the back cover: x from 0 to 1574 px, y ≥ 2232 px',
        );
      });

      it('Anúncio que afirma algo sobre a dobra é trocado pelo fixo, sem nota da dobra (D-11)', async () => {
        const { scene } = await h.tabloidScene({ outer: true });
        const { sent } = await chatWith(
          scene.id,
          'coloca uma faixa verde embaixo da capa',
          editPlan({ zone: 'body', side: 'right' }, 'Add a green strip', {
            reply: 'Vou colocar uma faixa verde embaixo da capa, sem avançar sobre a dobra.',
          }),
          { face: 'outer' },
        );
        const text = await assistantOf(sent.versionId);
        expect(text).not.toContain('sem avançar');
        expect(text).toContain(FIXED_ANNOUNCEMENT);
      });
    });
  },
);
