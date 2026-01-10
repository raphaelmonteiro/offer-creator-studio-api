import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Clients')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('clients')
export class ClientsController {
  constructor(
    private readonly clientsService: ClientsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um novo cliente' })
  @ApiResponse({ status: 201, description: 'Cliente criado com sucesso' })
  create(@Body() createClientDto: CreateClientDto) {
    return this.clientsService.create(createClientDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os clientes' })
  @ApiResponse({ status: 200, description: 'Lista de clientes' })
  findAll(@Query() query: QueryClientDto) {
    return this.clientsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um cliente específico' })
  @ApiResponse({ status: 200, description: 'Cliente encontrado' })
  @ApiResponse({ status: 404, description: 'Cliente não encontrado' })
  findOne(@Param('id') id: string) {
    return this.clientsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um cliente' })
  @ApiResponse({ status: 200, description: 'Cliente atualizado' })
  update(@Param('id') id: string, @Body() updateClientDto: UpdateClientDto) {
    return this.clientsService.update(id, updateClientDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um cliente' })
  @ApiResponse({ status: 200, description: 'Cliente removido' })
  remove(@Param('id') id: string) {
    return this.clientsService.remove(id).then(() => ({
      message: 'Cliente removido com sucesso',
    }));
  }

  @Post(':id/logo')
  @SkipValidation()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload do logo do cliente' })
  @ApiResponse({ status: 200, description: 'Logo enviado com sucesso' })
  async uploadLogo(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadFile(file, 'logos');
    const client = await this.clientsService.updateLogo(id, upload.url);
    return { logoUrl: client.logoUrl };
  }
}
