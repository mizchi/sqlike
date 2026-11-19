import type { SqlikeFeatureName } from "./sqlike-features.ts";
import type {
  CatalogFunctionGroup,
  CatalogExpressionGroup,
  CatalogStatementKind,
  CatalogQueryPart,
} from "./catalog-capabilities.ts";
export type {
  CatalogFunctionGroup,
  CatalogExpressionGroup,
  CatalogStatementKind,
  CatalogQueryPart,
} from "./catalog-capabilities.ts";
/** Build-only, conservative closure over the complete fixed schema and query IR. */
export interface CatalogRequirements {
  readonly format: "sqlike-runtime-requirements@1";
  readonly artifactSHA256: string;
  readonly sourceSHA256: string;
  readonly features: readonly SqlikeFeatureName[];
  readonly functions: readonly string[];
  readonly functionGroups: readonly CatalogFunctionGroup[];
  readonly expressionGroups: readonly CatalogExpressionGroup[];
  readonly statements: readonly CatalogStatementKind[];
  readonly queryParts: readonly CatalogQueryPart[];
}
