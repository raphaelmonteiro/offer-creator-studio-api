import { Body, Controller, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProjectPieceDto } from './dto/piece.dto';
import { McEnabledGuard } from './mc-enabled.guard';
import { McPieceProjectService } from './services/mc-piece-project.service';

/**
 * Rota da peça de ofertas DEPOIS do vídeo existir (change
 * video-peca-configuravel, tarefa 5.4). Mesmo prefixo, guards e envelope do
 * CommercialsController; num controller próprio para não acoplar o construtor dele.
 */
@ApiTags('commercials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, McEnabledGuard)
@Controller('commercials')
export class McPieceProjectController {
  constructor(private readonly pieceProject: McPieceProjectService) {}

  /**
   * Edita a peça de um vídeo pelo tipo de mudança: falada (nome/preço/unidade
   * de item falado, falados entrando/saindo, ordem) → fala reescrita e revisão
   * do roteiro; só visual → quadro + compose + finalize (revisão `assembly_only`
   * depois da entrega). Devolve o projeto com `pieceChange`.
   */
  @Patch('projects/:id/piece')
  @ApiOperation({
    summary: 'Peça de ofertas: edita a peça do vídeo (fala ou composição, pelo tipo de mudança)',
  })
  updatePiece(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectPieceDto,
  ) {
    return this.pieceProject.updatePiece(user.id, id, dto);
  }
}
