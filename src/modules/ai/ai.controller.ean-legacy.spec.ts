import { AiController } from './ai.controller';

/** Endpoint legado `gallery/match-ean-from-spreadsheet` (openspec vinculo-ean-planilha-alta-confianca). */
describe('AiController.galleryMatchEanFromSpreadsheet', () => {
  function criar() {
    const planilha = {
      processar: jest.fn().mockResolvedValue({ resultados: [], casadaPorDescricao: 1 }),
    };
    const jobs = {
      criarJob: jest
        .fn()
        .mockResolvedValue({ jobId: 'job-9', itens: 7, descartadas: 3, totalLinhas: 10 }),
    };
    const config = { get: () => 'segredo' };
    const vazio = {} as never;
    const controller = new AiController(
      vazio,
      vazio,
      vazio,
      vazio,
      vazio,
      vazio,
      vazio,
      vazio,
      vazio,
      planilha as never,
      jobs as never,
      config as never,
      vazio,
    );
    return { controller, planilha, jobs };
  }
  const arquivo = { buffer: Buffer.from('x'), originalname: 'arcos.csv' } as Express.Multer.File;

  it('dryRun=false cria um job e não grava nada direto', async () => {
    const { controller, planilha, jobs } = criar();
    const r = await controller.galleryMatchEanFromSpreadsheet('segredo', arquivo, 'false');

    expect(jobs.criarJob).toHaveBeenCalledWith(arquivo.buffer, { fileName: 'arcos.csv' });
    expect(planilha.processar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ jobId: 'job-9' });
  });

  it('dry-run continua medindo sem criar job', async () => {
    const { controller, planilha, jobs } = criar();
    await controller.galleryMatchEanFromSpreadsheet('segredo', arquivo);

    expect(planilha.processar).toHaveBeenCalledWith(arquivo.buffer, { dryRun: true });
    expect(jobs.criarJob).not.toHaveBeenCalled();
  });
});
