import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Between } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  async create(createProductDto: CreateProductDto): Promise<Product> {
    // Verifica SKU duplicado apenas se SKU foi fornecido
    if (createProductDto.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: { sku: createProductDto.sku },
      });

      if (existingProduct) {
        throw new ConflictException({
          code: 'SKU_ALREADY_EXISTS',
          message: 'SKU já cadastrado',
        });
      }
    }

    const product = this.productRepository.create(createProductDto);
    return this.productRepository.save(product);
  }

  async findAll(query: QueryProductDto): Promise<PaginationResult<Product>> {
    const { page = 1, limit = 20, search, category, minPrice, maxPrice } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    // Search will be handled in the query

    if (category) {
      where.category = category;
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      if (minPrice !== undefined && maxPrice !== undefined) {
        where.price = Between(minPrice, maxPrice);
      } else if (minPrice !== undefined) {
        where.price = Between(minPrice, 999999);
      } else if (maxPrice !== undefined) {
        where.price = Between(0, maxPrice);
      }
    }

    const queryBuilder = this.productRepository.createQueryBuilder('product');

    if (search) {
      queryBuilder.where(
        '(product.name LIKE :search OR product.sku LIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (category) {
      queryBuilder.andWhere('product.category = :category', { category });
    }

    if (minPrice !== undefined) {
      queryBuilder.andWhere('product.price >= :minPrice', { minPrice });
    }

    if (maxPrice !== undefined) {
      queryBuilder.andWhere('product.price <= :maxPrice', { maxPrice });
    }

    queryBuilder.skip(skip).take(limit).orderBy('product.createdAt', 'DESC');

    const [products, total] = await queryBuilder.getManyAndCount();

    return paginate(products, total, { page, limit });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Produto não encontrado',
      });
    }
    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(id);

    // Verifica SKU duplicado apenas se SKU foi fornecido e é diferente do atual
    if (updateProductDto.sku && updateProductDto.sku !== product.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: { sku: updateProductDto.sku },
      });

      if (existingProduct) {
        throw new ConflictException({
          code: 'SKU_ALREADY_EXISTS',
          message: 'SKU já cadastrado',
        });
      }
    }

    Object.assign(product, updateProductDto);
    return this.productRepository.save(product);
  }

  async remove(id: string): Promise<void> {
    const product = await this.findOne(id);
    // Soft delete
    product.active = false;
    await this.productRepository.save(product);
  }

  async updateImage(id: string, imageUrl: string): Promise<Product> {
    const product = await this.findOne(id);
    product.imageUrl = imageUrl;
    return this.productRepository.save(product);
  }
}
