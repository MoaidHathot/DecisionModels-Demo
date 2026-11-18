import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { AppConfig, ExecutionOutput, ModelEntry } from '../shared/types.ts';

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderCommand(template: string, inputPath: string): string {
  return template.replaceAll('{input}', quotePowerShell(inputPath));
}

export function powershellScript(command: string): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$global:LASTEXITCODE = 0
try {
  & {
${command}
  }
  $commandSucceeded = $?
  if ($global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }
  if (-not $commandSucceeded) { exit 1 }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`;
}

export async function runCommand(options: {
  config: AppConfig;
  entry: ModelEntry;
  command: string;
  signal: AbortSignal;
  onProgress?: (line: string) => void;
}): Promise<ExecutionOutput> {
  const { config, entry, command, signal, onProgress } = options;
  if (signal.aborted) return { stdout: '', stderr: '', exitCode: null, signal: null, wallMs: 0, error: 'Cancelled.', cancelled: true, timedOut: false };
  const args = ['-NoLogo', '-NonInteractive', '-OutputFormat', 'Text'];
  if (!entry.loadProfile) args.push('-NoProfile');
  args.push('-EncodedCommand', Buffer.from(powershellScript(command), 'utf16le').toString('base64'));

  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(config.shell.executable, args, {
      cwd: entry.workingDirectory,
      env: { ...process.env, NO_COLOR: '1', ...entry.env },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let error: string | null = null;
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let lastProgressAt = 0;

    function finish(exitCode: number | null, exitSignal: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(closeTimer);
      signal.removeEventListener('abort', abort);
      resolve({ stdout, stderr, exitCode, signal: exitSignal, wallMs: performance.now() - started, error, cancelled, timedOut });
    }

    function stop() {
      if (stopping || settled) return;
      stopping = true;
      if (child.pid) {
        if (process.platform === 'win32') {
          // Terminate the CLI's descendants too (dnx, Node, Python), not just PowerShell.
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill('SIGKILL'));
          killer.on('exit', (code) => { if (code !== 0 && !settled) child.kill('SIGKILL'); });
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          forceTimer = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }, 1000);
        }
      }
      // Detached grandchildren can keep inherited output handles open after their parent exits.
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 5000);
    }

    function abort() {
      cancelled = true;
      error = 'Cancelled.';
      stop();
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      error = `Timed out after ${(entry.timeoutMs / 1000).toFixed(1)} seconds.`;
      stop();
    }, entry.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    function collect(chunk: string, stream: 'stdout' | 'stderr') {
      const size = Buffer.byteLength(chunk, 'utf8');
      if (bytes + size > MAX_OUTPUT_BYTES) {
        error ??= 'Command output exceeded the 1 MiB limit.';
        stop();
        return;
      }
      bytes += size;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stream === 'stderr' && performance.now() - lastProgressAt > 150) {
        const line = stripVTControlCharacters(chunk).split(/[\r\n]/).filter((part) => part.trim()).at(-1)?.trim();
        if (line) {
          lastProgressAt = performance.now();
          onProgress?.(line.slice(0, 240));
        }
      }
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => collect(chunk, 'stderr'));
    child.on('error', (cause) => {
      error = `Could not launch ${config.shell.executable}: ${cause.message}`;
      finish(null, null);
    });
    child.on('close', (code, exitSignal) => finish(code, exitSignal));
  });
}
