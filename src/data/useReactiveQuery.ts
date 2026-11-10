import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useState } from 'react';
import { subscribeToDatabaseChanges } from './db';
import type { SyncableTableName } from './schema';

export interface ReactiveQueryResult<T> {
  readonly data: T[];
  readonly error: Error | undefined;
  readonly updatedAt: Date;
  readonly revision: number;
}

export interface SyncSelectQuery<T> {
  all: () => T[];
  then: PromiseLike<T[]>['then'];
  _: unknown;
}

/**
 * Reactive SQLite query hook combining `useLiveQuery` (`drizzle-orm/expo-sqlite`)
 * with synchronous local evaluation (`< 16ms` perceived update latency on local writes).
 */
export function useReactiveQuery<T>(
  buildQuery: () => SyncSelectQuery<T> | null,
  deps: readonly unknown[] = [],
  watchedTables?: readonly SyncableTableName[],
): ReactiveQueryResult<T> {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToDatabaseChanges((changedTable) => {
      if (!watchedTables || watchedTables.includes(changedTable)) {
        setRevision((r) => r + 1);
      }
    });
    return unsubscribe;
  }, [watchedTables]);

  const query = buildQuery();

  // Wire drizzle-orm/expo-sqlite's native useLiveQuery when a query instance is present
  const liveResult = useLiveQuery(
    (query ??
      ({
        _: {},
        config: { table: {} },
        then: (resolve: (val: T[]) => unknown) => Promise.resolve(resolve([])),
      } as unknown)) as unknown as Parameters<typeof useLiveQuery>[0],
    [...deps, revision],
  );

  let syncData: T[] = [];
  let syncError: Error | undefined;

  if (query) {
    try {
      syncData = query.all();
    } catch (err) {
      syncData = (Array.isArray(liveResult.data) ? liveResult.data : []) as T[];
      syncError = err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    data:
      syncData.length > 0 || !Array.isArray(liveResult.data)
        ? syncData
        : (liveResult.data as T[]),
    error: syncError ?? liveResult.error,
    updatedAt: liveResult.updatedAt ?? new Date(),
    revision,
  };
}
