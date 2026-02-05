export declare const fileUploadOptions: {
    limits: {
        fileSize: number;
    };
};
export declare const createFileInterceptor: (fieldName?: string) => import("@nestjs/common").Type<import("@nestjs/common").NestInterceptor<any, any>>;
