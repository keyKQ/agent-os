"""Offline doubles for every network dependency of ``agentos.trading``.

One ``httpx.MockTransport`` routes by host: JSON-RPC nodes, the Uniswap
Trading API, DexScreener, CoinGecko and GeckoTerminal. Tests configure the
fakes and assert on what was requested.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs

import httpx

from agentos.trading.evm import (
    SEL_APPROVE,
    SEL_BALANCE_OF,
    SEL_DECIMALS,
    SEL_NAME,
    SEL_SYMBOL,
    TRANSFER_TOPIC,
    pad_address,
    pad_uint,
)
from agentos.trading.providers import PERMIT2

WALLET = "0x1111111111111111111111111111111111111111"
OTHER = "0x2222222222222222222222222222222222222222"
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
WETH = "0x4200000000000000000000000000000000000006"
AAPL = "0xaaaa000000000000000000000000000000000001"
ROUTER = "0x0000000085e102724e78ecd2f45dc9ca239affad"


def approve_calldata(spender: str, amount: int) -> str:
    """``approve(spender, amount)`` as the Trading API's check_approval returns it."""
    return SEL_APPROVE + pad_address(spender) + pad_uint(amount)


def _enc_uint(value: int) -> str:
    return "0x" + format(value, "x").rjust(64, "0")


def _enc_string(text: str) -> str:
    raw = text.encode()
    body = (
        (32).to_bytes(32, "big")
        + len(raw).to_bytes(32, "big")
        + raw.ljust((len(raw) + 31) // 32 * 32, b"\x00")
    )
    return "0x" + body.hex()


def transfer_log(
    *,
    tx_hash: str,
    log_index: int,
    block: int,
    token: str,
    sender: str,
    recipient: str,
    amount: int,
) -> dict[str, Any]:
    return {
        "address": token,
        "topics": [TRANSFER_TOPIC, "0x" + pad_address(sender), "0x" + pad_address(recipient)],
        "data": _enc_uint(amount),
        "blockNumber": hex(block),
        "transactionHash": tx_hash,
        "logIndex": hex(log_index),
    }


@dataclass
class FakeChain:
    chain_id: int
    block: int = 1_000
    native: dict[str, int] = field(default_factory=dict)
    erc20: dict[str, dict[str, int]] = field(default_factory=dict)
    tokens: dict[str, tuple[str, str, int]] = field(default_factory=dict)
    logs: list[dict[str, Any]] = field(default_factory=list)
    receipts: dict[str, dict[str, Any]] = field(default_factory=dict)
    nonces: dict[str, int] = field(default_factory=dict)
    sent: list[str] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    # Raise a JSON-RPC error for eth_getLogs spans wider than this (forces chunk halving).
    max_log_span: int | None = None
    on_send: Callable[[str], str] | None = None
    batch_supported: bool = True
    block_timestamps: dict[int, int] = field(default_factory=dict)
    fee_history: bool = True
    revert_calls: bool = False
    # Tokens whose ``balanceOf`` the node refuses (per-item batch failure).
    fail_balance_of: set[str] = field(default_factory=set)
    # JSON-RPC methods that fail outright (a node outage for that method).
    fail_methods: set[str] = field(default_factory=set)
    _seq: int = 0

    def set_native(self, address: str, wei: int) -> None:
        self.native[address.lower()] = wei

    def set_erc20(self, token: str, address: str, raw: int) -> None:
        self.erc20.setdefault(token.lower(), {})[address.lower()] = raw

    def get_erc20(self, token: str, address: str) -> int:
        return self.erc20.get(token.lower(), {}).get(address.lower(), 0)

    def add_transfer(
        self,
        *,
        token: str,
        sender: str,
        recipient: str,
        amount: int,
        block: int | None = None,
        tx_hash: str | None = None,
        log_index: int = 0,
    ) -> str:
        self._seq += 1
        tx_hash = tx_hash or ("0x" + format(self._seq, "x").rjust(64, "0"))
        block = block if block is not None else self.block
        self.logs.append(
            transfer_log(
                tx_hash=tx_hash,
                log_index=log_index,
                block=block,
                token=token.lower(),
                sender=sender.lower(),
                recipient=recipient.lower(),
                amount=amount,
            )
        )
        return tx_hash

    def _error(self, req_id: Any, message: str, code: int = -32000) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    def handle_one(self, req: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(req)
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or []
        try:
            result = self._dispatch(str(method), params)
        except _RpcFailError as exc:
            return self._error(req_id, str(exc), exc.code)
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def _dispatch(self, method: str, params: list[Any]) -> Any:
        if method in self.fail_methods:
            raise _RpcFailError("node unavailable", -32603)
        if method == "eth_chainId":
            return hex(self.chain_id)
        if method == "eth_blockNumber":
            return hex(self.block)
        if method == "eth_getBalance":
            return hex(self.native.get(str(params[0]).lower(), 0))
        if method == "eth_getBlockByNumber":
            number = int(str(params[0]), 16) if str(params[0]).startswith("0x") else self.block
            ts = self.block_timestamps.get(number, 1_700_000_000 + number * 2)
            return {"number": hex(number), "timestamp": hex(ts)}
        if method == "eth_call":
            return self._eth_call(params[0])
        if method == "eth_getLogs":
            return self._get_logs(params[0])
        if method == "eth_getTransactionCount":
            return hex(self.nonces.get(str(params[0]).lower(), 0))
        if method == "eth_estimateGas":
            if self.revert_calls:
                raise _RpcFailError("execution reverted")
            return hex(150_000)
        if method == "eth_feeHistory":
            if not self.fee_history:
                raise _RpcFailError("method not supported", -32601)
            return {"baseFeePerGas": [hex(10**8), hex(10**8)], "reward": [[hex(10**6)]]}
        if method == "eth_gasPrice":
            return hex(2 * 10**8)
        if method == "eth_sendRawTransaction":
            raw = str(params[0])
            self.sent.append(raw)
            if self.on_send is not None:
                return self.on_send(raw)
            self._seq += 1
            return "0x" + format(0xABC000 + self._seq, "x").rjust(64, "0")
        if method == "eth_getTransactionReceipt":
            return self.receipts.get(str(params[0]).lower())
        if method == "eth_getCode":
            # A node reports bytecode only where a contract actually is. The
            # fake has to as well, or nothing can test "not on this chain".
            address = str(params[0]).lower()
            known = address in self.tokens or address in self.erc20 or address in self.native
            return "0x6000" if known else "0x"
        raise _RpcFailError(f"unknown method {method}", -32601)

    def _eth_call(self, tx: dict[str, Any]) -> str:
        if self.revert_calls and tx.get("from"):
            raise _RpcFailError("execution reverted")
        to = str(tx.get("to") or "").lower()
        data = str(tx.get("data") or "")
        selector = data[:10]
        if selector == SEL_BALANCE_OF:
            if to in {t.lower() for t in self.fail_balance_of}:
                raise _RpcFailError("execution timeout", -32000)
            owner = "0x" + data[10:74][-40:]
            return _enc_uint(self.get_erc20(to, owner))
        meta = self.tokens.get(to)
        if selector == SEL_SYMBOL:
            return _enc_string(meta[0]) if meta else "0x"
        if selector == SEL_NAME:
            return _enc_string(meta[1]) if meta else "0x"
        if selector == SEL_DECIMALS:
            return _enc_uint(meta[2]) if meta else "0x"
        return "0x"

    def _get_logs(self, flt: dict[str, Any]) -> list[dict[str, Any]]:
        start = int(str(flt.get("fromBlock", "0x0")), 16)
        end = int(str(flt.get("toBlock", hex(self.block))), 16)
        if self.max_log_span is not None and end - start + 1 > self.max_log_span:
            raise _RpcFailError("query returned more than 10000 results", -32005)
        topics = flt.get("topics") or []
        out = []
        for log in self.logs:
            block = int(str(log["blockNumber"]), 16)
            if block < start or block > end:
                continue
            ok = True
            for index, wanted in enumerate(topics):
                if wanted is None:
                    continue
                actual = log["topics"][index] if index < len(log["topics"]) else None
                options = wanted if isinstance(wanted, list) else [wanted]
                if actual is None or actual.lower() not in [o.lower() for o in options]:
                    ok = False
                    break
            if ok:
                out.append(log)
        return out

    def handle(self, request: httpx.Request) -> httpx.Response:
        if not request.headers.get("user-agent", "").startswith("agentos-trading/"):
            return httpx.Response(403, text="forbidden")
        payload = json.loads(request.content or b"null")
        if isinstance(payload, list):
            if not self.batch_supported:
                return httpx.Response(200, json=self.handle_one(payload[0]))
            return httpx.Response(200, json=[self.handle_one(item) for item in payload])
        return httpx.Response(200, json=self.handle_one(payload))

    def receipt(
        self,
        tx_hash: str,
        *,
        status: int = 1,
        gas_used: int = 100_000,
        gas_price: int = 10**8,
        logs: list[dict[str, Any]] | None = None,
        block: int | None = None,
    ) -> dict[str, Any]:
        receipt = {
            "transactionHash": tx_hash,
            "status": hex(status),
            "gasUsed": hex(gas_used),
            "effectiveGasPrice": hex(gas_price),
            "blockNumber": hex(block if block is not None else self.block),
            "logs": logs or [],
        }
        self.receipts[tx_hash.lower()] = receipt
        return receipt


class _RpcFailError(Exception):
    def __init__(self, message: str, code: int = -32000) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class FakeUniswap:
    api_key: str = "test-key"
    amount_out: int = 500_000_000_000_000  # 0.0005 WETH for the default quote
    min_out: int | None = None
    approval_needed: bool = False
    approval_spender: str = PERMIT2
    permit_data: dict[str, Any] | None = None
    price_impact: float = 0.12
    gas_fee_usd: str = "0.05"
    routing: str = "CLASSIC"
    quote_error: tuple[int, dict[str, Any]] | None = None
    swap_error: tuple[int, dict[str, Any]] | None = None
    tx_to: str = ROUTER
    tx_value: str = "0"
    requests: list[httpx.Request] = field(default_factory=list)
    quotes: int = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("x-api-key") != self.api_key:
            return httpx.Response(401, json={"errorCode": "Unauthorized"})
        path = request.url.path.removeprefix("/v1")
        body = json.loads(request.content or b"{}") if request.content else {}
        if path == "/check_approval":
            approval = None
            if self.approval_needed:
                # What the Trading API really sends: approve(Permit2, amount).
                approval = {
                    "to": body["token"],
                    "from": body["walletAddress"],
                    "data": approve_calldata(self.approval_spender, int(body["amount"])),
                    "value": "0",
                    "chainId": body["chainId"],
                    "gasLimit": "60000",
                }
            return httpx.Response(
                200, json={"requestId": "r-appr", "approval": approval, "cancel": None}
            )
        if path == "/quote":
            self.quotes += 1
            if self.quote_error is not None:
                status, payload = self.quote_error
                return httpx.Response(status, json=payload)
            amount_out = self.amount_out
            min_out = self.min_out if self.min_out is not None else amount_out * 995 // 1000
            quote = {
                "chainId": body["tokenInChainId"],
                "swapper": body["swapper"],
                "input": {"amount": body["amount"], "token": body["tokenIn"]},
                "output": {
                    "amount": str(amount_out),
                    "token": body["tokenOut"],
                    "minimumAmount": str(min_out),
                    "recipient": body["swapper"],
                },
                "slippage": body.get("slippageTolerance", 0.5),
                "tradeType": "EXACT_INPUT",
                "gasFee": "5000000000000",
                "gasFeeUSD": self.gas_fee_usd,
                "priceImpact": self.price_impact,
                "quoteId": f"q-{self.quotes}",
                "blockNumber": "1000",
            }
            return httpx.Response(
                200,
                json={
                    "requestId": f"req-{self.quotes}",
                    "routing": self.routing,
                    "quote": quote,
                    "permitData": self.permit_data,
                },
            )
        if path == "/swap":
            if self.swap_error is not None:
                status, payload = self.swap_error
                return httpx.Response(status, json=payload)
            quote = body["quote"]
            return httpx.Response(
                200,
                json={
                    "requestId": "req-swap",
                    "swap": {
                        "to": self.tx_to,
                        "from": quote["swapper"],
                        "data": "0x3593564c" + "11" * 32,
                        "value": self.tx_value,
                        "chainId": quote["chainId"],
                        "gasLimit": "250000",
                        "maxFeePerGas": "200000000",
                        "maxPriorityFeePerGas": "1000000",
                    },
                },
            )
        if path == "/swaps":
            return httpx.Response(200, json={"swaps": [{"status": "SUCCESS"}]})
        return httpx.Response(404, json={"errorCode": "ResourceNotFound"})


@dataclass
class FakePrices:
    """DexScreener spot prices + CoinGecko lists/history + GeckoTerminal candles."""

    spot: dict[tuple[str, str], float] = field(default_factory=dict)  # (slug, token) -> usd
    lists: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # platform -> tokens
    history: dict[str, float] = field(default_factory=dict)  # token -> usd at any past ts
    candles: list[list[float]] = field(default_factory=list)
    requests: list[httpx.Request] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        host = request.url.host
        path = request.url.path
        if host == "api.dexscreener.com":
            if path.startswith("/tokens/v1/"):
                _, _, _, slug, addresses = path.split("/", 4)
                pairs = []
                for address in addresses.split(","):
                    price = self.spot.get((slug, address.lower()))
                    if price is None:
                        continue
                    pairs.append(self._pair(slug, address.lower(), price))
                return httpx.Response(200, json=pairs)
            if path == "/latest/dex/search":
                query = parse_qs(request.url.query.decode()).get("q", [""])[0].lower()
                pairs = [
                    self._pair(slug, token, price)
                    for (slug, token), price in self.spot.items()
                    if query in token
                ]
                return httpx.Response(200, json={"pairs": pairs})
        if host == "tokens.coingecko.com":
            platform = path.split("/")[1]
            return httpx.Response(200, json={"tokens": self.lists.get(platform, [])})
        if host == "api.coingecko.com":
            parts = path.split("/")
            token = parts[6].lower() if len(parts) > 6 else ""
            price = self.history.get(token)
            if price is None:
                return httpx.Response(404, json={"error": "not found"})
            query = parse_qs(request.url.query.decode())
            ts = int(query.get("from", ["0"])[0]) + 6 * 3600
            return httpx.Response(200, json={"prices": [[ts * 1000, price]]})
        if host == "api.geckoterminal.com":
            return httpx.Response(200, json={"data": {"attributes": {"ohlcv_list": self.candles}}})
        return httpx.Response(404)

    @staticmethod
    def _pair(slug: str, token: str, price: float) -> dict[str, Any]:
        return {
            "chainId": slug,
            "pairAddress": "0xpair" + token[-6:],
            "url": f"https://dexscreener.com/{slug}/0xpair",
            "baseToken": {"address": token, "symbol": "TKN", "name": "Token"},
            "quoteToken": {"symbol": "USDC", "name": "USD Coin"},
            "priceUsd": str(price),
            "priceNative": str(price / 2000),
            "marketCap": price * 1_000_000,
            "dexId": "uniswap",
            "labels": ["v4"],
            "priceChange": {"h24": 2.5},
            "liquidity": {"usd": 1_000_000},
            "volume": {"h24": 50_000},
            "info": {"imageUrl": "https://img/" + token},
        }


@dataclass
class FakeIndexer:
    """A Blockscout ``/api/v2/addresses/{addr}/token-balances`` endpoint."""

    # wallet (lower) -> [(token address, raw balance, token type)]
    holdings: dict[str, list[tuple[str, int, str]]] = field(default_factory=dict)
    status: int = 200
    requests: list[httpx.Request] = field(default_factory=list)

    def hold(self, wallet: str, token: str, raw: int, kind: str = "ERC-20") -> None:
        self.holdings.setdefault(wallet.lower(), []).append((token, raw, kind))

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, text="nope")
        parts = request.url.path.split("/")
        if len(parts) < 6 or parts[-1] != "token-balances":
            return httpx.Response(404, json={"message": "Not found"})
        rows = self.holdings.get(parts[-2].lower())
        if rows is None:
            return httpx.Response(404, json={"message": "Not found"})
        return httpx.Response(
            200,
            json=[
                {
                    "token": {"address": token, "type": kind, "symbol": "X", "decimals": "18"},
                    "value": str(raw),
                }
                for token, raw, kind in rows
            ],
        )


def make_transport(
    *,
    chains: dict[str, FakeChain],
    uniswap: FakeUniswap,
    prices: FakePrices,
    indexer: FakeIndexer | None = None,
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host in chains:
            return chains[host].handle(request)
        if host == "trade-api.gateway.uniswap.org":
            return uniswap.handle(request)
        if host.endswith("blockscout.com"):
            return indexer.handle(request) if indexer else httpx.Response(404)
        return prices.handle(request)

    return httpx.MockTransport(handler)


def fake_sign_tx(tx: dict[str, Any], key: bytes) -> str:
    """Encode the tx dict as the "raw" transaction so tests can inspect it."""
    return "0x" + json.dumps(tx, sort_keys=True).encode().hex()


def decode_fake_raw(raw: str) -> dict[str, Any]:
    return json.loads(bytes.fromhex(raw.removeprefix("0x")).decode())
