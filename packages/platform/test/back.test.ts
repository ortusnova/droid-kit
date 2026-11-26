import { describe, expect, it, vi } from 'vitest';
import { pushBackInterceptor, runBackInterceptor } from '../src/back';

describe('back interceptors', () => {
  it('leaves back alone when no overlay is open', () => {
    expect(runBackInterceptor()).toBe(false);
  });

  it('gives back to the topmost overlay only', () => {
    const sheet = vi.fn();
    const panel = vi.fn();
    const removeSheet = pushBackInterceptor(sheet);
    const removePanel = pushBackInterceptor(panel);
    expect(runBackInterceptor()).toBe(true);
    expect(panel).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
    removePanel();
    expect(runBackInterceptor()).toBe(true);
    expect(sheet).toHaveBeenCalledTimes(1);
    removeSheet();
    expect(runBackInterceptor()).toBe(false);
  });

  it('removes an overlay that closed out of order', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const removeLower = pushBackInterceptor(lower);
    const removeUpper = pushBackInterceptor(upper);
    removeLower();
    expect(runBackInterceptor()).toBe(true);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    removeUpper();
    expect(runBackInterceptor()).toBe(false);
  });

  it('ignores a second removal', () => {
    const a = vi.fn();
    const remove = pushBackInterceptor(a);
    remove();
    remove();
    expect(runBackInterceptor()).toBe(false);
  });
});
