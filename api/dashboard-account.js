/**
 * Codeply Dashboard — Account & Billing (self-contained drop-in)
 * --------------------------------------------------------------
 * Adds real Supabase auth + Whop plan management to the dashboard
 * WITHOUT editing your existing HTML or dashboard.js.
 *
 * SETUP (3 steps):
 *   1. Put this file next to dashboard.js, then add ONE line to index.html,
 *      right AFTER  <script src="./dashboard.js"></script> :
 *          <script src="./dashboard-account.js"></script>
 *   2. Fill in the three CONFIG constants below.
 *   3. Add CORS to your /api/account and /api/create-checkout routes
 *      (see the included cors.js + patched route files).
 *
 * Notes:
 *   - Auth is email/password (works inside Electron). Google OAuth needs
 *     main-process deep-link handling, which is out of scope here.
 *   - It reuses the dashboard's global showToast() if present.
 *   - It coexists with the existing local "guest" login; this page is only
 *     for billing/plan. A user can still "Continue as guest" to use the tool.
 */
(function () {
  'use strict';

  // ─── CONFIG — fill these in ───────────────────────────────────────────────
  const SUPABASE_URL  = 'https://YOUR-PROJECT.supabase.co';  // Supabase → Settings → API → Project URL
  const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';            // the public "anon" key (safe to ship)
  const API_BASE      = 'https://codeply.online';            // where your Vercel /api routes are hosted
  // ──────────────────────────────────────────────────────────────────────────

  let sb = null;        // supabase client
  let session = null;   // current auth session
  let account = null;   // /api/account response

  const PLAN = { free: 'Free', starter: 'Starter', pro: 'Pro' };
  const $ = (id) => document.getElementById(id);
  const toast = (m, k) =>
    (typeof window.showToast === 'function' ? window.showToast(m, k || '') : console.log('[account]', m));

  // ─── 1. Styles (matches the dashboard's CSS variables) ──────────────────────
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      #page-account .acc-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
      #page-account .acc-badge { font-family: var(--mono); font-size: 0.62rem; padding: 2px 8px; border-radius: 6px; }
      #page-account .acc-badge.ok  { background: var(--green-dim); color: var(--green); }
      #page-account .acc-badge.off { background: rgba(255,255,255,0.06); color: var(--text2); }
      #page-account .acc-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
      #page-account .acc-plan-btn { flex: 1; min-width: 150px; height: 42px; border-radius: 10px; border: 1px solid var(--border2);
        background: var(--accent); color: #fff; font-family: var(--sans); font-weight: 700; font-size: 0.8rem; cursor: pointer; transition: all .2s; }
      #page-account .acc-plan-btn:hover:not(:disabled) { background: #0f5fe0; }
      #page-account .acc-plan-btn:disabled { background: rgba(255,255,255,0.05); color: var(--text2); border-color: var(--border); cursor: default; }
      #page-account .acc-plan-btn.ghost { background: transparent; color: var(--text2); }
      #page-account .acc-plan-btn.ghost:hover:not(:disabled) { background: rgba(255,255,255,0.04); color: var(--text); }
    `;
    document.head.appendChild(s);
  }

  // ─── 2. Nav item (Config section, above Settings) ───────────────────────────
  function injectNav() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const settingsItem = document.querySelector('.nav-item[data-page="settings"]');
    const item = document.createElement('div');
    item.className = 'nav-item';
    item.dataset.page = 'account';
    item.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
      ' Account <span class="nav-badge" id="accPlanBadge">Free</span>';
    if (settingsItem) nav.insertBefore(item, settingsItem);
    else nav.appendChild(item);
    // dashboard.js attached its nav handlers before we existed, so wire our own:
    item.addEventListener('click', showAccountPage);
  }

  function showAccountPage() {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === 'account'));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-account'));
  }

  // ─── 3. The Account page ─────────────────────────────────────────────────────
  function injectPage() {
    const main = document.querySelector('.main');
    if (!main) return;
    const page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-account';
    page.innerHTML = `
      <div class="page-header">
        <div class="page-title">Account</div>
        <div class="page-subtitle">Sign in, manage your plan, and billing</div>
      </div>

      <div id="accSignedOut">
        <div class="acc-card" style="max-width:420px">
          <div class="settings-card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            Sign in to Codeply
          </div>
          <div class="field"><label class="field-label">Email</label>
            <input id="accEmail" class="field-input" type="email" placeholder="you@example.com" autocomplete="username"></div>
          <div class="field"><label class="field-label">Password</label>
            <input id="accPass" class="field-input" type="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autocomplete="current-password"></div>
          <button class="save-settings-btn" id="accSignIn">Sign In</button>
          <button class="login-skip" id="accSignUp" style="margin-top:8px">Create account</button>
        </div>
      </div>

      <div id="accSignedIn" style="display:none">
        <div class="acc-card">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="user-avatar" id="accAvatar" style="width:44px;height:44px;border-radius:12px;font-size:1.1rem">?</div>
            <div style="flex:1;min-width:0">
              <div id="accUserEmail" style="font-size:0.9rem;font-weight:700;overflow:hidden;text-overflow:ellipsis">\u2014</div>
              <div style="font-size:0.72rem;color:var(--text2)">Signed in</div>
            </div>
            <button class="danger-btn" id="accSignOut" style="width:auto;padding:0 18px;margin-top:0">Sign Out</button>
          </div>
        </div>

        <div class="stats-grid" style="grid-template-columns:repeat(2,1fr)">
          <div class="stat-card">
            <div class="stat-label">Current Plan</div>
            <div class="stat-value blue" id="accPlanName">Free</div>
            <div class="stat-delta"><span class="acc-badge off" id="accPlanStatus">inactive</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Billing Period</div>
            <div class="stat-value" id="accPeriod" style="font-size:1rem">\u2014</div>
            <div class="stat-delta">Synced from Whop</div>
          </div>
        </div>

        <div class="acc-card">
          <div class="settings-card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            Change Plan
          </div>
          <div class="acc-row">
            <button class="acc-plan-btn ghost" data-plan="free">Free</button>
            <button class="acc-plan-btn" data-plan="starter">Upgrade to Starter</button>
            <button class="acc-plan-btn" data-plan="pro">Upgrade to Pro</button>
          </div>
          <div style="margin-top:10px;font-size:0.7rem;color:var(--text2)">Checkout opens in your browser. Your plan updates here automatically after payment.</div>
        </div>
      </div>`;
    main.appendChild(page);
  }

  // ─── Rendering ───────────────────────────────────────────────────────────────
  function setBadge(plan) { const b = $('accPlanBadge'); if (b) b.textContent = PLAN[plan] || plan; }

  function render() {
    const signedIn = !!session;
    if ($('accSignedOut')) $('accSignedOut').style.display = signedIn ? 'none' : '';
    if ($('accSignedIn'))  $('accSignedIn').style.display  = signedIn ? '' : 'none';
    if (!signedIn) { setBadge('free'); return; }

    const email = session.user && session.user.email ? session.user.email : '';
    if ($('accUserEmail')) $('accUserEmail').textContent = email || '\u2014';
    if ($('accAvatar')) $('accAvatar').textContent = (email[0] || '?').toUpperCase();

    const sub = (account && account.subscription) || { plan: 'free', status: 'inactive' };
    const plan = sub.status === 'active' ? sub.plan : 'free';

    if ($('accPlanName')) $('accPlanName').textContent = PLAN[plan] || plan;
    const st = $('accPlanStatus');
    if (st) { st.textContent = sub.status || 'inactive'; st.className = 'acc-badge ' + (sub.status === 'active' ? 'ok' : 'off'); }
    if ($('accPeriod')) $('accPeriod').textContent = sub.current_period_end
      ? 'Renews ' + new Date(sub.current_period_end).toLocaleDateString() : '\u2014';

    document.querySelectorAll('#page-account .acc-plan-btn').forEach((b) => {
      const isCurrent = b.dataset.plan === plan;
      b.disabled = isCurrent;
      b.textContent = isCurrent ? 'Current plan'
        : b.dataset.plan === 'free' ? 'Downgrade to Free' : 'Upgrade to ' + PLAN[b.dataset.plan];
    });

    setBadge(plan);
    document.querySelectorAll('.user-plan').forEach((el) => { el.textContent = (PLAN[plan] || plan) + ' Plan'; });
  }

  // ─── API helpers ─────────────────────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    return fetch(API_BASE + path, Object.assign({}, opts, { headers }));
  }

  async function loadAccount() {
    if (!session) { account = null; render(); return; }
    try {
      const res = await api('/api/account');
      account = res.ok ? await res.json() : null;
    } catch (_) { account = null; }
    render();
  }

  function openExternal(url) {
    if (window.codeply && typeof window.codeply.openExternal === 'function') window.codeply.openExternal(url);
    else window.open(url, '_blank');
  }

  // ─── Event wiring ────────────────────────────────────────────────────────────
  function wire() {
    const signIn = $('accSignIn');
    if (signIn) signIn.addEventListener('click', async () => {
      if (!sb) return toast('Auth still loading\u2026', 'error');
      const email = $('accEmail').value.trim(); const password = $('accPass').value;
      if (!email || !password) return toast('Enter email and password.', 'error');
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return toast(error.message, 'error');
      toast('Signed in \u2713', 'success');
    });

    const signUp = $('accSignUp');
    if (signUp) signUp.addEventListener('click', async () => {
      if (!sb) return toast('Auth still loading\u2026', 'error');
      const email = $('accEmail').value.trim(); const password = $('accPass').value;
      if (!email || password.length < 6) return toast('Use a valid email and a 6+ character password.', 'error');
      const { error } = await sb.auth.signUp({ email, password });
      if (error) return toast(error.message, 'error');
      toast('Account created \u2014 confirm via email if required, then sign in.', 'success');
    });

    const signOut = $('accSignOut');
    if (signOut) signOut.addEventListener('click', async () => {
      if (sb) await sb.auth.signOut();
      toast('Signed out');
    });

    document.querySelectorAll('#page-account .acc-plan-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const plan = btn.dataset.plan;
        if (plan === 'free') return toast('Cancel from your Whop account to return to Free.');
        if (!session) return toast('Sign in first.', 'error');
        try {
          const res = await api('/api/create-checkout', { method: 'POST', body: JSON.stringify({ plan }) });
          const d = await res.json();
          if (!res.ok) throw new Error(d.message || 'Checkout failed.');
          openExternal(d.checkoutUrl);
          toast('Opening checkout\u2026');
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    // Reflect upgrades quickly: refetch the plan when the app regains focus.
    window.addEventListener('focus', () => { if (session) loadAccount(); });
  }

  // ─── Supabase loader ─────────────────────────────────────────────────────────
  function loadSupabase() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const el = document.createElement('script');
      el.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Supabase library failed to load (CDN blocked?).'));
      document.head.appendChild(el);
    });
  }

  // ─── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    injectStyles();
    injectNav();
    injectPage();
    wire();

    if (SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1 || SUPABASE_ANON.indexOf('YOUR_') !== -1) {
      toast('Set SUPABASE_URL / anon key in dashboard-account.js', 'error');
      return;
    }
    try { await loadSupabase(); } catch (e) { toast(e.message, 'error'); return; }

    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    const { data } = await sb.auth.getSession();
    session = data.session;
    sb.auth.onAuthStateChange((_e, s) => { session = s; loadAccount(); });
    await loadAccount();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
