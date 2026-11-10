import { and, eq, isNull } from 'drizzle-orm';
import {
  type CategoryInput,
  CategoryInputSchema,
  NAMESPACE_RECURRING,
  uuidv5,
} from '@/core';
import type { AppDatabase, DbExecutor } from '../db';
import {
  categories,
  type CategoryKind,
  type CategoryRow,
} from '../schema';
import {
  advanceTransactionHlc,
  buildFieldHlcMap,
  enqueueOrCoalesceOutbox,
  generateUuidV4,
  type MutationContextOptions,
} from './outbox';

const CATEGORY_MUTABLE_COLUMNS = [
  'parent_id',
  'name',
  'kind',
  'color_hex',
  'icon_name',
] as const;

export interface UpdateCategoryPatch {
  parentId?: string | null;
  name?: string;
  colorHex?: string;
  iconName?: string;
}

export interface CategoryTreeNode {
  category: CategoryRow;
  subcategories: CategoryRow[];
}

export interface FlatCategoryDisplayItem {
  row: CategoryRow;
  depth: 0 | 1;
  parentName: string | null;
  displayLabel: string;
}

function serializeCategoryPayload(row: CategoryRow): Record<string, unknown> {
  return {
    id: row.id,
    household_id: row.householdId,
    parent_id: row.parentId,
    name: row.name,
    kind: row.kind,
    color_hex: row.colorHex,
    icon_name: row.iconName,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    hlc_timestamp: row.hlcTimestamp,
  };
}

function assertValidParentHierarchy(
  tx: DbExecutor,
  candidate: {
    id: string;
    householdId: string;
    parentId: string | null;
    kind: CategoryKind;
  },
): void {
  if (candidate.parentId === null) {
    return;
  }

  if (candidate.parentId === candidate.id) {
    throw new Error('Category cannot be its own parent');
  }

  const parent = tx
    .select()
    .from(categories)
    .where(eq(categories.id, candidate.parentId))
    .get();

  if (
    !parent ||
    parent.deletedAt !== null ||
    parent.householdId !== candidate.householdId
  ) {
    throw new Error(
      `Parent category not found or inactive in household: ${candidate.parentId}`,
    );
  }

  if (parent.kind !== candidate.kind) {
    throw new Error(
      `Parent category kind (${parent.kind}) must match subcategory kind (${candidate.kind})`,
    );
  }

  if (parent.parentId !== null) {
    throw new Error(
      'Category hierarchy supports at most 2 levels (root category -> subcategory)',
    );
  }
}

export function createCategory(
  db: AppDatabase,
  rawInput: CategoryInput,
  options: MutationContextOptions = {},
): CategoryRow {
  const input = CategoryInputSchema.parse(rawInput);

  return db.transaction((tx) => {
    assertValidParentHierarchy(tx, input);

    const meta = advanceTransactionHlc(tx, options);
    const fieldHlc = buildFieldHlcMap(CATEGORY_MUTABLE_COLUMNS, meta.hlc);

    tx.insert(categories)
      .values({
        id: input.id,
        householdId: input.householdId,
        parentId: input.parentId,
        name: input.name,
        kind: input.kind,
        colorHex: input.colorHex,
        iconName: input.iconName,
        createdAt: meta.isoNow,
        updatedAt: meta.isoNow,
        deletedAt: null,
        hlcTimestamp: meta.hlc,
        fieldHlc,
        serverSeq: 0,
      })
      .run();

    const row = tx
      .select()
      .from(categories)
      .where(eq(categories.id, input.id))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'categories',
      recordId: row.id,
      operation: 'UPSERT',
      payload: serializeCategoryPayload(row),
      fieldHlc,
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return row;
  });
}

export function updateCategory(
  db: AppDatabase,
  categoryId: string,
  patch: UpdateCategoryPatch,
  options: MutationContextOptions = {},
): CategoryRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .get();

    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Active category not found: ${categoryId}`);
    }

    const updatedCandidate = CategoryInputSchema.parse({
      id: existing.id,
      householdId: existing.householdId,
      parentId:
        patch.parentId !== undefined ? patch.parentId : existing.parentId,
      name: patch.name !== undefined ? patch.name : existing.name,
      kind: existing.kind,
      colorHex:
        patch.colorHex !== undefined ? patch.colorHex : existing.colorHex,
      iconName:
        patch.iconName !== undefined ? patch.iconName : existing.iconName,
    });

    assertValidParentHierarchy(tx, updatedCandidate);

    if (updatedCandidate.parentId !== null) {
      const activeChildren = tx
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.householdId, existing.householdId),
            eq(categories.parentId, existing.id),
            isNull(categories.deletedAt),
          ),
        )
        .all();

      if (activeChildren.length > 0) {
        throw new Error(
          'Cannot convert a category with active subcategories into a subcategory',
        );
      }
    }

    const changedColumns: string[] = [];
    if (patch.parentId !== undefined) changedColumns.push('parent_id');
    if (patch.name !== undefined) changedColumns.push('name');
    if (patch.colorHex !== undefined) changedColumns.push('color_hex');
    if (patch.iconName !== undefined) changedColumns.push('icon_name');

    const meta = advanceTransactionHlc(tx, options);
    const nextFieldHlc = buildFieldHlcMap(
      changedColumns,
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(categories)
      .set({
        parentId: updatedCandidate.parentId,
        name: updatedCandidate.name,
        colorHex: updatedCandidate.colorHex,
        iconName: updatedCandidate.iconName,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(categories.id, categoryId))
      .run();

    const updated = tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: meta.batchId,
      tableName: 'categories',
      recordId: updated.id,
      operation: 'UPSERT',
      payload: serializeCategoryPayload(updated),
      fieldHlc: buildFieldHlcMap(changedColumns, meta.hlc),
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    return updated;
  });
}

/**
 * Soft-deletes a category (`deleted_at = hlc`) and any active child subcategories
 * in a single atomic SQLite transaction sharing one `batchId` in `sync_outbox`.
 */
export function softDeleteCategory(
  db: AppDatabase,
  categoryId: string,
  options: MutationContextOptions = {},
): CategoryRow {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .get();

    if (!existing) {
      throw new Error(`Category not found: ${categoryId}`);
    }

    const sharedBatchId = options.batchId ?? generateUuidV4();
    const meta = advanceTransactionHlc(tx, {
      ...options,
      batchId: sharedBatchId,
    });
    const nextFieldHlc = buildFieldHlcMap(
      ['deleted_at'],
      meta.hlc,
      existing.fieldHlc,
    );

    tx.update(categories)
      .set({
        deletedAt: meta.hlc,
        updatedAt: meta.isoNow,
        hlcTimestamp: meta.hlc,
        fieldHlc: nextFieldHlc,
      })
      .where(eq(categories.id, categoryId))
      .run();

    const deleted = tx
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .get()!;

    enqueueOrCoalesceOutbox(tx, {
      mutationId: options.mutationId,
      batchId: sharedBatchId,
      tableName: 'categories',
      recordId: deleted.id,
      operation: 'SOFT_DELETE',
      payload: serializeCategoryPayload(deleted),
      fieldHlc: { deleted_at: meta.hlc },
      hlcTimestamp: meta.hlc,
      createdAt: meta.isoNow,
    });

    // Cascade soft-delete to active subcategories of this parent
    const children = tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.householdId, existing.householdId),
          eq(categories.parentId, categoryId),
          isNull(categories.deletedAt),
        ),
      )
      .all();

    for (const child of children) {
      const childMeta = advanceTransactionHlc(tx, {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      });
      const childFieldHlc = buildFieldHlcMap(
        ['deleted_at'],
        childMeta.hlc,
        child.fieldHlc,
      );

      tx.update(categories)
        .set({
          deletedAt: childMeta.hlc,
          updatedAt: childMeta.isoNow,
          hlcTimestamp: childMeta.hlc,
          fieldHlc: childFieldHlc,
        })
        .where(eq(categories.id, child.id))
        .run();

      const deletedChild = tx
        .select()
        .from(categories)
        .where(eq(categories.id, child.id))
        .get()!;

      enqueueOrCoalesceOutbox(tx, {
        batchId: sharedBatchId,
        tableName: 'categories',
        recordId: deletedChild.id,
        operation: 'SOFT_DELETE',
        payload: serializeCategoryPayload(deletedChild),
        fieldHlc: { deleted_at: childMeta.hlc },
        hlcTimestamp: childMeta.hlc,
        createdAt: childMeta.isoNow,
      });
    }

    return deleted;
  });
}

export function listActiveCategories(
  db: AppDatabase,
  householdId: string,
  kind?: CategoryKind,
): CategoryRow[] {
  if (kind) {
    return db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.householdId, householdId),
          eq(categories.kind, kind),
          isNull(categories.deletedAt),
        ),
      )
      .all();
  }

  return db
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.householdId, householdId),
        isNull(categories.deletedAt),
      ),
    )
    .all();
}

/**
 * Organizes flat active categories into a 2-level hierarchy (`CategoryTreeNode[]`).
 */
export function buildCategoryTree(
  rows: readonly CategoryRow[],
  kind?: CategoryKind,
): CategoryTreeNode[] {
  const active = rows.filter(
    (r) => r.deletedAt === null && (!kind || r.kind === kind),
  );
  const roots = active
    .filter((r) => r.parentId === null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const childrenByParent = new Map<string, CategoryRow[]>();
  for (const row of active) {
    if (row.parentId !== null) {
      const list = childrenByParent.get(row.parentId) ?? [];
      list.push(row);
      childrenByParent.set(row.parentId, list);
    }
  }

  return roots.map((root) => ({
    category: root,
    subcategories: (childrenByParent.get(root.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }));
}

/**
 * Flattens the 2-level category hierarchy into a linear list for `@shopify/flash-list` and pickers.
 */
export function flattenCategoryTree(
  rows: readonly CategoryRow[],
  kind?: CategoryKind,
): FlatCategoryDisplayItem[] {
  const tree = buildCategoryTree(rows, kind);
  const flat: FlatCategoryDisplayItem[] = [];

  for (const node of tree) {
    flat.push({
      row: node.category,
      depth: 0,
      parentName: null,
      displayLabel: node.category.name,
    });
    for (const sub of node.subcategories) {
      flat.push({
        row: sub,
        depth: 1,
        parentName: node.category.name,
        displayLabel: `${node.category.name} › ${sub.name}`,
      });
    }
  }

  return flat;
}

interface DefaultCategorySeedSpec {
  slug: string;
  name: string;
  kind: CategoryKind;
  colorHex: string;
  iconName: string;
  subcategories?: {
    slug: string;
    name: string;
    iconName: string;
  }[];
}

const DEFAULT_CATEGORY_SPECS: readonly DefaultCategorySeedSpec[] = [
  {
    slug: 'moradia',
    name: 'Moradia',
    kind: 'EXPENSE',
    colorHex: '#6366F1',
    iconName: 'home',
    subcategories: [
      {
        slug: 'aluguel-condominio',
        name: 'Aluguel e Condomínio',
        iconName: 'building',
      },
      { slug: 'energia-agua-gas', name: 'Energia, Água e Gás', iconName: 'zap' },
    ],
  },
  {
    slug: 'alimentacao',
    name: 'Alimentação',
    kind: 'EXPENSE',
    colorHex: '#10B981',
    iconName: 'utensils',
    subcategories: [
      { slug: 'supermercado', name: 'Supermercado', iconName: 'shopping-cart' },
      {
        slug: 'restaurantes-delivery',
        name: 'Restaurantes e Delivery',
        iconName: 'coffee',
      },
    ],
  },
  {
    slug: 'transporte',
    name: 'Transporte',
    kind: 'EXPENSE',
    colorHex: '#F59E0B',
    iconName: 'car',
    subcategories: [
      {
        slug: 'combustivel-apps',
        name: 'Combustível e Apps',
        iconName: 'navigation',
      },
    ],
  },
  {
    slug: 'saude',
    name: 'Saúde',
    kind: 'EXPENSE',
    colorHex: '#EF4444',
    iconName: 'heart',
  },
  {
    slug: 'lazer',
    name: 'Lazer',
    kind: 'EXPENSE',
    colorHex: '#EC4899',
    iconName: 'smile',
  },
  {
    slug: 'salario',
    name: 'Salário',
    kind: 'INCOME',
    colorHex: '#22C55E',
    iconName: 'briefcase',
  },
  {
    slug: 'rendimentos',
    name: 'Rendimentos',
    kind: 'INCOME',
    colorHex: '#14B8A6',
    iconName: 'trending-up',
  },
];

/**
 * Idempotently seeds default hierarchical categories for a household when none exist.
 * Uses deterministic UUIDv5 IDs (`householdId + ":category:" + slug`) to prevent duplicate categories
 * if both partners seed offline concurrently.
 */
export function seedDefaultCategories(
  db: AppDatabase,
  householdId: string,
  options: MutationContextOptions = {},
): CategoryRow[] {
  const existing = listActiveCategories(db, householdId);
  if (existing.length > 0) {
    return existing;
  }

  const sharedBatchId = options.batchId ?? generateUuidV4();
  const created: CategoryRow[] = [];

  for (const spec of DEFAULT_CATEGORY_SPECS) {
    const rootId = uuidv5(
      NAMESPACE_RECURRING,
      `${householdId}:category:${spec.slug}`,
    );
    const rootRow = createCategory(
      db,
      {
        id: rootId,
        householdId,
        parentId: null,
        name: spec.name,
        kind: spec.kind,
        colorHex: spec.colorHex,
        iconName: spec.iconName,
      },
      {
        ...options,
        batchId: sharedBatchId,
        mutationId: undefined,
      },
    );
    created.push(rootRow);

    if (spec.subcategories) {
      for (const sub of spec.subcategories) {
        const subId = uuidv5(
          NAMESPACE_RECURRING,
          `${householdId}:category:${spec.slug}:${sub.slug}`,
        );
        const subRow = createCategory(
          db,
          {
            id: subId,
            householdId,
            parentId: rootId,
            name: sub.name,
            kind: spec.kind,
            colorHex: spec.colorHex,
            iconName: sub.iconName,
          },
          {
            ...options,
            batchId: sharedBatchId,
            mutationId: undefined,
          },
        );
        created.push(subRow);
      }
    }
  }

  return created;
}
