import { diagnosticTrace } from './trace';
export type Mode = 'threeStage' | 'catalogOnly' | 'replay' | 'cameraMatch';
export type Role = 'camera' | 'display';
export type Credentials = { sessionId: string; token: string; role: Role };
export type SessionCreated = { sessionId: string; cameraToken: string; displayToken: string; expiresAt: string; state: string; profileVersion: number };
export type Snapshot = { state: string; profileVersion: number; paused: boolean; pauseReason?: string; measurements?: Record<string, unknown>[]; cameraProfile?: Record<string, unknown>; displayProfile?: Record<string, unknown>; currentPatch?: Patch | null; [key: string]: unknown };
export type LivePreviewBand = { id: string; drive: [number, number, number]; top: number; bottom: number };
export type ScreenAppearanceBand = { id: string; rgb: [number, number, number]; validPixels: number; validBlocks: number; blockSpread: number; clippedRate: number };
export type LivePreviewFeedback = { commandSequence: number; patchId: string; markerPixels: number[][]; screenRoi: [number, number][]; stable: true; screenAppearanceBands: ScreenAppearanceBand[] };
export type LivePreviewInput = { streamId: string; bands: LivePreviewBand[]; mapping: 'screenAligned' | 'orderedPreview'; sourceFrame: { mediaTime: number; presentedFrames: number; width: number; height: number }; warnings: string[];fingerprint?:string;canvasColorSpace?:'srgb'|'display-p3';cameraAppearanceColorSpace?:'srgb'|'display-p3';feedback?:LivePreviewFeedback };
export type PreviewCompensation = { status: 'cameraReferencedExperimental' | 'notCompensated' | 'measuredFeedbackExperimental' | 'partiallyCompensatedExperimental'; label?: string; warnings?: string[]; feedbackApplied?: boolean; perBand?: { id: string; status: string; drive?: [number, number, number]; method?: string; residualBefore?: number | null; residualAfter?: null; saturated?: boolean; stalledIterations?: number; warnings?: string[]; physicalAccuracyVerified?: false }[] };
export type Patch = { patchId: string; commandSequence: number; displayDriveRgb: [number, number, number]; profileVersion: number; layout: 'single' | 'group' | 'liveBands'; sampleIds: string[]; renderedAt?: number; rendered?: boolean; patches?: { sampleId: string; drive: [number, number, number] }[]; groupStatus?: string; bands?: LivePreviewBand[]; mapping?: LivePreviewInput['mapping']; purpose?: 'cameraAppearancePreview'; streamId?: string; sourceFrame?: LivePreviewInput['sourceFrame']; warnings?: string[];compensation?:PreviewCompensation };

export function consumeJoin(url: URL, replace: (path: string) => void): Credentials | null {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const sessionId = fragment.get('session');
  const token = fragment.get('token');
  if (url.hash) replace(url.pathname);
  if (!sessionId || !token || url.pathname !== '/display') return null;
  return { sessionId, token, role: 'display' };
}
export function joinUrl(origin: string, sessionId: string, token: string) {
  return `${origin}/display#${new URLSearchParams({ session: sessionId, token })}`;
}

export class Api {
  constructor(public sessionId: string, private fetcher: typeof fetch = fetch, private token = '') {}
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const multipart = body instanceof FormData;
    const encoded = body === undefined || multipart ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).byteLength > 16 * 1024 * 1024) throw new Error('حجم داده از سقف ۱۶ مگابایت عبور کرد؛ ناحیه‌ها و مرجع را کاهش دهید.');
    const endpoint = path.startsWith('/api/sessions/') ? path.split('/').slice(4).map(part=>/^\d+$/.test(part)?':id':part).filter(part=>['camera-matches','matches','observe','camera-profile','display-profile','neutral-check','reference','measurements','captures','analyze','regions','export','conditions','validations','override','images','response-profile','start','invert','live-preview'].includes(part.split('?')[0])).map(part=>part.split('?')[0]).join('/') || 'session' : path==='/api/sessions'?'sessions':'other';
    const started=performance.now();
    diagnosticTrace.add('api','request',{method,endpoint,bytes:encoded?new TextEncoder().encode(encoded).byteLength:undefined});
    let response:Response;
    try { response = await this.fetcher.call(globalThis, path, {
      method, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : encoded }),
      cache: 'no-store', referrerPolicy: 'no-referrer',
    }); } catch(error) { diagnosticTrace.add('api','networkError',{method,endpoint,elapsedMs:Math.round(performance.now()-started)});throw error; }
    diagnosticTrace.add('api','response',{method,endpoint,status:response.status,elapsedMs:Math.round(performance.now()-started)});
    if (!response.ok) {
      const nextActions: Record<string, string> = {
        response_valid_profile_required:'ابتدا پاسخ نمایشگر را اندازه بگیرید؛ مدل قبلی وجود ندارد یا شرایط تغییر کرده است.',
        response_out_of_support:'رنگ هدف بیرون از پوشش مدل اندازه‌گیری‌شده است؛ فرمان جبران‌شده صادر نشد. این به‌تنهایی اثبات خارج‌بودن از گاموت واقعی نیست.',
        response_native_roi_changed:'کادر کارت یا صفحه تغییر کرده است؛ گوشی و کارت را ثابت و اندازه‌گیری پاسخ را دوباره شروع کنید.',
        response_conditions_or_stream_changed:'تنظیم دوربین، ابعاد یا فضای رنگ با مدل پاسخ متفاوت است؛ پاسخ نمایشگر باید دوباره اندازه‌گیری شود.',
        response_neutral_witness_drift:'کارت شاهد در فرمان‌های صفحه ثابت نمانده؛ نور، بازتاب و پردازش خودکار دوربین را بررسی کنید.',
        response_relative_capture_quality_rejected:'کیفیت برداشت صفحه یا کارت مناسب نیست؛ سایه، بافت، بازتاب یا clipping را بررسی کنید.',
        response_normalized_rgb_validation_failed:'مدل پاسخ نمایشگر در رنگ‌های ارزیابی قبول نشد؛ جبران فعال نشده است.',
        fabric_target_drift: 'پارچه یا نور آن تغییر کرده است. پارچه و گوشی‌ها را ثابت نگه دارید و سنجش خودکار را دوباره شروع کنید.',
        unstable_witness: 'نور یا شاهد تغییر می‌کند. سایهٔ دست را کنار ببرید و گوشی‌ها را ثابت نگه دارید.',
        unstable_match_card: 'کارت مرجع در تصویر ثابت نیست. کارت و دوربین را ثابت نگه دارید.',
        display_contamination_rejected: 'نور صفحه روی شاهد اثر گذاشته است. صفحه را کمی از کارت و پارچه دور کنید یا مانع مات قرار دهید.',
        fabric_contamination_rejected: 'نور صفحه رنگ مشاهده‌شدهٔ پارچه را تغییر می‌دهد. صفحه را کمی دورتر بگذارید و نور محیط را ثابت کنید.',
        marker_mismatch: 'نوار سیاه‌وسفید صفحهٔ گوشی A را کامل و مستقیم داخل قاب دوربین B قرار دهید.',
        live_marker_required: 'نوار سیاه‌وسفید گوشی A دیده نمی‌شود. تمام صفحهٔ گوشی A را داخل قاب قرار دهید.',
        fresh_rendered_command_required: 'پاسخ صفحهٔ گوشی A نرسیده است. اتصال هر دو گوشی را بررسی کنید و صفحهٔ A را باز نگه دارید.',
        active_camera_required: 'دوربین یا جلسه متوقف است. دوربین را باز کنید و پس از ثابت‌کردن چیدمان ادامه دهید.',
        actual_video_identity_required: 'این مرورگر فریم تازهٔ دوربین را تأیید نمی‌کند. از مرورگر سازگارِ به‌روز روی گوشی B استفاده کنید.',
        settings_fingerprint_changed: 'تنظیم دوربین تغییر کرده است. گوشی و نور را ثابت کنید؛ سنجش قبلی باید دوباره انجام شود.',
        token_expired: 'جلسه منقضی شده است. جلسهٔ جدید بسازید و گوشی A را با QR تازه وصل کنید.',
        engine_busy: 'یک پردازش دیگر هنوز در حال اجراست. پس از پایان آن، شروع خودکار را بزنید.',
        accepted_measurement_required: 'کیفیت این نمونه برای تطبیق کافی نیست. چین، بازتاب یا سایه را از قاب پارچه کنار بزنید.',
      };
      let detail: unknown;
      try { detail = (await response.json()).detail; } catch { /* Never expose arbitrary server bodies. */ }
      if (response.status === 409 && path.endsWith('/live-preview') && (detail === 'preview_feedback_stale_command' || detail === 'preview_feedback_context_changed' || detail === 'preview_feedback_expired')) {
        diagnosticTrace.add('api', 'rejected', { method, endpoint, status: 409, code: detail });
        throw Object.assign(new Error('فرمان بازخورد تغییر کرد؛ منتظر قاب واقعی بعدی هستیم.'), { status: 409, code: detail });
      }
      if(response.status===409&&detail&&typeof detail==='object'&&'code' in detail&&detail.code==='preview_rate_limit'){
        const retry='retryAfterMs' in detail&&typeof detail.retryAfterMs==='number'&&Number.isFinite(detail.retryAfterMs)?Math.max(0,Math.min(5000,detail.retryAfterMs)):500;
        diagnosticTrace.add('api','rejected',{method,endpoint,status:409,code:'preview_rate_limit'});
        throw Object.assign(new Error('شبکه به کمی فاصله نیاز دارد؛ جدیدترین قاب دوباره ارسال می‌شود.'),{code:'preview_rate_limit',retryAfterMs:retry,status:409});
      }
      const safeCodes=new Set([...Object.keys(nextActions),'neutral_card_quality_rejected','neutral_card_order_ambiguous','live_neutral_cards_required','neutral_card_geometry_changed','co_captured_neutral_cards_required','three_distinct_neutral_cards_required','quality_rejected','origin_mismatch','invalid_token','session_paused','stage_order','reused_actual_capture','frame_reused','measurement_invalidated']);
      diagnosticTrace.add('api','rejected',{method,endpoint,status:response.status,code:typeof detail==='string'&&safeCodes.has(detail)?detail:'unclassified',validationErrors:Array.isArray(detail)?detail.length:0});
      throw new Error(`${typeof detail === 'string' && Object.hasOwn(nextActions, detail) ? nextActions[detail] : 'عملیات انجام نشد؛ پیام وضعیت و اتصال دو گوشی را بررسی کنید.'} (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    if (path.includes('/export?')) return await response.text() as T;
    return await response.json() as T;
  }
  create(mode: Mode, conditions: Record<string, unknown>) { return this.request<SessionCreated>('/api/sessions', 'POST', { mode, conditions }); }
  get() { return this.request<Snapshot>(`/api/sessions/${encodeURIComponent(this.sessionId)}`); }
  post<T>(route: string, body: unknown) { return this.request<T>(`/api/sessions/${encodeURIComponent(this.sessionId)}/${route}`, 'POST', body); }
  conditions(conditions: Record<string, unknown>) { return this.request<Snapshot>(`/api/sessions/${encodeURIComponent(this.sessionId)}/conditions`, 'PATCH', { conditions }); }
  export(format: 'json' | 'csv', kind: 'experimental' | 'approved') { return this.request<string>(`/api/sessions/${encodeURIComponent(this.sessionId)}/export?format=${format}&kind=${kind}`); }
  delete() { return this.request<void>(`/api/sessions/${encodeURIComponent(this.sessionId)}`, 'DELETE'); }
}
