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

export function paginate<T>(
  items: T[],
  total: number,
  options: PaginationOptions,
): PaginationResult<T> {
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
