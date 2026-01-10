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
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um novo produto' })
  @ApiResponse({ status: 201, description: 'Produto criado com sucesso' })
  create(@Body() createProductDto: CreateProductDto) {
    return this.productsService.create(createProductDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os produtos' })
  @ApiResponse({ status: 200, description: 'Lista de produtos' })
  findAll(@Query() query: QueryProductDto) {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um produto específico' })
  @ApiResponse({ status: 200, description: 'Produto encontrado' })
  @ApiResponse({ status: 404, description: 'Produto não encontrado' })
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um produto' })
  @ApiResponse({ status: 200, description: 'Produto atualizado' })
  update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto) {
    return this.productsService.update(id, updateProductDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um produto (soft delete)' })
  @ApiResponse({ status: 200, description: 'Produto removido' })
  remove(@Param('id') id: string) {
    return this.productsService.remove(id).then(() => ({
      message: 'Produto removido com sucesso',
    }));
  }

  @Post(':id/image')
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
  @ApiOperation({ summary: 'Upload da imagem do produto' })
  @ApiResponse({ status: 200, description: 'Imagem enviada com sucesso' })
  async uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadFile(file, 'products');
    const product = await this.productsService.updateImage(id, upload.url);
    return { imageUrl: product.imageUrl };
  }
}
