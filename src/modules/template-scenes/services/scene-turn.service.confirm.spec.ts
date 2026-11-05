import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { errorOf } from '../testing/scene-test-helpers';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useTurnServiceHarness } from '../testing/scene-turn-service-harness';

const RECT = { x: 0.6, y: 0.05, w: 0.3, h: 0.15 };

describeIfSceneDb('SceneTurnService: confirmação do ajuste geral (banco chroma_x_e2e)', () => {
  const h = useTurnServiceHarness();
  const { readyScene, send, versionsOf, sceneOf } = h;

  describe('ajuste geral com confirmação', () => {
    it('pergunta primeiro (sem job) e só depois da confirmação enfileira o ajuste', async () => {
      const scene = await readyScene('Cls global');
      const asked = await send(scene.id, { content: 'deixa tudo mais quente' });
      expect(asked).toMatchObject({ jobId: null, operation: 'needs_confirmation_global' });
      expect(asked.assistantMessage?.content).toContain('fundo inteiro');
      expect(h.publish).not.toHaveBeenCalled();

      const confirmed = await send(
        scene.id,
        { content: 'Confirmar', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
        asked.revision,
      );

      expect(confirmed).toMatchObject({ operation: 'global_regenerate', jobId: 'job-1' });
      const versions = await versionsOf(scene.id);
      expect(versions[2]).toMatchObject({ operation: 'generate', status: 'queued' });
      expect(versions[2].metrics.plan).toMatchObject({
        operation: 'global_regenerate',
        instruction: 'deixa tudo mais quente',
      });
    });

    it('repetir a confirmação não duplica o ajuste: 409 CONFIRMATION_NOT_PENDING', async () => {
      const scene = await readyScene('Cls global repetida');
      const asked = await send(scene.id, { content: 'deixa tudo mais quente' });
      const confirm = (revision: number) =>
        send(
          scene.id,
          { content: 'sim', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
          revision,
        );
      const first = await confirm(asked.revision);
      // a versão em curso termina (simula o worker) e a mesma confirmação chega de novo
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: first.versionId },
        { status: 'failed' },
      );
      expect(await errorOf(confirm(first.revision))).toEqual({
        status: 409,
        code: 'CONFIRMATION_NOT_PENDING',
      });
      expect(h.publish).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['region', { region: RECT }],
      [
        'mask',
        {
          mask: {
            kind: 'lasso',
            points: [
              { x: 0.1, y: 0.1 },
              { x: 0.4, y: 0.1 },
              { x: 0.2, y: 0.4 },
            ],
          },
        },
      ],
      ['zone', { zone: 'header' }],
      ['targetElementId', { targetElementId: 'logo-1' }],
      ['attachments', { attachments: [{ assetId: '11111111-1111-4111-8111-111111111111' }] }],
    ])(
      'confirmação com %s: 400, nada gravado, e a confirmação válida seguinte é aceita',
      async (_name, extra) => {
        const scene = await readyScene(`Cls confirma alvo ${_name}`);
        const asked = await send(scene.id, { content: 'deixa tudo mais quente' });
        const reply = asked.assistantMessage!.id;
        const versionsBefore = (await versionsOf(scene.id)).length;
        const messagesBefore = await h.dataSource.manager.count(TemplateSceneMessage, {
          where: { sceneId: scene.id },
        });

        const error = await errorOf(
          send(
            scene.id,
            { content: 'sim', confirmGlobal: true, replyToMessageId: reply, ...extra },
            asked.revision,
          ),
        );

        expect(error).toEqual({ status: 400, code: 'BAD_REQUEST' });
        expect(h.publish).not.toHaveBeenCalled();
        expect(await versionsOf(scene.id)).toHaveLength(versionsBefore);
        expect(
          await h.dataSource.manager.count(TemplateSceneMessage, { where: { sceneId: scene.id } }),
        ).toBe(messagesBefore);
        expect((await sceneOf(scene.id)).revision).toBe(asked.revision);
        const ok = await send(
          scene.id,
          { content: 'sim', confirmGlobal: true, replyToMessageId: reply },
          asked.revision,
        );
        expect(ok).toMatchObject({ operation: 'global_regenerate', jobId: 'job-1' });
      },
    );

    it('confirmar sem replyToMessageId: 400; resposta a mensagem que não é pergunta: 409', async () => {
      const scene = await readyScene('Cls global inválida');
      expect((await errorOf(send(scene.id, { confirmGlobal: true }))).status).toBe(400);
      const answered = await send(scene.id, { content: 'troca o sol de lado' });
      expect(
        await errorOf(
          send(
            scene.id,
            { confirmGlobal: true, replyToMessageId: answered.assistantMessage!.id },
            answered.revision,
          ),
        ),
      ).toEqual({ status: 409, code: 'CONFIRMATION_NOT_PENDING' });
    });
  });
});
