import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { FICHA_R2 } from '../testing/reference-fichas';
import { conceptVision, useReferenceHarness } from '../testing/scene-reference-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorBodyOf, errorOf } from '../testing/scene-test-helpers';
import { loadReferenceView } from './scene-reference-view';

describeIfSceneDb('Correção da ficha pelo cliente (banco chroma_x_e2e)', () => {
  const h = useReferenceHarness();

  const view = (sceneId: string) => loadReferenceView(h.dataSource.manager, sceneId);

  async function reviseAndRead(
    sceneId: string,
    note: string,
    vision?: ReturnType<typeof conceptVision>,
  ) {
    const sent = await h.revise(sceneId, await h.revisionOf(sceneId), note);
    await h.run(sceneId, sent.versionId, { vision: vision?.client });
    return sent;
  }

  it('tirar um elemento inventado: nova leitura do mesmo encarte, a anterior discarded, sem imagem', async () => {
    const scene = await h.newScene();
    const first = await h.proposed(scene);
    const assets = await h.assetsOf(scene.id, 'reference');
    expect((await h.referenceState(first.versionId))?.summary?.uses.join(' ')).toContain(
      'bandeirinhas',
    );

    const sent = await h.revise(
      scene.id,
      await h.revisionOf(scene.id),
      'não tem bandeirinha, tira',
    );

    expect((await h.referenceState(first.versionId))?.state).toBe('discarded');
    const queued = await h.referenceState(sent.versionId);
    expect(queued).toMatchObject({
      state: 'reading',
      note: 'não tem bandeirinha, tira',
      correctionOf: first.versionId,
      assetId: assets[0].id,
    });
    expect(await h.assetsOf(scene.id, 'reference')).toHaveLength(1);
    expect((await h.messagesOf(scene.id)).at(-1)).toMatchObject({
      role: 'user',
      content: 'não tem bandeirinha, tira',
    });

    const fake = await h.run(scene.id, sent.versionId);

    const read = await h.referenceState(sent.versionId);
    expect(read?.state).toBe('proposed');
    expect(read?.summary?.uses.join(' ')).not.toContain('bandeirinhas');
    expect(read?.prompt).toContain('Client correction (Brazilian Portuguese)');
    expect(read?.prompt).toContain('não tem bandeirinha, tira');
    expect(read?.prompt).toContain('The previous concept was:');
    expect(fake.generate).not.toHaveBeenCalled();
    expect(fake.edit).not.toHaveBeenCalled();
    const replies = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: sent.versionId, role: 'assistant' },
    });
    expect(replies[0].content).toContain('Posso gerar assim?');
    expect(replies[0].content).not.toContain('bandeirinhas');
  });

  it('correção sem ficha proposta (usada, descartada ou sem leitura): 422 REFERENCE_NOT_PROPOSED e nada gravado', async () => {
    const empty = await h.newScene();
    expect(await errorOf(h.revise(empty.id, 0, 'mais vermelho'))).toEqual({
      status: 422,
      code: 'REFERENCE_NOT_PROPOSED',
    });

    const scene = await h.newScene();
    await h.proposed(scene);
    const generated = await h.generate(scene.id, await h.revisionOf(scene.id));
    await h.run(scene.id, generated.versionId);
    const before = (await h.versions(scene.id)).length;
    expect(
      await errorOf(h.revise(scene.id, await h.revisionOf(scene.id), 'mais vermelho')),
    ).toEqual({
      status: 422,
      code: 'REFERENCE_NOT_PROPOSED',
    });
    expect(await h.versions(scene.id)).toHaveLength(before);
  });

  it('limite de 5 correções por encarte: a sexta é 422 REFERENCE_REVISE_LIMIT, com a mensagem do front', async () => {
    const scene = await h.newScene();
    await h.proposed(scene);
    for (let round = 1; round <= 5; round += 1) {
      expect((await view(scene.id))?.revisionsLeft).toBe(5 - (round - 1));
      await reviseAndRead(scene.id, `mais vermelho ${round}`);
    }
    expect((await view(scene.id))?.revisionsLeft).toBe(0);

    const body = await errorBodyOf(h.revise(scene.id, await h.revisionOf(scene.id), 'mais uma'));
    expect(body).toMatchObject({
      code: 'REFERENCE_REVISE_LIMIT',
      message: 'Você já corrigiu 5 vezes. Gere assim ou envie outro encarte.',
    });
    expect(
      (await h.versions(scene.id)).filter((v) => v.operation === 'read_reference'),
    ).toHaveLength(6);
  });

  it('o contador é por encarte: outro encarte começa de novo com 5 correções', async () => {
    const scene = await h.newScene();
    await h.proposed(scene);
    await reviseAndRead(scene.id, 'mais vermelho');
    await h.proposed(scene);
    expect((await view(scene.id))?.revisionsLeft).toBe(5);
  });

  it('correção pedindo o selo de volta: o sanitizador derruba de novo o selo e o carrinho', async () => {
    const scene = await h.newScene();
    await h.proposed(scene);
    const vision = conceptVision(() => ({
      ...FICHA_R2,
      signature_elements: [
        ...(FICHA_R2.signature_elements as unknown[]),
        {
          element: 'Round seal with a shopping cart',
          kind: 'decoration',
          where: 'top edge',
          notes: 'gold',
        },
      ],
    }));
    const sent = await reviseAndRead(scene.id, 'coloca o selo com o carrinho de volta', vision);

    const read = await h.referenceState(sent.versionId);
    const names = read?.concept?.elements.map((e) => e.element) ?? [];
    expect(names.some((name) => /seal|cart|medallion|coin/i.test(name))).toBe(false);
    expect(read?.summary?.leftOut).toContain('o selo/medalhão da logo');
  });

  it('o composer manda a correção como texto: espaços nas pontas saem e vazio é recusado pelo DTO', async () => {
    const { ReviseReferenceDto } = await import('../dto/reference.dto');
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const ok = plainToInstance(ReviseReferenceDto, {
      expectedRevision: 1,
      note: '  mais vermelho  ',
    });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.note).toBe('mais vermelho');
    for (const note of ['   ', '', 'x'.repeat(501)]) {
      const bad = plainToInstance(ReviseReferenceDto, { expectedRevision: 1, note });
      expect((await validate(bad)).length).toBeGreaterThan(0);
    }
  });
});
