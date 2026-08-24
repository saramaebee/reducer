export interface Product {
  id: number;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

/** Deterministic catalogue: every response body is byte-stable across arms. */
export const PRODUCTS: Product[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  sku: `SKU-${String(i + 1).padStart(4, '0')}`,
  name: `Widget ${i + 1}`,
  price: 100 + i * 7,
  stock: (i * 13) % 97,
}));
