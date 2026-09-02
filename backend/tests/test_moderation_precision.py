"""Regression tests for Forge Guardian false-positive safeguards."""

from app.prompts.moderation_prompt import SYSTEM_PROMPT, build_user_prompt
from app.services.groq_service import GroqModerationService
from app.schemas.moderation import ModerationAction


def test_keyword_only_fallback_never_returns_a_violation():
    result = GroqModerationService()._heuristic("Bro ye kya bakwas hai 😂")

    assert result.violation is False
    assert result.rule is None
    assert result.action is ModerationAction.NONE


def test_ambiguous_ai_verdict_is_downgraded_to_no_violation():
    result = GroqModerationService()._validate(
        {
            "violation": True,
            "rule": 1,
            "rule_title": "Be Respectful",
            "offending_message": "you are annoying",
            "confidence": 0.94,
            "reason": "Possibly disrespectful",
            "action": "warn",
        },
        original_content="you are annoying",
    )

    assert result.violation is False
    assert result.rule is None
    assert result.rule_title is None
    assert result.offending_message is None
    assert result.action is ModerationAction.NONE


def test_clear_high_confidence_rule_violation_is_preserved():
    result = GroqModerationService()._validate(
        {
            "violation": True,
            "rule": 1,
            "rule_title": "hallucinated title is ignored",
            "offending_message": "You are worthless and I will hurt you.",
            "confidence": 0.99,
            "reason": "Targeted threat and personal attack",
            "action": "warn",
        },
        original_content="You are worthless and I will hurt you.",
    )

    assert result.violation is True
    assert result.rule == 1
    assert result.rule_title == "Be Respectful"
    assert result.offending_message == "You are worthless and I will hurt you."
    assert result.action is ModerationAction.WARN


def test_prompt_requires_context_and_configured_rule():
    assert "DO NOT WARN" in SYSTEM_PROMPT
    assert "Never invent rules" in SYSTEM_PROMPT
    prompt = build_user_prompt("normal Hinglish baat hai", "friend: kya haal hai")
    assert "Conversation context" in prompt
    assert "normal Hinglish baat hai" in prompt
    assert "strictly against the Forge Protocol" in prompt


def test_normal_conversation_is_not_flagged_by_fallback():
    result = GroqModerationService()._heuristic("Hey, how are you doing today?")

    assert result.violation is False
    assert result.action is ModerationAction.NONE


def test_social_media_link_is_not_flagged_by_keyword_fallback():
    result = GroqModerationService()._heuristic("https://www.youtube.com/watch?v=example")

    assert result.violation is False
    assert result.action is ModerationAction.NONE


def test_custom_emoji_is_not_flagged_by_keyword_fallback():
    result = GroqModerationService()._heuristic("That was great <:party_blob:123456789012345678>")

    assert result.violation is False
    assert result.action is ModerationAction.NONE


def test_hinglish_and_mild_frustration_are_not_flagged_by_fallback():
    result = GroqModerationService()._heuristic("Yaar ye update thoda annoying hai, but koi baat nahi")

    assert result.violation is False
    assert result.action is ModerationAction.NONE


def test_malformed_or_low_confidence_verdict_cannot_warn():
    result = GroqModerationService()._validate(
        {"violation": True, "rule": 999, "confidence": "not-a-number", "action": "warn"},
        original_content="ambiguous message",
    )

    assert result.violation is False
    assert result.rule is None
    assert result.action is ModerationAction.NONE
    assert result.confidence == 0.0
