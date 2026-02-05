export declare class CreateProductDto {
    name: string;
    price: number;
    originalPrice?: number | null;
    unit: string;
    imageUrl?: string | null;
    category?: string;
    sku?: string;
    observation?: string | null;
    active?: boolean;
}
