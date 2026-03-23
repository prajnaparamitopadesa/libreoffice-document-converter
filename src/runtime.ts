interface ProcessVersionsLike {
  node?: string;
  bun?: string;
}

interface ProcessLike {
  argv?: string[];
  execPath?: string;
  versions?: ProcessVersionsLike;
}

export const DEFAULT_BUN_SUBPROCESS_FLAG = '--libreoffice-bun-subprocess';

function getProcessVersions(proc?: ProcessLike): ProcessVersionsLike | undefined {
  return proc?.versions;
}

export function isBunRuntime(proc?: ProcessLike): boolean {
  return Boolean(getProcessVersions(proc)?.bun);
}

export function isNodeRuntime(proc?: ProcessLike): boolean {
  const versions = getProcessVersions(proc);
  return Boolean(versions?.node) && !versions?.bun;
}

export function shouldUseSubprocessConversion(proc?: ProcessLike): boolean {
  return isNodeRuntime(proc);
}

export interface BunSelfSpawnCommandOptions {
  argv?: string[];
  execPath?: string;
  entrypoint?: string;
  workerFlag?: string;
  workerArgs?: string[];
}

export function isBunSubprocessEntrypoint(
  argv: string[] = [],
  workerFlag = DEFAULT_BUN_SUBPROCESS_FLAG
): boolean {
  return argv.includes(workerFlag);
}

export function getBunSelfSpawnCommand({
  argv = [],
  execPath,
  entrypoint,
  workerFlag = DEFAULT_BUN_SUBPROCESS_FLAG,
  workerArgs = [],
}: BunSelfSpawnCommandOptions): string[] {
  if (!execPath) {
    throw new Error('execPath is required to spawn a Bun subprocess');
  }

  const inferredEntrypoint = entrypoint ?? argv[1];
  const isCompiledExecutable = argv.length <= 1 || inferredEntrypoint === execPath;

  if (isCompiledExecutable) {
    return [execPath, workerFlag, ...workerArgs];
  }

  if (!inferredEntrypoint) {
    throw new Error('entrypoint is required when spawning a Bun script');
  }

  return [execPath, inferredEntrypoint, workerFlag, ...workerArgs];
}
