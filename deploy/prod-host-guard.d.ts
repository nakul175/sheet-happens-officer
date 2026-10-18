export function productionTarget(env?: NodeJS.ProcessEnv): boolean;
export function readonlySmoke(argv: readonly string[]): boolean;
export function zzTestRequested(env?: NodeJS.ProcessEnv, argv?: readonly string[]): boolean;
export function assertProdHostGuard(argv?: readonly string[], env?: NodeJS.ProcessEnv): void;
export function assertProdSeed(env?: NodeJS.ProcessEnv, label?: string): void;
