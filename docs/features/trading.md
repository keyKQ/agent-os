# Wallets and Trading

AgentOS can hold EVM wallets of its own and swap tokens on **Base** and
**Robinhood Chain** through a pluggable swap provider: the **Uniswap Trading
API** (default, needs a free API key) or the **KyberSwap Aggregator**
(opt-in, no key). The engine owns everything:
the encrypted wallet vault, the ledger with cost basis and PnL, quote and
swap execution, and the guardrails that bound what an agent may do on its
own. The desktop app's Trading page, the `agentos wallet` / `agentos trade`
commands and the bundled `wallet-trading` skill are all clients of the same
gateway RPC surface (`wallet.*`, `trading.*`).

> Swaps move real money and cannot be undone. Start with small amounts, keep
> the daily cap low, and treat the vault directory like an SSH key.

## What it does

- **Wallets** — create new keys or import a private key / keystore JSON;
  export either form after re-entering the vault password; label, rename,
  remove; one wallet is *primary* and is the default for every command.
- **Balances and portfolio** — native ETH and every ERC-20 the ledger knows
  about, priced through DexScreener (CoinGecko as fallback), with cost
  basis, realized (FIFO) and unrealized PnL, 24h change, gas spent, and
  allocation. Per wallet and across all wallets.
- **History** — deposits, withdrawals, swaps (yours, the agent's, or
  external), approvals and gas, rebuilt from the chain itself: ERC-20
  `Transfer` logs plus native balance reconciliation. Robinhood Chain has no
  public indexer, so nothing here depends on one. A full resync drops and
  rebuilds the ledger.
- **Swaps** — quote, approve (a plain ERC-20 approval to the provider's
  spender: Uniswap's proxy or Kyber's router, no Permit2 signatures), sign
  and broadcast, then confirm from the receipt.
  A swap can target one wallet, several, or all of them as a batch; one
  wallet failing never blocks the others.
- **Agent trading** — the agent signs on its own within code-enforced limits
  (below). Orders above the per-order threshold wait for a human in the
  desktop app; the agent is told the outcome and decides what to do next.

## Chains

| Chain | Id | Explorer | Notes |
| --- | --- | --- | --- |
| Base | 8453 | basescan.org | Uniswap Universal Router 2.0 default |
| Robinhood Chain | 4663 | robinhoodchain.blockscout.com | Router 2.1.1 only; public RPC needs a `User-Agent` and has no archive data |

Only these two chains are enabled. Native ETH is `0x0000…0000` in the API.
A swap into native ETH on an L2 may deliver **WETH** instead; the order then
reports `deliveredToken` and the app offers a one-click unwrap
(`trading.unwrap`, a `withdraw(uint256)` on the WETH contract).

## Swap providers

| Provider | Key | Where it works | Notes |
| --- | --- | --- | --- |
| `uniswap` (default) | Uniswap Trading API key | everywhere | Universal Router; `x-agent-info` attribution on every call |
| `kyber` | none | geo-restricted: Kyber's edge answers HTTP 403 from some countries (Vietnam confirmed) | Aggregator routes + `route/build`; honeypot check refuses scam tokens, fee-on-transfer tokens produce a warning |

The provider is read from `trading.provider` on **every** call, so switching
takes effect immediately, no gateway restart. There is one canonical way to
change it: write the config key. The desktop does `config.patch
{trading: {provider: "kyber"}}`; the CLI does `agentos trade provider kyber`
(`config.set trading.provider`); `trading.setProvider {provider}` is a thin
RPC wrapper over the same `config.set` path. When Kyber is blocked, quotes
and swaps fail with error code `trading.provider_blocked` (non-fatal; the
order is marked `failed`, nothing is signed) and `trading.probe
{provider: "kyber"}` reports `blocked: true`. Switch back to Uniswap or use
a VPN.

Prices, balances and history never depend on the provider (DexScreener /
CoinGecko / your RPC node); only quoting and calldata do.

## Configuration

```toml
[trading]
enabled = true
provider = "uniswap"                 # or "kyber"
uniswap_api_key = ""                 # or set UNISWAP_API_KEY in the environment
uniswap_api_key_env = "UNISWAP_API_KEY"
kyber_client_id = "agentos"          # X-Client-Id sent to KyberSwap
approval_threshold_usd = 100.0       # agent orders above this wait for approval
daily_cap_usd = 1000.0               # per wallet, agent-initiated swaps only
approval_ttl_seconds = 900           # unanswered approvals expire
default_slippage_pct = 0.5           # omit to let Uniswap pick (auto slippage)
unlock_mode = "auto"                 # or "manual"
sync_interval_seconds = 30
price_ttl_seconds = 20

[trading.rpc_urls]
"8453" = "https://mainnet.base.org"  # optional overrides, by chain id or key
"4663" = "https://rpc.mainnet.chain.robinhood.com"
```

RPC resolution order per chain: `trading.rpc_urls`, then the environment
variables `RPC_BASE_URL` (8453) / `RPC_ROBINHOOD_URL` (4663), then the
public default. Every `[trading]` key is also an environment variable with
the `AGENTOS_TRADING_` prefix (`AGENTOS_TRADING_DAILY_CAP_USD=250`,
`AGENTOS_TRADING_PROVIDER=kyber`). The API key is redacted in
`config.snapshot` and every public config view like any other `*_api_key`.
Get a key from the Uniswap developer dashboard; the desktop's **Settings →
Trading** pane has a *Test key* button (`trading.probe`).

## Security model

- Keystores are standard Ethereum **keystore v3** JSON files under
  `~/.agentos/wallets/` (directory `0700`, files `0600`), all encrypted with
  one vault password. A random *verifier* keystore in `index.json` lets the
  engine check a password without touching any wallet key.
- **Unlock modes**, both OS-independent (no Keychain, no Electron store):
  - `auto` — the password sits in `~/.agentos/wallets/unlock.key` (`0600`)
    and the gateway unlocks at first use. This is what unattended agent
    missions need. Anyone who can read the directory can spend: same trust
    level as an SSH key without a passphrase.
  - `manual` — nothing on disk; unlock per gateway session from the app or
    `agentos wallet unlock`. Keys live only in the gateway's memory.
- Export (keystore or raw private key) and wallet removal always ask for
  the vault password, whatever the mode. Private keys never appear in logs,
  RPC responses (other than `wallet.export`), or the ledger.
- Before broadcasting, the engine checks balances, simulates the
  transaction with `eth_call`, validates the calldata Uniswap returned, and
  refuses anything that is not from the signing wallet.
- Token metadata from third-party APIs is data, not instructions: the skill
  tells the agent to ignore anything in a token name that reads like a
  command, and genuine Robinhood Stock Tokens are preferred over lookalikes
  that reuse the same ticker.

## Guardrails (code-enforced, agent-initiated swaps only)

| Rule | Default | Outcome when hit |
| --- | --- | --- |
| Per-order threshold | 100 USD | order parks as `awaiting_approval`; desktop notifies you |
| Daily cap per wallet | 1,000 USD (local calendar day) | order is `rejected` outright, not queued |
| Unpriced order | — | treated as above threshold (fails closed) |
| Approval TTL | 15 min | `expired`; agent is told |

Manual swaps from the app or CLI are your own decision: they never queue
and do not count toward the agent's cap. Approving an order re-quotes it;
if the market moved more than twice the slippage since you approved, it
goes back to the queue with a note instead of executing.

Every quote result and order carries `provider` (`uniswap` / `kyber`) and
`warnings` (Kyber fee-on-transfer notice, route output change).

Order statuses: `quoted → awaiting_approval | submitted → confirmed |
failed`, with `approved`, `rejected`, `expired` in between. Every change is
broadcast on the gateway WebSocket (`trading.changed`,
`trading.approval.requested`, `trading.order.finished`), so the desktop
never polls for it.

## How the agent uses it

The bundled `wallet-trading` skill drives the `agentos wallet` and
`agentos trade` commands with `--json`. Typical missions:

- "Swap 50 USDC to ETH on Base" — `agentos trade swap --chain base --in USDC --out ETH --amount 50 --json`, then `agentos trade order <id> --wait`.
- "DCA 20 USDC into AAPL every day" — a cron job running the swap; each
  run is a separate order under the same limits.
- "Buy WETH if it drops 5%" — quote/price checks on a schedule, swap when the
  condition holds, report the tx hash and explorer link.
- "Rebalance wallets A and B" — `--wallet A --wallet B` or
  `--all-wallets`; each wallet reports its own result.

Amounts are always human units (`0.5`, `1000`), never wei. See
[`../cli.md`](../cli.md) for the full command reference.

## Ledger and PnL

`~/.agentos/state/trading.sqlite` holds tokens, entries (history), FIFO
lots, realized PnL, orders, daily spend, sync cursors, balance cache and
price snapshots. Cost basis for a deposit is the token's USD price at that
block (CoinGecko range; spot price with `cost_basis_source = "approx"` when
history is unavailable). A holding's cost can be corrected by hand with
`trading.lot.setCost`. Selling consumes the oldest lots first; the
difference to proceeds is realized PnL. Gas is booked per entry and shown
separately in totals.

Charts come from GeckoTerminal on Base; on Robinhood Chain the engine
serves its own price snapshots (one per held token per sync).

## Related

- [`agentic-trading.md`](agentic-trading.md) — the Robinhood MCP and partner skills.
- [`../cli.md`](../cli.md) — `agentos wallet` / `agentos trade`.
- [`../approvals-and-permissions.md`](../approvals-and-permissions.md).
