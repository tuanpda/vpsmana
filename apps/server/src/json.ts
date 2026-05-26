export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => (typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue))
  );
}
