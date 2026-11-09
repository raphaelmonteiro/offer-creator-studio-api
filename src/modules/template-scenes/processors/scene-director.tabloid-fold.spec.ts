import * as sharp from 'sharp';
import { FIXED_ANNOUNCEMENT } from '../domain/scene-director-phrases';
import { DirectorPlan } from '../domain/scene-director-schema';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TABLOID_FOLD_NOTE } from '../scene-texts';
import { directorImage, directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { tabloidChat } from '../testing/scene-tabloid-chat';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { visionReadings } from '../testing/scene-vision-fake';
import { describeIfSceneDb } from '../testing/scene-test-db';

const MAGENTA = [255, 0, 255];

describeIfSceneDb('Jornal: faixa da dobra e faixa na capa (D-9, D-10; banco chroma_x_e2e)', () => {
  const h = useFacesHarness();
  const { chat, chatWith, assistantOf, runImage } = tabloidChat(h);

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

  const paintedMagenta = () =>
    sharp({ create: { width: 3328, height: 2480, channels: 3, background: '#ff00ff' } })
      .png()
      .toBuffer();

  const pixelAt = async (url: string, x: number): Promise<number[]> =>
    Array.from(
      (
        await sharp(await h.files.read(url))
          .extract({ left: x, top: 1200, width: 1, height: 1 })
          .removeAlpha()
          .raw()
          .toBuffer()
      ).subarray(0, 3),
    );

  const masterUrl = async (assetId: string | null | undefined): Promise<string> =>
    (
      await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: assetId as string,
      })
    ).url;

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

    it('Anúncio que afirma algo sobre a dobra é trocado pelo fixo, e a edição leva a nota do sistema', async () => {
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
      expect(text).toContain(TABLOID_FOLD_NOTE);
    });
  });

  describe('Recolagem da faixa da dobra', () => {
    it('edição da Externa: a faixa volta da master anterior, o resto é o do modelo', async () => {
      const { scene, outer } = await h.tabloidScene({ outer: true });
      const { sent } = await chatWith(
        scene.id,
        'coloca uma faixa verde embaixo da capa',
        editPlan({ zone: 'body', side: 'right' }, 'Add a green strip'),
        { face: 'outer' },
      );
      const fake = h.fakeProvider(async () => ({
        ...(await h.okResult(0.13)),
        buffer: await paintedMagenta(),
      }));
      await h.processorWith(fake.provider).process(h.job(scene.id, sent.versionId));
      const before = await masterUrl(outer?.masterAssetId);
      const after = await masterUrl((await h.versionOf(sent.versionId)).masterAssetId);
      expect(await pixelAt(after, 1664)).toEqual(await pixelAt(before, 1664));
      expect(await pixelAt(after, 1600)).toEqual(await pixelAt(before, 1600));
      expect(await pixelAt(after, 2500)).toEqual(MAGENTA);
    });

    it('imagem nova da Externa (generate): nada é recolado, a faixa da dobra é a da imagem nova (R11)', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const { sent } = await chatWith(
        scene.id,
        'gera outra imagem, tudo diferente',
        directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          image: directorImage({
            change: 'A new festive background',
            region: { zone: 'whole', side: null },
          }),
        }),
        { face: 'outer' },
      );
      const fake = h.fakeProvider(async () => ({
        ...(await h.okResult(0.13)),
        buffer: await paintedMagenta(),
      }));
      await h.processorWith(fake.provider).process(h.job(scene.id, sent.versionId));
      expect(fake.generate).toHaveBeenCalledTimes(1);
      const done = await h.versionOf(sent.versionId);
      expect(done.status).toBe('ready');
      const after = await masterUrl(done.masterAssetId);
      expect(await pixelAt(after, 1664)).toEqual(MAGENTA);
      expect(await pixelAt(after, 1600)).toEqual(MAGENTA);
    });

    it('derivação da Interna: a faixa da Interna é a da Externa (a referência da derivação)', async () => {
      const { scene, outer } = await h.tabloidScene({ outer: true });
      const { sent } = await chat(scene.id, 'agora faz as páginas de dentro');
      const fake = h.fakeProvider(async () => ({
        ...(await h.okResult(0.13)),
        buffer: await paintedMagenta(),
      }));
      await h.processorWith(fake.provider).process(h.job(scene.id, sent.versionId));
      const done = await h.versionOf(sent.versionId);
      expect(done.status).toBe('ready');
      const outerUrl = await masterUrl(outer?.masterAssetId);
      const innerUrl = await masterUrl(done.masterAssetId);
      expect(await pixelAt(innerUrl, 1664)).toEqual(await pixelAt(outerUrl, 1664));
      expect(await pixelAt(innerUrl, 1580)).toEqual(await pixelAt(outerUrl, 1580));
      expect(await pixelAt(innerUrl, 2500)).toEqual(MAGENTA);
    });

    it('refação do texto: a segunda imagem também volta com a faixa da dobra da master base', async () => {
      const { scene, outer } = await h.tabloidScene({ outer: true });
      const { sent } = await chatWith(
        scene.id,
        'escreve ANIVERSÁRIO no cabeçalho',
        editPlan({ zone: 'header', side: 'right' }, 'Add the title', {
          image: directorImage({
            change: 'Add the title',
            region: { zone: 'header', side: 'right' },
            exact_text: ['ANIVERSÁRIO'],
          }),
        }),
        { face: 'outer' },
      );
      const judge = visionReadings([
        [{ pedido: 'ANIVERSÁRIO', lido: 'ANIVERSARIO' }],
        [{ pedido: 'ANIVERSÁRIO', lido: 'ANIVERSÁRIO' }],
      ]);
      const fake = h.fakeProvider(async () => ({
        ...(await h.okResult(0.13)),
        buffer: await paintedMagenta(),
      }));
      await h
        .processorWith(fake.provider, {}, judge.client)
        .process(h.job(scene.id, sent.versionId));
      expect(fake.edit).toHaveBeenCalledTimes(2);
      const done = await h.versionOf(sent.versionId);
      const before = await masterUrl(outer?.masterAssetId);
      const after = await masterUrl(done.masterAssetId);
      expect(await pixelAt(after, 1664)).toEqual(await pixelAt(before, 1664));
      expect(await pixelAt(after, 2500)).toEqual(MAGENTA);
    });
  });
});
