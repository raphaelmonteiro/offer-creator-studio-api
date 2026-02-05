"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginate = paginate;
function paginate(items, total, options) {
    const { page, limit } = options;
    const totalPages = Math.ceil(total / limit);
    return {
        data: items,
        pagination: {
            page,
            limit,
            total,
            totalPages,
        },
    };
}
//# sourceMappingURL=pagination.util.js.map