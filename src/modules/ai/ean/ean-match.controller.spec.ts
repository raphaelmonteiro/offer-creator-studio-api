import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EanCalibrationService } from './ean-calibration.service';
import { EanJudgeService } from './ean-judge.service';
import { EanMatchAdminController, EanReviewController } from './ean-match.controller';
import { EanMatchCommitService } from './ean-match-commit.service';
import { EanMatchJobService } from './ean-match-job.service';
import { EanReviewService } from './ean-review.service';

/** Garante que o Nest injeta as dependências nos dois controllers (herança). */
describe('controllers de vínculo EAN — injeção', () => {
  it('as duas portas recebem os serviços', async () => {
    const revisao = { listar: jest.fn().mockResolvedValue({ total: 0, itens: [] }) };
    const jobs = { listarJobs: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      controllers: [EanMatchAdminController, EanReviewController],
      providers: [
        { provide: EanMatchJobService, useValue: jobs },
        { provide: EanMatchCommitService, useValue: {} },
        { provide: EanReviewService, useValue: revisao },
        { provide: EanCalibrationService, useValue: {} },
        { provide: EanJudgeService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'tok' } },
      ],
    }).compile();

    await expect(mod.get(EanReviewController).fila()).resolves.toEqual({ total: 0, itens: [] });
    await expect(mod.get(EanMatchAdminController).listarJobs('tok')).resolves.toEqual([]);
  });
});
