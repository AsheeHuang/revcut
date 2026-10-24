import { spawn } from 'node:child_process';

export function runProcess(
  command: string,
  args: string[],
  { signal }: { signal: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} 結束代碼 ${code}：${stderr.trim().slice(-500)}`));
    });
  });
}
