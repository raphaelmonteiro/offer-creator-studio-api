import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class ProductsController {
    private readonly productsService;
    private readonly uploadsService;
    constructor(productsService: ProductsService, uploadsService: UploadsService);
    create(createProductDto: CreateProductDto): Promise<import("./entities/product.entity").Product>;
    findAll(query: QueryProductDto): Promise<import("../../common/utils/pagination.util").PaginationResult<import("./entities/product.entity").Product>>;
    findOne(id: string): Promise<import("./entities/product.entity").Product>;
    update(id: string, updateProductDto: UpdateProductDto): Promise<import("./entities/product.entity").Product>;
    remove(id: string): Promise<{
        message: string;
    }>;
    uploadImage(id: string, file: Express.Multer.File): Promise<{
        imageUrl: string;
    }>;
}
