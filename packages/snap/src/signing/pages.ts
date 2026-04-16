// ─── Signing mini app HTML pages ─────────────────────────────────────────────
// Thin web pages opened via open_mini_app. Calldata is pre-encoded server-side
// and injected as JS constants — no client-side ABI encoding needed.
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 360px;
      background: #141414;
      border: 1px solid #272727;
      border-radius: 16px;
      padding: 24px;
    }
    h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; color: #fff; }
    .sub { font-size: 13px; color: #888; margin-bottom: 20px; }
    .btn {
      margin-top: 20px;
      width: 100%;
      padding: 14px;
      background: #16a34a;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn:not(:disabled):hover { opacity: 0.85; }
    .status {
      margin-top: 14px;
      font-size: 13px;
      text-align: center;
      min-height: 20px;
      color: #888;
    }
    .status.ok { color: #4ade80; }
    .status.err { color: #f87171; }
`;

const SHARED_PROVIDER_JS = `
async function getProvider() {
  try {
    const mod = await import('https://esm.sh/@farcaster/frame-sdk@latest');
    const sdk = mod.default ?? mod.sdk ?? mod;
    if (sdk?.actions?.ready) await sdk.actions.ready();
    const ethProvider = sdk?.wallet?.ethProvider;
    if (ethProvider) return ethProvider;
  } catch (_) { /* fall through */ }
  if (typeof window !== 'undefined' && window.ethereum) return window.ethereum;
  throw new Error('no wallet provider found. open this in farcaster');
}

const btn    = document.getElementById('btn');
const status = document.getElementById('status');

function setStatus(msg, type = '') {
  status.textContent = msg;
  status.className = 'status' + (type ? ' ' + type : '');
}
`;

export interface CommitPageParams {
  fid: number;
  description: string;
  durationDays: number;
  requiredProofs: number;
  tierName: string;
  amount: number;
  approveCalldata: string; // hex: approve(pool, amount)
  commitCalldata: string;  // hex: createCommitment(fid,tier,dur,proofs)
  tokenAddr: string;
  contractAddr: string;
  botApiUrl: string;
  snapApiSecret: string;
  tierIndex: number;
  pledgeAmount: number;
}

export interface ClaimPageParams {
  commitmentId: number;
  pledgeAmount: number;
  contractAddr: string;
  claimCalldata: string; // hex: claim(commitmentId)
}

// ─── Commit signing page ──────────────────────────────────────────────────────

export function buildCommitHtml(p: CommitPageParams): string {
  const desc = p.description.slice(0, 120).replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lock pledge — higher athletics</title>
  <style>${SHARED_STYLES}
    .row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #1f1f1f;
      font-size: 14px;
    }
    .row:last-of-type { border-bottom: none; }
    .row .label { color: #888; }
    .row .value { color: #e5e5e5; font-weight: 500; }
    .note { margin-top: 16px; font-size: 12px; color: #555; line-height: 1.5; }
  </style>
</head>
<body>
<div class="card">
  <h1>lock pledge</h1>
  <p class="sub">two transactions required</p>
  <div class="row"><span class="label">commitment</span><span class="value" style="max-width:200px;text-align:right;font-size:13px">${desc}</span></div>
  <div class="row"><span class="label">duration</span><span class="value">${p.durationDays} days</span></div>
  <div class="row"><span class="label">proofs required</span><span class="value">${p.requiredProofs}</span></div>
  <div class="row"><span class="label">pledge</span><span class="value">${p.amount.toLocaleString()} $HIGHER</span></div>
  <p class="note">step 1: approve $HIGHER spend<br>step 2: lock pledge onchain<br>your wallet will prompt twice.</p>
  <button class="btn" id="btn" onclick="run()">sign transactions</button>
  <div class="status" id="status"></div>
</div>
<script type="module">
const FID            = ${p.fid};
const APPROVE_DATA   = "${p.approveCalldata}";
const COMMIT_DATA    = "${p.commitCalldata}";
const TOKEN_ADDR     = "${p.tokenAddr}";
const CONTRACT_ADDR  = "${p.contractAddr}";
const DESCRIPTION    = "${desc}";
const DURATION_DAYS  = ${p.durationDays};
const REQUIRED_PROOFS = ${p.requiredProofs};
const TIER_INDEX     = ${p.tierIndex};
const TIER_NAME      = "${p.tierName}";
const PLEDGE_AMOUNT  = ${p.pledgeAmount};
const BOT_API_URL    = "${p.botApiUrl}";
const SNAP_SECRET    = "${p.snapApiSecret}";

${SHARED_PROVIDER_JS}

window.run = async function() {
  btn.disabled = true;
  setStatus('connecting wallet...');
  try {
    const provider = await getProvider();
    setStatus('getting wallet address...');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];
    if (!from) throw new Error('no account connected');

    if (BOT_API_URL) {
      setStatus('registering commitment...');
      const regRes = await fetch(BOT_API_URL + '/api/commitment/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-snap-secret': SNAP_SECRET },
        body: JSON.stringify({ fid: FID, walletAddress: from, description: DESCRIPTION,
          durationDays: DURATION_DAYS, requiredProofs: REQUIRED_PROOFS,
          tierName: TIER_NAME, tierIndex: TIER_INDEX, pledgeAmount: PLEDGE_AMOUNT }),
      });
      if (!regRes.ok) {
        const err = await regRes.text();
        if (!err.includes('already')) console.warn('register commitment:', err);
      }
    }

    setStatus('step 1/2 — approve $HIGHER (sign in wallet)...');
    const approveTx = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: TOKEN_ADDR, data: APPROVE_DATA }],
    });
    setStatus('approve submitted. waiting briefly...');
    await new Promise(r => setTimeout(r, 2000));

    setStatus('step 2/2 — lock pledge (sign in wallet)...');
    const commitTx = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: CONTRACT_ADDR, data: COMMIT_DATA }],
    });
    setStatus('✓ submitted. commitment activates when both txs confirm (~30s).', 'ok');
    btn.textContent = 'done';
    console.log('txs:', approveTx, commitTx);
  } catch (err) {
    const msg = err?.message ?? String(err);
    setStatus(msg.length > 80 ? msg.slice(0, 77) + '...' : msg, 'err');
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

// ─── Claim signing page ───────────────────────────────────────────────────────

export function buildClaimHtml(p: ClaimPageParams): string {
  const estimatedPayout = Math.round(p.pledgeAmount * 0.9);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>claim reward — higher athletics</title>
  <style>${SHARED_STYLES}
    h1 { font-size: 20px; color: #4ade80; }
    .amount { font-size: 32px; font-weight: 800; color: #fff; margin: 16px 0 4px; }
    .amount-label { font-size: 13px; color: #888; margin-bottom: 20px; }
    .note { font-size: 12px; color: #555; line-height: 1.5; margin-bottom: 20px; }
  </style>
</head>
<body>
<div class="card">
  <h1>✓ done.</h1>
  <p class="sub">commitment #${p.commitmentId} passed</p>
  <div class="amount">${estimatedPayout.toLocaleString()}</div>
  <p class="amount-label">$HIGHER (pledge − 10% fee + bonus)</p>
  <p class="note">one transaction to withdraw your reward to your wallet.</p>
  <button class="btn" id="btn" onclick="claim()">claim reward</button>
  <div class="status" id="status"></div>
</div>
<script type="module">
const CONTRACT_ADDR = "${p.contractAddr}";
const CLAIM_DATA    = "${p.claimCalldata}";

${SHARED_PROVIDER_JS}

window.claim = async function() {
  btn.disabled = true;
  setStatus('connecting wallet...');
  try {
    const provider = await getProvider();
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];
    if (!from) throw new Error('no account connected');

    setStatus('sign the transaction in your wallet...');
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: CONTRACT_ADDR, data: CLAIM_DATA }],
    });

    setStatus('✓ claim submitted. $HIGHER on the way.', 'ok');
    btn.textContent = 'claimed';
    console.log('claim tx:', txHash);
  } catch (err) {
    const msg = err?.message ?? String(err);
    setStatus(msg.length > 80 ? msg.slice(0, 77) + '...' : msg, 'err');
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}
