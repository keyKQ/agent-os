"""Curated MEMORY.md / USER.md system-prompt injection via frozen snapshot."""

from types import SimpleNamespace

from agentos.engine.runtime import TurnRunner
from agentos.memory.curated import ENTRY_DELIMITER


def _runner(tmp_path):
    return TurnRunner(
        provider_selector=None,
        config=SimpleNamespace(
            workspace_dir=str(tmp_path),
            memory=SimpleNamespace(source="workspace"),
            tools=SimpleNamespace(profile=None),
        ),
    )


def _prompt_text(assembled) -> str:
    if isinstance(assembled, tuple):
        return "\n\n".join(part for part in assembled if part)
    return assembled or ""


def test_curated_memory_block_with_usage_header_lands_in_prompt(tmp_path):
    (tmp_path / "AGENTS.md").write_text("agents\n", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text(
        f"User deploys with make deploy{ENTRY_DELIMITER}Prod region is us-east-1",
        encoding="utf-8",
    )
    runner = _runner(tmp_path)
    metadata: dict[str, object] = {}

    assembled = runner._assemble_prompt(
        "main", [], session_key="agent:main:auto", prompt_metadata=metadata
    )

    prompt = _prompt_text(assembled)
    assert "MEMORY (your personal notes)" in prompt
    assert "chars]" in prompt  # usage header
    assert "User deploys with make deploy" in prompt
    assert metadata["memory_md_present"] is True


def test_user_block_lands_when_user_md_has_entries(tmp_path):
    (tmp_path / "AGENTS.md").write_text("agents\n", encoding="utf-8")
    (tmp_path / "USER.md").write_text("Name is Ada", encoding="utf-8")
    runner = _runner(tmp_path)

    assembled = runner._assemble_prompt("main", [], session_key="agent:main:auto")

    prompt = _prompt_text(assembled)
    assert "USER PROFILE (who the user is)" in prompt
    assert "Name is Ada" in prompt
    # USER.md must appear exactly once (curated block only, not also the raw
    # workspace-files copy).
    assert prompt.count("Name is Ada") == 1


def test_migration_runs_before_first_load(tmp_path):
    (tmp_path / "AGENTS.md").write_text("agents\n", encoding="utf-8")
    # Free-form MEMORY.md (bullets, no §-delimiter) as written pre-curation.
    (tmp_path / "MEMORY.md").write_text(
        "# Notes\n\n- Prefers dark mode\n- Uses zsh", encoding="utf-8"
    )
    runner = _runner(tmp_path)

    assembled = runner._assemble_prompt("main", [], session_key="agent:main:auto")

    prompt = _prompt_text(assembled)
    assert "Prefers dark mode" in prompt
    assert "Uses zsh" in prompt
    # Migration rewrote the file into §-delimited entries.
    on_disk = (tmp_path / "MEMORY.md").read_text()
    assert "§" in on_disk
    assert on_disk.count("§") == 1  # two entries


def test_no_memory_files_yields_no_memory_block(tmp_path):
    (tmp_path / "AGENTS.md").write_text("agents\n", encoding="utf-8")
    runner = _runner(tmp_path)
    metadata: dict[str, object] = {}

    assembled = runner._assemble_prompt(
        "main", [], session_key="agent:main:auto", prompt_metadata=metadata
    )

    prompt = _prompt_text(assembled)
    assert "MEMORY (your personal notes)" not in prompt
    assert "USER PROFILE" not in prompt
    assert metadata["memory_md_present"] is False
