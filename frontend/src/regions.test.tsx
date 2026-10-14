import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { splitRegion, mergeRegions, newRegion, appendExclusion } from './regions';
import { RegionEditor } from './RegionEditor';

describe('operator ordered geometric segmentation', () => {
  it('splits geometry at explicit coordinate preserving masks without color merging', () => {
    const region = { ...newRegion([[0, 0], [100, 0], [100, 80], [0, 80]], 1), exclusions: [[[5, 5], [10, 5], [10, 10], [5, 10]]] as [number, number][][] };
    const pieces = splitRegion(region, 'vertical', 50);
    expect(pieces.map(p => p.order)).toEqual([1, 2]);
    expect(pieces.every(p => !p.operatorConfirmed)).toBe(true);
    expect(pieces[0].exclusions).toEqual(region.exclusions);
    expect(mergeRegions(pieces[0], pieces[1]).polygon).toEqual([[0, 0], [100, 0], [100, 80], [0, 80]]);
  });
  it('refuses implicit nonadjacent geometric/color similarity merge', () => {
    const a = newRegion([[0, 0], [10, 0], [10, 10], [0, 10]], 1);
    const b = newRegion([[20, 0], [30, 0], [30, 10], [20, 10]], 2);
    expect(() => mergeRegions(a, b)).toThrow();
  });
  it('offers pointer rectangle, polygon, exclusion and marker ROI tools with explicit confirmation', () => {
    const change = vi.fn();
    render(<RegionEditor width={640} height={480} regions={[newRegion([[1, 1], [100, 1], [100, 100], [1, 100]], 1)]} onChange={change} marker={null} onMarker={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'مستطیل' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'چندضلعی' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'قلم حذف' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'نشانگر' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'هندسه و ترتیب این ناحیه را تأیید می‌کنم' }));
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ operatorConfirmed: true })]);
  });
  it('keeps SVG and image source stretched together under responsive dimensions', () => {
    render(<RegionEditor width={864} height={1536} regions={[]} onChange={vi.fn()} marker={null} onMarker={vi.fn()} />);
    expect(screen.getByLabelText('ویرایش ناحیه در مختصات اصلی')).toHaveAttribute('preserveAspectRatio', 'none');
  });
  it('bounds exclusion edits to backend mask limit rather than generating impossible captures', () => {
    const polygon: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(appendExclusion(Array.from({ length: 31 }, () => polygon), polygon)).toHaveLength(32);
    expect(() => appendExclusion(Array.from({ length: 32 }, () => polygon), polygon)).toThrow('۳۲');
  });
});
