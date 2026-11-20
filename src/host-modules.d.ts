// Modules provided by the OpenCode host at runtime (not installed here).
// Only the members the status line uses are declared.
declare module "solid-js" {
  export function createSignal<T>(value: T): [() => T, (value: T) => void];
}
declare module "@opentui/solid" {
  export function createElement(tag: string): unknown;
  export function setProp(node: unknown, name: string, value: unknown): void;
  export function insert(parent: unknown, accessor: () => unknown): void;
}
