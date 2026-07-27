"""Allowlist of publishers that may carry brand identity on a skill card.

A ``SKILL.md`` is a plain text file that anyone can write and any hub can serve.
If the publisher block in its frontmatter were trusted verbatim, a third-party
skill could ship ``publisher: {id: robinhood, name: Robinhood}`` and inherit a
partner's name, link, and logo in the Skills UI — a phishing surface, not a
metadata feature.

So the frontmatter only *selects* a publisher; it never *describes* one. The
declared id is looked up in :data:`RECOGNIZED_PUBLISHERS`, and the allowlisted
record supplies every displayed field. An id that is not on the list resolves to
an empty publisher, which renders as an ordinary unbranded skill.
"""

from __future__ import annotations

from agentos.skills.types import SkillPublisher

#: Publishers allowed to appear as a brand. Keyed by the stable slug a skill
#: declares in ``publisher.id``. Names match the labels the Skills UI already
#: uses (``PARTNER_BRANDS`` in ``frontend/src/views/skills/SkillsPage.tsx``);
#: ``logo`` stays empty for partners whose mark the client ships as a bundled
#: asset, so no prompt or page has to fetch a remote image to render a card.
RECOGNIZED_PUBLISHERS: dict[str, SkillPublisher] = {
    "robinhood": SkillPublisher(
        id="robinhood",
        name="Robinhood",
        url="https://robinhood.com",
        logo="",
    ),
    "bankr": SkillPublisher(
        id="bankr",
        name="Bankr",
        url="https://github.com/BankrBot/skills",
        logo="",
    ),
}


def resolve_publisher(raw: object) -> SkillPublisher:
    """Return the allowlisted publisher a manifest selected, or an empty one.

    ``raw`` is whatever the frontmatter declared — a mapping, a bare id string,
    or junk. Only the ``id`` is read from it; name, url, and logo always come
    from :data:`RECOGNIZED_PUBLISHERS` so a skill cannot mint its own branding.
    """
    if isinstance(raw, SkillPublisher):
        declared_id = raw.id
    elif isinstance(raw, dict):
        declared_id = str(raw.get("id", "") or "")
    elif isinstance(raw, str):
        declared_id = raw
    else:
        return SkillPublisher()

    return RECOGNIZED_PUBLISHERS.get(declared_id.strip().lower(), SkillPublisher())
