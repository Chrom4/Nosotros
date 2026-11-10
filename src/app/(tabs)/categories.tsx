import { FlashList } from '@shopify/flash-list';
import { and, eq, isNull } from 'drizzle-orm';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  type AppDatabase,
  categories,
  type CategoryKind,
  type CategoryRow,
  createCategory,
  flattenCategoryTree,
  generateUuidV4,
  getActiveDatabase,
  seedDefaultCategories,
  softDeleteCategory,
  updateCategory,
  useReactiveQuery,
} from '@/data';
import { useFiltersStore, useSessionUIStore } from '@/store';

const COLOR_SWATCHES = [
  '#10B981',
  '#6366F1',
  '#F59E0B',
  '#EF4444',
  '#EC4899',
  '#22C55E',
] as const;

export interface CategoriesScreenProps {
  db?: AppDatabase | null;
  householdId?: string | null;
}

export default function CategoriesScreen({
  db: propDb,
  householdId: propHouseholdId,
}: CategoriesScreenProps = {}) {
  const sessionHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);
  const selectedKind = useFiltersStore((s) => s.selectedCategoryKind);
  const setSelectedKind = useFiltersStore((s) => s.setSelectedCategoryKind);

  const db = propDb ?? getActiveDatabase();
  const householdId = propHouseholdId ?? sessionHouseholdId;

  const { data: categoryRows } = useReactiveQuery(
    () =>
      db && householdId
        ? db
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.householdId, householdId),
                isNull(categories.deletedAt),
              ),
            )
        : null,
    [db, householdId],
    ['categories'],
  );

  const flatHierarchy = useMemo(
    () => flattenCategoryTree(categoryRows, selectedKind),
    [categoryRows, selectedKind],
  );

  const rootCategoriesForKind = useMemo(
    () =>
      categoryRows.filter(
        (c) =>
          c.deletedAt === null &&
          c.kind === selectedKind &&
          c.parentId === null,
      ),
    [categoryRows, selectedKind],
  );

  const [editingCategory, setEditingCategory] = useState<CategoryRow | null>(
    null,
  );
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [colorHex, setColorHex] = useState<string>(COLOR_SWATCHES[0]);
  const [iconName, setIconName] = useState('tag');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetForm = () => {
    setEditingCategory(null);
    setName('');
    setParentId(null);
    setColorHex(COLOR_SWATCHES[0]);
    setIconName('tag');
    setErrorMessage(null);
  };

  const handleSelectKind = (kind: CategoryKind) => {
    setSelectedKind(kind);
    resetForm();
  };

  const handleEditSelect = (row: CategoryRow) => {
    setEditingCategory(row);
    setName(row.name);
    setParentId(row.parentId);
    setColorHex(row.colorHex);
    setIconName(row.iconName);
    setErrorMessage(null);
  };

  const handleSaveCategory = () => {
    setErrorMessage(null);
    if (!db || !householdId) {
      setErrorMessage('Banco local ou lar ativo não disponível.');
      return;
    }

    if (!name.trim()) {
      setErrorMessage('Informe o nome da categoria ou subcategoria.');
      return;
    }

    try {
      if (editingCategory) {
        updateCategory(db, editingCategory.id, {
          name: name.trim(),
          parentId,
          colorHex,
          iconName: iconName.trim() || 'tag',
        });
      } else {
        createCategory(db, {
          id: generateUuidV4(),
          householdId,
          parentId,
          name: name.trim(),
          kind: selectedKind,
          colorHex,
          iconName: iconName.trim() || 'tag',
        });
      }
      resetForm();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao salvar categoria.',
      );
    }
  };

  const handleSoftDelete = (categoryId: string) => {
    if (!db) return;
    try {
      softDeleteCategory(db, categoryId);
      if (editingCategory?.id === categoryId) {
        resetForm();
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao remover categoria.',
      );
    }
  };

  const handleSeedDefaults = () => {
    if (!db || !householdId) return;
    try {
      seedDefaultCategories(db, householdId);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Erro ao criar categorias padrão.',
      );
    }
  };

  return (
    <View style={styles.container} testID="categories-screen">
      {/* Seletor de Tipo (Despesas / Receitas) */}
      <View style={styles.kindRow}>
        {(['EXPENSE', 'INCOME'] as const).map((k) => {
          const active = selectedKind === k;
          return (
            <Pressable
              key={k}
              testID={`categories-kind-${k}`}
              style={[styles.kindTab, active && styles.kindTabActive]}
              onPress={() => handleSelectKind(k)}
            >
              <Text
                style={[styles.kindTabText, active && styles.kindTabTextActive]}
              >
                {k === 'EXPENSE' ? 'Despesas' : 'Receitas'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Formulário Hierárquico (Categoria Raiz / Subcategoria) */}
      <View style={styles.formCard}>
        <Text style={styles.formTitle}>
          {editingCategory
            ? 'Editar Categoria'
            : parentId
              ? 'Nova Subcategoria'
              : 'Nova Categoria Raiz'}
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner} testID="categories-error-banner">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            testID="category-name-input"
            style={[styles.input, { flex: 2 }]}
            value={name}
            onChangeText={setName}
            placeholder="Nome (ex.: Alimentação ou Supermercado)"
            placeholderTextColor="#64748B"
          />
          <TextInput
            testID="category-icon-input"
            style={[styles.input, { flex: 1 }]}
            value={iconName}
            onChangeText={setIconName}
            placeholder="Ícone"
            placeholderTextColor="#64748B"
          />
        </View>

        <Text style={styles.subLabel}>Hierarquia (Categoria Pai):</Text>
        <View style={styles.chipRow}>
          <Pressable
            testID="category-parent-NONE"
            style={[styles.chip, parentId === null && styles.chipActive]}
            onPress={() => setParentId(null)}
          >
            <Text
              style={[
                styles.chipText,
                parentId === null && styles.chipTextActive,
              ]}
            >
              Raiz (Principal)
            </Text>
          </Pressable>
          {rootCategoriesForKind
            .filter((root) => root.id !== editingCategory?.id)
            .map((root) => {
              const active = parentId === root.id;
              return (
                <Pressable
                  key={root.id}
                  testID={`category-parent-${root.id}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setParentId(root.id)}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    ↳ {root.name}
                  </Text>
                </Pressable>
              );
            })}
        </View>

        <View style={styles.colorRow}>
          {COLOR_SWATCHES.map((swatch) => {
            const selected = colorHex.toUpperCase() === swatch.toUpperCase();
            return (
              <Pressable
                key={swatch}
                testID={`category-color-${swatch}`}
                style={[
                  styles.colorDot,
                  { backgroundColor: swatch },
                  selected && styles.colorDotSelected,
                ]}
                onPress={() => setColorHex(swatch)}
              />
            );
          })}
        </View>

        <View style={styles.actionRow}>
          <Pressable
            testID="save-category-button"
            style={styles.primaryButton}
            onPress={handleSaveCategory}
          >
            <Text style={styles.primaryButtonText}>
              {editingCategory ? 'Atualizar Categoria' : 'Salvar Categoria'}
            </Text>
          </Pressable>

          {categoryRows.length === 0 ? (
            <Pressable
              testID="seed-default-categories-button"
              style={styles.secondaryButton}
              onPress={handleSeedDefaults}
            >
              <Text style={styles.secondaryButtonText}>
                Criar Categorias Padrão
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Lista Hierárquica Reativa via FlashList */}
      <View style={styles.listWrapper}>
        <FlashList
          data={flatHierarchy}
          keyExtractor={(item) => item.row.id}
          renderItem={({ item }) => (
            <View
              style={[
                styles.categoryItem,
                item.depth === 1 && styles.subcategoryItem,
              ]}
              testID={`category-row-${item.row.id}`}
            >
              <View style={styles.categoryLeft}>
                <View
                  style={[
                    styles.colorBadge,
                    { backgroundColor: item.row.colorHex },
                  ]}
                />
                <View>
                  <Text
                    style={styles.categoryName}
                    testID={`category-label-${item.row.id}`}
                  >
                    {item.depth === 1
                      ? `↳ ${item.row.name}`
                      : item.row.name}
                  </Text>
                  <Text style={styles.categoryMeta}>
                    {item.depth === 1
                      ? `Subcategoria de ${item.parentName}`
                      : 'Categoria Principal'}{' '}
                    • {item.row.iconName}
                  </Text>
                </View>
              </View>

              <View style={styles.rowActions}>
                <Pressable
                  testID={`edit-category-${item.row.id}`}
                  onPress={() => handleEditSelect(item.row)}
                  style={styles.rowBtn}
                >
                  <Text style={styles.editBtnText}>Editar</Text>
                </Pressable>
                <Pressable
                  testID={`delete-category-${item.row.id}`}
                  onPress={() => handleSoftDelete(item.row.id)}
                  style={styles.rowBtn}
                >
                  <Text style={styles.deleteBtnText}>Excluir</Text>
                </Pressable>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="categories-empty-state">
              Nenhuma categoria cadastrada neste grupo.
            </Text>
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 16,
  },
  kindRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  kindTab: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  kindTabActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#6366F1',
  },
  kindTabText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  kindTabTextActive: {
    color: '#FFFFFF',
  },
  formCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
  },
  formTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
  },
  errorBanner: {
    backgroundColor: '#3F1D2E',
    borderColor: '#F43F5E',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 12,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#F8FAFC',
    fontSize: 14,
  },
  subLabel: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  chip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: '#312E81',
    borderColor: '#6366F1',
  },
  chipText: {
    color: '#94A3B8',
    fontSize: 12,
  },
  chipTextActive: {
    color: '#E0E7FF',
    fontWeight: '600',
  },
  colorRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  colorDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorDotSelected: {
    borderColor: '#FFFFFF',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#4F46E5',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '500',
  },
  listWrapper: {
    flex: 1,
  },
  categoryItem: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  subcategoryItem: {
    marginLeft: 20,
    backgroundColor: '#162032',
  },
  categoryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  colorBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  categoryName: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  categoryMeta: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 10,
  },
  rowBtn: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  editBtnText: {
    color: '#818CF8',
    fontSize: 12,
    fontWeight: '600',
  },
  deleteBtnText: {
    color: '#FB7185',
    fontSize: 12,
    fontWeight: '600',
  },
  emptyText: {
    color: '#64748B',
    textAlign: 'center',
    marginTop: 24,
    fontSize: 14,
  },
});
