/**
 * Types for database layer
 */

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
}

export interface Transaction {
  commit(): void;
  rollback(): void;
}
