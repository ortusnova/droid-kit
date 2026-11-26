import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '../src/index';

afterEach(() => vi.restoreAllMocks());

describe('reportError', () => {
  it('logs DK_ERROR, which dk run looks for', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError('render error: boom');
    expect(log).toHaveBeenCalledWith('DK_ERROR render error: boom');
  });

  it('keeps a multi-line message on one log line', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError('render error: boom\n    at Home (home.tsx:3)\n    at Outlet');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain('\n');
    expect(String(log.mock.calls[0]![0])).toMatch(/^DK_ERROR render error: boom \| at Home/);
  });
});
