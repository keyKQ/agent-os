"""Per-model local embedding specs and Ollama default."""
from agentos.memory.embedding import (
    OllamaEmbeddingProvider,
    format_document_text,
    format_query_text,
    model_spec,
)


def test_gemma_spec_prefixes_and_pooling():
    spec = model_spec("google/embeddinggemma-300m")
    assert spec.pooling == "mean"
    assert spec.dims == 768
    assert format_query_text("google/embeddinggemma-300m", "hi") == (
        "task: search result | query: hi"
    )
    assert format_document_text("google/embeddinggemma-300m", "doc") == (
        "title: none | text: doc"
    )


def test_bge_spec_is_unchanged_behavior():
    spec = model_spec("BAAI/bge-small-zh-v1.5")
    assert spec.pooling == "cls"
    assert spec.max_tokens == 512
    assert format_query_text("BAAI/bge-small-zh-v1.5", "hi") == "hi"


def test_unknown_model_gets_no_prefix_default():
    assert format_query_text("some/other-model", "x") == "x"


def test_ollama_default_model_is_embeddinggemma():
    assert OllamaEmbeddingProvider.DEFAULT_MODEL == "embeddinggemma"


async def test_ollama_gemma_applies_prefixes(monkeypatch):
    provider = OllamaEmbeddingProvider(model="embeddinggemma")
    seen: list[str] = []

    async def fake_embed(text: str) -> list[float]:
        seen.append(text)
        return [0.0]

    monkeypatch.setattr(provider, "_embed_raw", fake_embed)
    await provider.embed_query("q")
    await provider.embed_batch(["d1", "d2"])
    assert seen[0] == "task: search result | query: q"
    assert seen[1] == "title: none | text: d1"


async def test_ollama_non_gemma_model_unprefixed(monkeypatch):
    provider = OllamaEmbeddingProvider(model="nomic-embed-text")
    seen: list[str] = []

    async def fake_embed(text: str) -> list[float]:
        seen.append(text)
        return [0.0]

    monkeypatch.setattr(provider, "_embed_raw", fake_embed)
    await provider.embed_query("q")
    assert seen == ["q"]
