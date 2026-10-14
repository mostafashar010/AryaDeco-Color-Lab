export const startupKey = 'colorlab.startup.v1';
export const conditionFields = [['illumination', 'نور محیط'], ['cameraModel', 'مدل دوربین B'], ['displayModel', 'مدل نمایشگر A'], ['displayBrightness', 'روشنایی نمایشگر'], ['background', 'پس‌زمینه'], ['layers', 'تعداد لایه'], ['distance', 'فاصله دوربین'], ['referenceCard', 'کارت مرجع']] as const;
export type Conditions = Record<(typeof conditionFields)[number][0], string | null>;

export function cleanConditions(value: unknown): Conditions {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(conditionFields.map(([key]) => {
    const text = typeof source[key] === 'string' ? source[key].trim().slice(0, 256) : '';
    return [key, text || null];
  })) as Conditions;
}

export function loadStartup(): { conditions: Conditions; restored: boolean; notice: string } {
  const empty = { conditions: cleanConditions(null), restored: false, notice: '' };
  try {
    const raw = localStorage.getItem(startupKey);
    if (raw === null) return empty;
    if (raw.length > 4096) throw new Error('oversized');
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || !saved.conditions || typeof saved.conditions !== 'object' || Array.isArray(saved.conditions)) throw new Error('unsupported');
    const conditions = cleanConditions(saved.conditions);
    return { conditions, restored: Object.values(conditions).some(value => value !== null), notice: '' };
  } catch {
    return { ...empty, notice: 'تنظیمات ذخیره‌شده قابل خواندن نیست یا ذخیره‌سازی مرورگر در دسترس نیست؛ می‌توانید بدون آن شروع کنید.' };
  }
}

export function storeStartup(conditions: Conditions | null): string {
  try {
    if (conditions === null) localStorage.removeItem(startupKey);
    else localStorage.setItem(startupKey, JSON.stringify({ version: 1, conditions: cleanConditions(conditions) }));
    return conditions === null ? 'تنظیمات این مرورگر پاک شد؛ جلسه‌ها و اندازه‌گیری‌ها حذف نشدند.' : '';
  } catch {
    return 'ذخیره یا پاک‌کردن تنظیمات مرورگر ممکن نشد؛ جلسه بدون ذخیره‌سازی ادامه دارد.';
  }
}
