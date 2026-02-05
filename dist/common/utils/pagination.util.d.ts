export interface PaginationOptions {
    page: number;
    limit: number;
}
export interface PaginationResult<T> {
    data: T[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}
export declare function paginate<T>(items: T[], total: number, options: PaginationOptions): PaginationResult<T>;
