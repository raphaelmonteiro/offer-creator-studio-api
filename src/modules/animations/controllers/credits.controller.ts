import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { CreditsService, creditsEnabled } from '../../../shared/credits/credits.service';
import { AiCreditLedgerEntry } from '../../../shared/credits/ai-credit-ledger.entity';

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/credits')
export class CreditsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditsService,
  ) {}

  /**
   * `enabled: false` = cobrança desligada; o frontend esconde saldo e custos.
   * Saldo/extrato continuam sendo devolvidos (ficam zerados enquanto não há
   * lançamentos) para não quebrar o contrato quando a cobrança for religada.
   */
  @Get()
  async summary(@CurrentUser() user: { id: string }) {
    const enabled = creditsEnabled();
    const balance = await this.credits.getBalance(this.dataSource.manager, user.id);
    const recent = await this.dataSource.getRepository(AiCreditLedgerEntry).find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    return { enabled, balance, recent };
  }
}
