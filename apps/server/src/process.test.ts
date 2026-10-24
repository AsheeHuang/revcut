import { describe, expect, it } from 'vitest';
import { runProcess } from './process';

const never = new AbortController().signal;

describe('runProcess', () => {
  it('resolves with stdout on exit 0', async () => {
    await expect(runProcess('sh', ['-c', 'echo hi'], { signal: never })).resolves.toMatchObject({ stdout: 'hi\n' });
  });

  it('rejects with stderr on a non-zero exit', async () => {
    await expect(runProcess('sh', ['-c', 'echo bad >&2; exit 3'], { signal: never })).rejects.toThrow(/3.*bad/);
  });

  it('rejects with ENOENT when the command is missing', async () => {
    await expect(runProcess('revcut-no-such-tool', [], { signal: never })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills the child when the signal aborts', async () => {
    const started = Date.now();
    await expect(runProcess('sleep', ['10'], { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
