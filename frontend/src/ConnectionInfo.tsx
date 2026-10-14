import { useEffect, useState } from 'react';

export function ConnectionInfo({ onOrigin }: { onOrigin: (origin: string) => void }) {
  const [info, setInfo] = useState<{ origin: string; https: boolean } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/connection-info', { cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json();
      const origin = new URL(value.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.href !== `${origin.origin}/`) throw new Error('invalid origin');
      if (abort.signal.aborted) return;
      setInfo({ origin: origin.origin, https: origin.protocol === 'https:' && value.https === true });
      onOrigin(origin.origin);
    }).catch(() => { if (!abort.signal.aborted) setUnavailable(true); });
    return () => abort.abort();
  }, [onOrigin]);
  if (!info) return unavailable ? <p className="hint">اطلاعات آدرس سرور در دسترس نیست؛ شروع جلسه همچنان ممکن است. اتصال دو گوشی به آدرس HTTPS معتبر نیاز دارد.</p> : null;
  return <aside className="connection-info"><strong>آدرس این آزمایشگاه برای گوشی‌ها</strong><p dir="ltr">{info.origin}</p>{info.https ? <a href={`${info.origin}/phone-setup`} target="_blank" rel="noreferrer">راهنمای اتصال امن گوشی‌ها</a> : <p className="warning">این آدرس HTTP است؛ برای دوربین روی گوشی از HTTPS معتبر استفاده کنید.</p>}<p className="hint">هر دو گوشی و رایانه باید به سرور دسترسی داشته باشند. نمایش آدرس، تأیید مجوز دوربین یا قفل دستگاه نیست.</p></aside>;
}
