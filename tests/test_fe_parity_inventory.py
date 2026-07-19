from scripts.fe_parity_inventory import (
    extract_routes,
    extract_rpc_methods,
    extract_storage_keys,
)


def test_extracts_rpc_methods_from_call_sites():
    js = """
    const r = await _rpc.call('doctor.status', { agentId: 'main' });
    rpc.call("sessions.list");
    this._rpc.call('cron.jobs.create', params)
    """
    assert extract_rpc_methods(js) == {
        "doctor.status",
        "sessions.list",
        "cron.jobs.create",
    }


def test_extracts_router_registrations():
    js = (
        "Router.register('/overview', f, d, { title: 'Overview' });\n"
        "Router.register('/health', f2);"
    )
    assert extract_routes(js) == {"/overview", "/health"}


def test_extracts_storage_keys():
    js = """
    localStorage.getItem('agentos-theme');
    const WS_URL_KEY = 'agentos.wsUrl';
    localStorage.setItem(WS_URL_KEY, url);
    sessionStorage.removeItem("agentos.draft");
    """
    # Direct string literals inside get/set/remove calls are captured;
    # constants are caught by the literal-assignment fallback pattern.
    assert "agentos-theme" in extract_storage_keys(js)
    assert "agentos.wsUrl" in extract_storage_keys(js)
    assert "agentos.draft" in extract_storage_keys(js)
