import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionInfo } from './ConnectionInfo';

afterEach(() => vi.unstubAllGlobals());
describe('server-provided phone setup', () => {
  it('shows the actual server origin and phone setup without sending credentials or inferring camera readiness', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ origin: 'https://192.168.8.8:8443', https: true, phoneSetupUrl: '/phone-setup', publicCaAvailable: true })));
    vi.stubGlobal('fetch', fetcher); const onOrigin = vi.fn();
    render(<ConnectionInfo onOrigin={onOrigin} />);
    expect(await screen.findByText('https://192.168.8.8:8443')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'راهنمای اتصال امن گوشی‌ها' })).toHaveAttribute('href', 'https://192.168.8.8:8443/phone-setup');
    expect(onOrigin).toHaveBeenCalledWith('https://192.168.8.8:8443');
    expect(fetcher).toHaveBeenCalledWith('/api/connection-info', expect.objectContaining({ cache: 'no-store', referrerPolicy: 'no-referrer' }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');
    expect(screen.getByText(/تأیید مجوز دوربین یا قفل/)).toBeInTheDocument();
  });
  it.each([null, { origin: 'javascript:alert(1)' }, { origin: 'https://user:token@host:8443' }, { origin: 'https://host:8443/#token=secret' }])('ignores malformed connection hints without blocking startup: %j', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    render(<ConnectionInfo onOrigin={vi.fn()} />);
    expect(await screen.findByText(/اطلاعات آدرس سرور در دسترس نیست/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('handles a network failure without an unhandled rejection or required setup step', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<ConnectionInfo onOrigin={vi.fn()} />);
    expect(await screen.findByText(/اطلاعات آدرس سرور در دسترس نیست/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
