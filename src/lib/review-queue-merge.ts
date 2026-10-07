export type SheetAuthoritativeScopedMergeOptions<T extends object> = {
  canonicalProgramId: string;
  programId: (row: T) => string;
  exactScopedKey: (row: T) => string;
  authorityMatchKeys: (row: T) => readonly string[];
  mergeAuthorityRow: (sheetRow: T, ledgerRow: T) => T;
  /**
   * Opt-in escape hatch for canonical-program ledger rows that have no sheet
   * counterpart by design (e.g. Portal ingress submissions, which exist only in
   * Firestore). Rows passing this predicate are appended when no sheet row
   * consumed them. Default (absent) keeps the v0.5.34 behavior: canonical
   * ledger-only rows stay hidden.
   */
  appendUnmatchedAuthorityRow?: (row: T) => boolean;
};

function normalized(value: string): string {
  return value.trim();
}

function isSheetAuthorityProgram(programId: string, canonicalProgramId: string): boolean {
  const scopedProgramId = normalized(programId);
  return !scopedProgramId || scopedProgramId === canonicalProgramId;
}

/**
 * Keeps the canonical SCP sheet as the authority for SCP rows while appending
 * Firestore-only rows from every other program. Non-SCP rows are deduplicated
 * only by their caller-provided exact program/application/entity identity.
 */
export function mergeSheetAuthoritativeScopedRows<T extends object>(
  sheetRows: readonly T[],
  ledgerRows: readonly T[],
  options: SheetAuthoritativeScopedMergeOptions<T>,
): T[] {
  const canonicalProgramId = normalized(options.canonicalProgramId);
  const authorityLedgerRows = ledgerRows.filter((row) => (
    isSheetAuthorityProgram(options.programId(row), canonicalProgramId)
  ));
  const authorityByMatchKey = new Map<string, T | null>();

  for (const row of authorityLedgerRows) {
    for (const rawKey of options.authorityMatchKeys(row)) {
      const key = normalized(rawKey);
      if (!key) continue;
      if (!authorityByMatchKey.has(key)) {
        authorityByMatchKey.set(key, row);
      } else if (authorityByMatchKey.get(key) !== row) {
        // A fallback key shared by multiple ledger rows is ambiguous. The sheet
        // row stays untouched instead of inheriting another application's state.
        authorityByMatchKey.set(key, null);
      }
    }
  }

  const consumedAuthorityRows = new Set<T>();
  const mergedSheetRows = sheetRows.map((sheetRow) => {
    if (!isSheetAuthorityProgram(options.programId(sheetRow), canonicalProgramId)) return sheetRow;
    for (const rawKey of options.authorityMatchKeys(sheetRow)) {
      const key = normalized(rawKey);
      if (!key) continue;
      const ledgerRow = authorityByMatchKey.get(key);
      if (ledgerRow) {
        consumedAuthorityRows.add(ledgerRow);
        return options.mergeAuthorityRow(sheetRow, ledgerRow);
      }
    }
    return sheetRow;
  });

  // Canonical-program ledger rows that no sheet row consumed and that the
  // caller explicitly marked as standalone (Portal ingress). Exact-key
  // deduplication guards against a sheet row racing in the same identity.
  const appendedAuthorityRows: T[] = [];
  if (options.appendUnmatchedAuthorityRow) {
    const authorityExactKeys = new Set(
      mergedSheetRows
        .filter((row) => isSheetAuthorityProgram(options.programId(row), canonicalProgramId))
        .map(options.exactScopedKey)
        .map(normalized)
        .filter(Boolean),
    );
    for (const row of authorityLedgerRows) {
      if (consumedAuthorityRows.has(row)) continue;
      if (!options.appendUnmatchedAuthorityRow(row)) continue;
      const exactKey = normalized(options.exactScopedKey(row));
      if (exactKey) {
        if (authorityExactKeys.has(exactKey)) continue;
        authorityExactKeys.add(exactKey);
      }
      appendedAuthorityRows.push(row);
    }
  }

  const exactKeys = new Set(
    mergedSheetRows
      .filter((row) => !isSheetAuthorityProgram(options.programId(row), canonicalProgramId))
      .map(options.exactScopedKey)
      .map(normalized)
      .filter(Boolean),
  );
  const appendedRows: T[] = [];
  for (const row of ledgerRows) {
    if (isSheetAuthorityProgram(options.programId(row), canonicalProgramId)) continue;
    const exactKey = normalized(options.exactScopedKey(row));
    if (!exactKey) {
      // Invalid legacy rows must remain visible for repair, but they are never
      // allowed to collapse a valid row from another program.
      appendedRows.push(row);
      continue;
    }
    if (exactKeys.has(exactKey)) continue;
    exactKeys.add(exactKey);
    appendedRows.push(row);
  }

  return [...mergedSheetRows, ...appendedAuthorityRows, ...appendedRows];
}
