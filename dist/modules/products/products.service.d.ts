import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { PaginationResult } from '../../common/utils/pagination.util';
export declare class ProductsService {
    private productRepository;
    constructor(productRepository: Repository<Product>);
    create(createProductDto: CreateProductDto): Promise<Product>;
    findAll(query: QueryProductDto): Promise<PaginationResult<Product>>;
    findOne(id: string): Promise<Product>;
    update(id: string, updateProductDto: UpdateProductDto): Promise<Product>;
    remove(id: string): Promise<void>;
    updateImage(id: string, imageUrl: string): Promise<Product>;
}
