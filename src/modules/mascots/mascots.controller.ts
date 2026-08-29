import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';
import { createFileInterceptor } from '../../common/utils/multer.util';
import { MascotsService } from './mascots.service';
import {
  ConfirmMascotRightsDto,
  MascotPreviewQueryDto,
  QueryMascotsDto,
  UpdateMascotDto,
} from './dto/mascot.dto';
import { MASCOT_CRAFT, MASCOT_ENTRANCES, MASCOT_GESTURES } from './domain/presence-animation';

@ApiTags('Mascots')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('mascots')
export class MascotsController {
  constructor(private readonly mascots: MascotsService) {}

  @Post()
  @SkipValidation()
  @UseInterceptors(createFileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string', example: 'Seu Zé do Mercadão' },
        clientId: { type: 'string', format: 'uuid' },
        rightsConfirmed: {
          type: 'string',
          example: 'true',
          description:
            'Declaração de titularidade ou licença de uso da marca do mascote. Sem ela o mascote não fica pronto para uso.',
        },
      },
    },
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Envia o PNG do mascote (o original nunca é alterado)' })
  create(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { name?: string; clientId?: string; rightsConfirmed?: string },
  ) {
    return this.mascots.create(user.id, file, body);
  }

  @Get('presets')
  @ApiOperation({ summary: 'Presets de gesto/entrada e parâmetros de craft da animação' })
  presets() {
    return { gestures: MASCOT_GESTURES, entrances: MASCOT_ENTRANCES, craft: MASCOT_CRAFT };
  }

  @Get()
  @ApiOperation({ summary: 'Lista os mascotes do usuário' })
  findAll(@CurrentUser() user: { id: string }, @Query() query: QueryMascotsDto) {
    return this.mascots.findAll(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de um mascote' })
  findOne(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.findOne(user.id, id);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Timeline de presença (respiração, entrada e gesto) para o preview' })
  preview(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MascotPreviewQueryDto,
  ) {
    return this.mascots.preview(user.id, id, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Renomeia o mascote ou troca o cliente vinculado' })
  update(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMascotDto,
  ) {
    return this.mascots.update(user.id, id, dto);
  }

  @Post(':id/cutout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recorta o fundo do mascote (derivado — o original fica intacto)' })
  cutout(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.removeBackground(user.id, id);
  }

  @Post(':id/rig/prepare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desmonta o mascote em peças (cabeça, tronco, braços, pernas) para animar',
  })
  prepareRig(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.prepareRig(user.id, id);
  }

  @Get(':id/rig')
  @ApiOperation({ summary: 'Rig atual do mascote (peças, pivôs, boca e olhos)' })
  getRig(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.getRig(user.id, id);
  }

  @Put(':id/rig')
  @ApiOperation({
    summary: 'Salva o rig conferido no editor (rig aprovado é imutável — editar cria nova versão)',
  })
  saveRig(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { rig?: unknown },
  ) {
    return this.mascots.saveRig(user.id, id, body?.rig ?? body);
  }

  @Post(':id/rights')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registra o aceite de titularidade/licença da marca' })
  confirmRights(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmMascotRightsDto,
  ) {
    return this.mascots.confirmRights(user.id, id, dto.note);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Arquiva o mascote' })
  archive(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.archive(user.id, id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desarquiva o mascote' })
  unarchive(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.mascots.archive(user.id, id, false);
  }
}
