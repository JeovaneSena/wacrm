'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RotateCcw,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

type Phase = 'loading' | 'setup' | 'pairing' | 'connected' | 'error';

interface ConfigState {
  server_url: string;
  status: string;
  owner: string | null;
  profileName: string | null;
}

// Poll cadence while a QR is on screen. uazapi's WhatsApp pairing
// session is short-lived — re-issuing /connect keeps the code fresh
// without the user having to click anything.
const POLL_MS = 3000;
const QR_REFRESH_MS = 25000;

/** Admin-gated wrapper — agents/viewers previously saw editable-looking
 *  controls that only failed at save time (RLS). Now they get a clear
 *  notice instead, matching the other admin-only settings panels. */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsappSetup');
  return (
    <RequireRole
      min="admin"
      fallback={
        <div className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          {t('adminOnlyNotice')}
        </div>
      }
    >
      <WhatsAppConfigInner />
    </RequireRole>
  );
}

function WhatsAppConfigInner() {
  const t = useTranslations('Settings.whatsappSetup');
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [resetting, setResetting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Setup form (first-time connection)
  const [serverUrl, setServerUrl] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [instanceToken, setInstanceToken] = useState('');
  const [useExistingToken, setUseExistingToken] = useState(false);

  // Pairing state
  const [qrcode, setQrcode] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (refreshRef.current) clearInterval(refreshRef.current);
    pollRef.current = null;
    refreshRef.current = null;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/status');
      const data = await res.json();

      if (!data.configured) {
        setPhase('setup');
        return;
      }

      if (data.status === 'connected') {
        stopTimers();
        setConfig({
          server_url: config?.server_url ?? '',
          status: 'connected',
          owner: data.owner ?? null,
          profileName: data.profileName ?? null,
        });
        setQrcode(null);
        setPhase('connected');
        return;
      }

      // Still pairing (or freshly disconnected) — keep/refresh the QR.
      if (data.qrcode) setQrcode(data.qrcode);
      setPhase('pairing');
    } catch (err) {
      console.error('WhatsApp status check failed:', err);
    }
  }, [config?.server_url, stopTimers]);

  const startPolling = useCallback(() => {
    stopTimers();
    pollRef.current = setInterval(fetchStatus, POLL_MS);
    // uazapi QR codes go stale before the pairing window closes;
    // periodically re-issue /connect so the on-screen code stays
    // scannable without the user having to click "Generate QR" again.
    refreshRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/connect', { method: 'POST' });
        const data = await res.json();
        if (data.qrcode) setQrcode(data.qrcode);
      } catch (err) {
        console.error('QR refresh failed:', err);
      }
    }, QR_REFRESH_MS);
  }, [fetchStatus, stopTimers]);

  const loadInitial = useCallback(async (acctId: string) => {
    setPhase('loading');
    try {
      const res = await fetch('/api/whatsapp/config');
      const data = await res.json();

      if (!data.connected && data.reason === 'no_config') {
        setPhase('setup');
        return;
      }
      if (!data.connected && data.reason === 'token_corrupted') {
        setErrorMessage(data.message || t('errTokenCorrupted'));
        setPhase('error');
        return;
      }
      if (!data.connected) {
        // Instance exists but isn't paired — jump straight into the QR flow.
        setConfig({ server_url: '', status: 'disconnected', owner: null, profileName: null });
        setPhase('pairing');
        startPolling();
        await fetchStatus();
        return;
      }

      setConfig({
        server_url: '',
        status: 'connected',
        owner: data.instance?.owner ?? null,
        profileName: data.instance?.profileName ?? null,
      });
      setPhase('connected');
    } catch (err) {
      console.error('loadInitial failed:', err);
      setErrorMessage(t('errServerUnreachable'));
      setPhase('error');
    }
    void acctId;
  }, [fetchStatus, startPolling]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    loadInitial(accountId);
    return () => stopTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profileLoading, user?.id, accountId]);

  async function handleCreateInstance() {
    if (!serverUrl.trim()) {
      toast.error(t('errServerUrl'));
      return;
    }
    if (useExistingToken && !instanceToken.trim()) {
      toast.error(t('errInstanceToken'));
      return;
    }
    if (!useExistingToken && !adminToken.trim()) {
      toast.error(t('errAdminToken'));
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = { server_url: serverUrl.trim() };
      if (useExistingToken) {
        payload.instance_token = instanceToken.trim();
      } else {
        payload.admin_token = adminToken.trim();
        payload.instance_name = 'senacrm';
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('errSave'));
        return;
      }

      // An adopted token may belong to an instance that's already
      // paired on the uazapi side — no QR needed, jump straight to
      // connected instead of forcing a pointless re-scan.
      if (data.status === 'connected') {
        toast.success(t('savedAlreadyConnected'));
        setConfig({
          server_url: serverUrl.trim(),
          status: 'connected',
          owner: data.owner ?? null,
          profileName: data.profileName ?? null,
        });
        setPhase('connected');
        return;
      }

      toast.success(t('savedScan'));
      setConfig({ server_url: serverUrl.trim(), status: 'disconnected', owner: null, profileName: null });
      await handleGenerateQr();
    } catch (err) {
      console.error('Create instance error:', err);
      toast.error(t('errSave'));
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateQr() {
    setPhase('pairing');
    try {
      const res = await fetch('/api/whatsapp/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('errPairing'));
        setPhase('error');
        setErrorMessage(data.error || t('errPairing'));
        return;
      }
      // The connect route short-circuits with `connected` when the
      // instance is already paired — no QR to render, skip polling.
      if (data.status === 'connected') {
        setPhase('connected');
        return;
      }
      if (data.qrcode) setQrcode(data.qrcode);
      startPolling();
    } catch (err) {
      console.error('Connect error:', err);
      toast.error(t('errPairing'));
    }
  }

  async function handleReset() {
    if (!confirm(t('confirmReset'))) {
      return;
    }
    setResetting(true);
    stopTimers();
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('errReset'));
        return;
      }
      toast.success(t('disconnected'));
      setConfig(null);
      setQrcode(null);
      setServerUrl('');
      setAdminToken('');
      setInstanceToken('');
      setPhase('setup');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('errReset'));
    } finally {
      setResetting(false);
    }
  }

  if (phase === 'loading') {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('panelTitle')} description={t('panelDesc')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('panelTitle')} description={t('panelDesc')} />

      <div className="max-w-xl space-y-6">
        {phase === 'connected' && (
          <>
            <Alert className="bg-emerald-950/30 border-emerald-700/50">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-400" />
                <AlertTitle className="text-emerald-200 mb-0">{t('connected')}</AlertTitle>
              </div>
              <AlertDescription className="text-muted-foreground">
                {config?.owner
                  ? t('pairedWith', { who: config.profileName ? `${config.profileName} · ${config.owner}` : config.owner })
                  : t('connectedReady')}
              </AlertDescription>
            </Alert>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              {t('disconnect')}
            </Button>
          </>
        )}

        {phase === 'pairing' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <QrCode className="size-5" /> {t('scanTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('scanDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              {qrcode ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrcode} alt={t('qrAlt')} className="size-64 rounded-lg border border-border" />
              ) : (
                <div className="flex size-64 items-center justify-center rounded-lg border border-border">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Smartphone className="size-3.5" /> {t('waitingScan')}
              </p>
              <Button variant="outline" size="sm" onClick={handleGenerateQr}>
                {t('refreshQr')}
              </Button>
            </CardContent>
          </Card>
        )}

        {phase === 'setup' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('setupTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('setupDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('serverUrlLabel')}</Label>
                <Input
                  placeholder="https://your-server.uazapi.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setUseExistingToken(false)}
                  className={`rounded px-2 py-1 ${!useExistingToken ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                >
                  {t('createNew')}
                </button>
                <button
                  type="button"
                  onClick={() => setUseExistingToken(true)}
                  className={`rounded px-2 py-1 ${useExistingToken ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                >
                  {t('useExisting')}
                </button>
              </div>

              {!useExistingToken ? (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('adminTokenLabel')}</Label>
                  <Input
                    type="password"
                    placeholder={t('adminTokenPlaceholder')}
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('adminTokenHint')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('instanceTokenLabel')}</Label>
                  <Input
                    type="password"
                    placeholder={t('instanceTokenPlaceholder')}
                    value={instanceToken}
                    onChange={(e) => setInstanceToken(e.target.value)}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              )}

              <Button onClick={handleCreateInstance} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? t('saving') : t('saveGenerate')}
              </Button>
            </CardContent>
          </Card>
        )}

        {phase === 'error' && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">{t('connProblem')}</AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">{errorMessage}</AlertDescription>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPhase('setup')}>
                    {t('reconfigure')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleReset}
                    disabled={resetting}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {resetting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                    {t('resetConfig')}
                  </Button>
                </div>
              </div>
            </div>
          </Alert>
        )}
      </div>
    </section>
  );
}
