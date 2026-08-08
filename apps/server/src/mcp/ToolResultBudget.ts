export const MODEL_RESULT_LIMITS = {
  previewVisibleTextChars: 12_000,
  previewInteractiveElements: 100,
  previewAccessibilityTreeChars: 16_000,
  previewHistoryEntries: 50,
  supabaseRows: 200,
  supabaseChars: 32_000,
} as const;

export interface ModelResultEnvelope<Value> {
  readonly value: Value;
  readonly truncated: boolean;
  readonly omittedCount: number;
  readonly continuation?: string;
}

const continuation = (kind: string): string =>
  `Result truncated for model context. Narrow the ${kind} or request a smaller page to continue.`;

export const capText = (value: string, maxChars: number): ModelResultEnvelope<string> => {
  if (value.length <= maxChars) {
    return { value, truncated: false, omittedCount: 0 };
  }
  return {
    value: value.slice(0, maxChars),
    truncated: true,
    omittedCount: value.length - maxChars,
    continuation: continuation("query"),
  };
};

export const capNewest = <Value>(
  values: ReadonlyArray<Value>,
  maxEntries: number,
): ModelResultEnvelope<ReadonlyArray<Value>> => {
  if (values.length <= maxEntries) {
    return { value: values, truncated: false, omittedCount: 0 };
  }
  return {
    value: values.slice(-maxEntries),
    truncated: true,
    omittedCount: values.length - maxEntries,
    continuation: continuation("history range"),
  };
};

export const capFirst = <Value>(
  values: ReadonlyArray<Value>,
  maxEntries: number,
): ModelResultEnvelope<ReadonlyArray<Value>> => {
  if (values.length <= maxEntries) {
    return { value: values, truncated: false, omittedCount: 0 };
  }
  return {
    value: values.slice(0, maxEntries),
    truncated: true,
    omittedCount: values.length - maxEntries,
    continuation: continuation("result range"),
  };
};

const capArrays = (value: unknown, maxRows: number): { value: unknown; omittedCount: number } => {
  if (Array.isArray(value)) {
    const selected = value.slice(0, maxRows).map((entry) => capArrays(entry, maxRows));
    return {
      value: selected.map((entry) => entry.value),
      omittedCount:
        Math.max(0, value.length - maxRows) +
        selected.reduce((total, entry) => total + entry.omittedCount, 0),
    };
  }
  if (value === null || typeof value !== "object") return { value, omittedCount: 0 };
  const entries = Object.entries(value).map(([key, nested]) => {
    const capped = capArrays(nested, maxRows);
    return { key, ...capped };
  });
  return {
    value: Object.fromEntries(entries.map(({ key, value: nested }) => [key, nested])),
    omittedCount: entries.reduce((total, entry) => total + entry.omittedCount, 0),
  };
};

export const capOpaqueResult = (
  value: unknown,
  options: { readonly maxChars: number; readonly maxRows?: number },
): ModelResultEnvelope<unknown> => {
  const rowCapped =
    options.maxRows === undefined ? { value, omittedCount: 0 } : capArrays(value, options.maxRows);
  const serialized = JSON.stringify(rowCapped.value);
  if (serialized === undefined) {
    return { value: null, truncated: true, omittedCount: 1, continuation: continuation("result") };
  }
  if (serialized.length <= options.maxChars) {
    return {
      value: rowCapped.value,
      truncated: rowCapped.omittedCount > 0,
      omittedCount: rowCapped.omittedCount,
      ...(rowCapped.omittedCount > 0 ? { continuation: continuation("row range") } : {}),
    };
  }
  return {
    value: serialized.slice(0, options.maxChars),
    truncated: true,
    omittedCount: rowCapped.omittedCount + serialized.length - options.maxChars,
    continuation: continuation("query"),
  };
};
